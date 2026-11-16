#!/usr/bin/env python3
"""Query SentryOne/SolarWinds SQL Sentry via its GraphQL API.

Authentication: NTLM using domain credentials.
- Username from SENTRYONE_USERNAME env var (required, no default)
- Domain from SENTRYONE_DOMAIN env var (default: EZESOFT)
- Password from SENTRYONE_PASSWORD env var, or macOS keyring
  (service: eclipse-splunk-investigation, key: SPLUNK_PASSWORD)

Usage examples:
    python query_sentryone.py targets --unhealthy 80
    python query_sentryone.py blocking   --target connection-545 --hours 2
    python query_sentryone.py deadlocks  --target connection-545 --hours 24
    python query_sentryone.py alerts     --search AEPROD01SQL05 --hours 6
    python query_sentryone.py topsql     --target connection-545 --dimension databases --hours 2
    python query_sentryone.py topsql-statements --target connection-545 --hours 1 --sort reads
    python query_sentryone.py topsql-statements --target connection-545 --hours 1 --app SecurityMaster-Core
    python query_sentryone.py tenant-lookup --db Ims_10659_331C
    python query_sentryone.py tenant-lookup --server AEPROD01SQL05
    python query_sentryone.py health-history --object-id <guid> --hours 24
    python query_sentryone.py graphql '{ targets { name moRef } }'
    python query_sentryone.py introspect --type Blocking
"""

import argparse
import csv
import json
import os
import pathlib
import sys
from datetime import datetime, timedelta, timezone

import requests
from requests_ntlm import HttpNtlmAuth


BASE_URL = "http://s1portal.taltrade.com:9991"
TENANT_ID = "6ab3ee5f-cd43-719e-2e48-b0376940eafc"

SKILL_DIR = pathlib.Path(__file__).resolve().parent.parent
TENANT_CSV = SKILL_DIR / "assets" / "eclipse-tenant-map.csv"


def get_password():
    pw = os.environ.get("SENTRYONE_PASSWORD")
    if pw:
        return pw
    try:
        import keyring
        pw = keyring.get_password("eclipse-splunk-investigation", "SPLUNK_PASSWORD")
        if pw:
            return pw
    except ImportError:
        pass
    print(
        "ERROR: No password found. Set SENTRYONE_PASSWORD or store it in keyring "
        "under service=eclipse-splunk-investigation, key=SPLUNK_PASSWORD.",
        file=sys.stderr,
    )
    sys.exit(1)


def get_auth():
    domain = os.environ.get("SENTRYONE_DOMAIN", "EZESOFT")
    username = os.environ.get("SENTRYONE_USERNAME")
    if not username:
        print(
            "ERROR: SENTRYONE_USERNAME is required. Set it to your AD username "
            "(e.g. export SENTRYONE_USERNAME=jdoe).",
            file=sys.stderr,
        )
        sys.exit(1)
    return HttpNtlmAuth(f"{domain}\\{username}", get_password())


def graphql_query(query, variables=None):
    headers = {"X-Tenant-ID": TENANT_ID, "Content-Type": "application/json"}
    payload = {"query": query}
    if variables:
        payload["variables"] = variables

    r = requests.post(
        f"{BASE_URL}/api/graphql",
        auth=get_auth(),
        json=payload,
        headers=headers,
        timeout=60,
    )
    r.raise_for_status()
    data = r.json()
    if "errors" in data:
        print(f"GraphQL Errors: {json.dumps(data['errors'], indent=2)}", file=sys.stderr)
        if data.get("data") is None:
            sys.exit(1)
    return data.get("data")


def time_window(hours):
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return start.strftime(fmt), end.strftime(fmt)


def rest_post(path, body):
    """POST to a non-GraphQL portal endpoint (e.g. /api/topSql/queryTraceEvents)."""
    headers = {"X-Tenant-ID": TENANT_ID, "Content-Type": "application/json"}
    r = requests.post(
        f"{BASE_URL}{path}",
        auth=get_auth(),
        json=body,
        headers=headers,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def _parse_duration_seconds(s):
    """Parse SentryOne's .NET TimeSpan string into float seconds.

    Formats observed: 'HH:MM:SS.fff' under a day, 'D.HH:MM:SS.fff' for batches
    that ran a day or longer (e.g. long-blocked DatabaseMail readers).
    """
    if not s:
        return 0.0
    # Always 2 colons: 'HH:MM:SS.fff' or 'D.HH:MM:SS.fff'. The dot before HH is the
    # day separator (only present for ≥1-day batches); the dot in SS.fff is decimal.
    parts = s.split(":")
    if len(parts) != 3:
        raise ValueError(f"Unexpected duration format: {s!r}")
    hours_part, m, sec_part = parts
    if "." in hours_part:
        d, h = hours_part.split(".", 1)
    else:
        d, h = "0", hours_part
    return int(d) * 86400 + int(h) * 3600 + int(m) * 60 + float(sec_part)


def cmd_targets(args):
    query = """
    {
      targets {
        name
        moRef
        objectId
        itemId
        isWatched
        healthOverview { healthScore }
      }
    }
    """
    data = graphql_query(query)
    targets = data["targets"]
    if args.unhealthy is not None:
        targets = [
            t for t in targets
            if (t.get("healthOverview") or {}).get("healthScore", 100) < args.unhealthy
        ]
    targets.sort(key=lambda t: (t.get("healthOverview") or {}).get("healthScore", 999))
    print(json.dumps(targets, indent=2))


def _connection_id_from_target(target):
    """Accept either 'connection-545' or '545' and return the int."""
    if target.startswith("connection-"):
        target = target.split("-", 1)[1]
    try:
        return int(target)
    except ValueError:
        print(
            f"ERROR: --target must be a connection moRef like 'connection-545' "
            f"or just the numeric itemId, got {target!r}.",
            file=sys.stderr,
        )
        sys.exit(1)


def cmd_blocking(args):
    cid = _connection_id_from_target(args.target)
    start, end = time_window(args.hours)
    query = """
    query Blocking($req: BlockChainRequest!) {
      blocking {
        chain(blockChainRequest: $req) {
          rowCount
          items {
            id
            databaseName
            hostName
            lastBatch
            loginName
            programName
            spid
          }
        }
      }
    }
    """
    variables = {
        "req": {
            "eventSourceConnectionId": cid,
            "startDate": start,
            "endDate": end,
            "limit": args.limit,
            "offset": 0,
        }
    }
    data = graphql_query(query, variables)
    print(json.dumps(data, indent=2))


def cmd_deadlocks(args):
    cid = _connection_id_from_target(args.target)
    start, end = time_window(args.hours)
    query = """
    query Deadlocks($req: DeadlockRequest!) {
      deadlocks {
        list(deadlocksRequest: $req) {
          rowCount
          items {
            id
            startTime
            deadlocks {
              victimsIds
              processes {
                processId
                sPID
                clientApplication
                hostName
                loginName
                databaseName
                waitResource
                waitTime
                lockMode
                transactionName
                inputBufferText
              }
            }
          }
        }
      }
    }
    """
    variables = {
        "req": {
            "eventSourceConnectionId": cid,
            "startDate": start,
            "endDate": end,
            "limit": args.limit,
            "offset": 0,
        }
    }
    data = graphql_query(query, variables)
    print(json.dumps(data, indent=2))


def cmd_alerts(args):
    start, end = time_window(args.hours)
    query = """
    query Alerts($req: AlertlogFilterRequest!) {
      alertLogFilter {
        getAlertLogByFilter(alertlogFilterRequest: $req) {
          rowCount
          items {
            alertID
            targetName
            objectName
            conditionName
            severity
            status
            startDateTimeUtc
            endDateTimeUtc
            duration
            durationInMilliseconds
            message
            conditionType
            conditionDescription
          }
        }
      }
    }
    """
    options = {}
    if args.search:
        options["searchKey"] = args.search
    variables = {
        "req": {
            "startDateTimeUtc": start,
            "endDateTimeUtc": end,
            "limit": args.limit,
            "offset": 0,
            "sortProperty": "startDateTimeUtc",
            "sortIsDescending": True,
            "alertLogFilterOptions": options,
        }
    }
    data = graphql_query(query, variables)
    print(json.dumps(data, indent=2))


def cmd_health_history(args):
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=args.hours)
    query = """
    query HealthHistory($req: healthScoreHistoryRequest!) {
      healthScoreHistory(healthScoreHistoryRequest: $req) {
        objectId
        score
        timestampUtc
      }
    }
    """
    variables = {
        "req": {
            "objectId": args.object_id,
            "dateTimeRangeUtc": {
                "startDateTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "endDateTime": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
        }
    }
    data = graphql_query(query, variables)
    print(json.dumps(data, indent=2))


def cmd_topsql(args):
    start, end = time_window(args.hours)
    measures = ["duration", "cpu", "logicalReads", "executions"]

    aliases = []
    for m in measures:
        metric_key = f"sqlserver.topsql.{args.dimension}.{m}"
        aliases.append(
            f'{m}: metric(key: "{metric_key}") {{\n'
            f'  aggregate(dateRange: {{ from: "{start}", to: "{end}" }}) {{\n'
            f'    instanceName\n'
            f'    value\n'
            f'  }}\n'
            f'}}'
        )

    query = (
        f'{{\n'
        f'  target(moRef: "{args.target}") {{\n'
        f'    ... on EventSourceConnection {{\n'
        f'      name\n'
        f'      ' + "\n      ".join(aliases) + "\n"
        f'    }}\n'
        f'  }}\n'
        f'}}'
    )

    data = graphql_query(query)
    if not data or not data.get("target"):
        print("No data returned", file=sys.stderr)
        sys.exit(1)

    target = data["target"]
    print(f"Server: {target.get('name')}")
    print(f"Window: {start} to {end} (UTC input; SentryOne returns ET in result times)")
    print(f"Dimension: {args.dimension}\n")

    for m in measures:
        agg = (target.get(m) or {}).get("aggregate") or []
        if not agg:
            continue
        print(f"--- Top by {m} ---")
        for entry in sorted(agg, key=lambda x: x["value"], reverse=True):
            print(f"  {entry['instanceName']:40s} {entry['value']:>14,.0f}")
        print()


def cmd_topsql_statements(args):
    """Per-statement Top SQL via the REST endpoint /api/topSql/queryTraceEvents.

    The GraphQL Top SQL metrics only give aggregates by dimension; this is the
    only way to get the actual SQL text of individual statements. The endpoint
    is undocumented — discovered by reverse-engineering the SPA's network calls.
    """
    cid = _connection_id_from_target(args.target)
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=args.hours)
    iso_ms = "%Y-%m-%dT%H:%M:%S.000Z"

    apps = []
    if args.app:
        # If exact, use as-is. Otherwise resolve to all matching app strings via filter list.
        if args.exact_app:
            apps = [args.app]
        else:
            filter_data = graphql_query(
                f'{{ topSqlFilterDataList {{ applicationNames(eventSourceConnectionID: {cid}) }} }}'
            )
            all_apps = (filter_data.get("topSqlFilterDataList") or {}).get("applicationNames") or []
            apps = [a for a in all_apps if args.app.lower() in (a or "").lower()]
            if not apps:
                print(f"No applications match {args.app!r} on connection {cid}", file=sys.stderr)
                sys.exit(1)

    body = {
        "EventSourceConnectionId": cid,
        "StartDate": start.strftime(iso_ms),
        "EndDate": end.strftime(iso_ms),
        "Limit": args.limit,
        "Offset": 0,
        "SortProperty": args.sort,
        "SortIsDescending": True,
        "EventClasses": [], "HostNames": [],
        "ApplicationNames": apps,
        "DatabaseNames": [args.database] if args.database else [],
        "LoginNames": [], "SPIDs": [], "Errors": [],
        "ParentTextMd5": "", "IsTraceStatement": False, "SearchKey": "",
    }

    data = rest_post("/api/topSql/queryTraceEvents", body)
    items = data.get("items") or []

    if args.json:
        print(json.dumps(items, indent=2, default=str))
        return

    print(f"# Top SQL statements — connection {cid} — last {args.hours}h — sort:{args.sort}")
    print(f"# Window: {start.strftime('%Y-%m-%dT%H:%M:%SZ')} to {end.strftime('%Y-%m-%dT%H:%M:%SZ')} UTC")
    print(f"# Returned: {len(items)} / total available: {data.get('rowCount')}")
    if apps:
        print(f"# Filtered to {len(apps)} app(s): {', '.join(apps[:5])}{'...' if len(apps)>5 else ''}")
    print()
    for i, r in enumerate(items, 1):
        dur_s = _parse_duration_seconds(r.get("duration"))
        text = " ".join((r.get("textData") or "").split())[:300]
        print(f"[{i}] db={r.get('databaseName')} app={r.get('applicationName')} "
              f"dur={dur_s:.2f}s cpu={r.get('cpu')}ms reads={r.get('reads'):,} "
              f"writes={r.get('writes'):,} spid={r.get('spid')}")
        print(f"    md5={r.get('normalizedTextMd5')} hasPlan={r.get('hasPlan')}")
        print(f"    {text}")
        print()


def _load_tenants():
    if not TENANT_CSV.exists():
        print(f"ERROR: tenant CSV not found at {TENANT_CSV}", file=sys.stderr)
        sys.exit(1)
    with open(TENANT_CSV, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def cmd_tenant_lookup(args):
    if not (args.db or args.firm or args.server):
        print("ERROR: pass at least one of --db, --firm, --server", file=sys.stderr)
        sys.exit(1)

    rows = _load_tenants()
    needle_db = (args.db or "").lower()
    needle_firm = (args.firm or "").lower()
    needle_server = (args.server or "").lower()

    matches = []
    for r in rows:
        if needle_db and needle_db not in (r.get("Database_Name") or "").lower():
            continue
        if needle_firm and needle_firm not in (r.get("Firm_Name") or "").lower():
            continue
        if needle_server and needle_server not in (r.get("ServerName") or "").lower():
            continue
        matches.append(r)

    if args.count:
        print(len(matches))
        return

    print(json.dumps(matches, indent=2))


def cmd_raw_graphql(args):
    data = graphql_query(args.query_string)
    print(json.dumps(data, indent=2))


def cmd_introspect(args):
    if args.type_name:
        query = f"""
        {{
          __type(name: "{args.type_name}") {{
            name
            kind
            fields {{
              name
              type {{ name kind ofType {{ name kind ofType {{ name }} }} }}
              args {{ name type {{ name kind ofType {{ name kind ofType {{ name }} }} }} }}
            }}
            inputFields {{
              name
              type {{ name kind ofType {{ name kind ofType {{ name }} }} }}
            }}
          }}
        }}
        """
    else:
        query = """
        {
          __schema {
            queryType {
              fields {
                name
                description
                args { name type { name kind ofType { name kind ofType { name } } } }
              }
            }
          }
        }
        """
    data = graphql_query(query)
    print(json.dumps(data, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Query SentryOne SQL Sentry")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("targets", help="List monitored targets")
    p.add_argument("--unhealthy", type=float, metavar="THRESHOLD",
                   help="Only show targets with health below this value")
    p.set_defaults(func=cmd_targets)

    p = sub.add_parser("blocking", help="Blocking chains for a target")
    p.add_argument("--target", required=True,
                   help="Target moRef (e.g. connection-545) or itemId (e.g. 545)")
    p.add_argument("--hours", type=int, default=2)
    p.add_argument("--limit", type=int, default=500)
    p.set_defaults(func=cmd_blocking)

    p = sub.add_parser("deadlocks", help="Deadlocks for a target")
    p.add_argument("--target", required=True,
                   help="Target moRef (e.g. connection-545) or itemId")
    p.add_argument("--hours", type=int, default=24)
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(func=cmd_deadlocks)

    p = sub.add_parser("alerts", help="Alert log within a time window")
    p.add_argument("--search", help="searchKey filter (typically a target name substring)")
    p.add_argument("--hours", type=int, default=6)
    p.add_argument("--limit", type=int, default=200)
    p.set_defaults(func=cmd_alerts)

    p = sub.add_parser("health-history", help="Health score history for an object")
    p.add_argument("--object-id", required=True, help="GUID objectId from `targets` query")
    p.add_argument("--hours", type=int, default=24)
    p.set_defaults(func=cmd_health_history)

    p = sub.add_parser("topsql", help="Top SQL aggregate by dimension")
    p.add_argument("--target", required=True, help="Target moRef (e.g. connection-545)")
    p.add_argument("--dimension", default="databases",
                   choices=["databases", "applications", "hosts", "logins"])
    p.add_argument("--hours", type=int, default=2)
    p.set_defaults(func=cmd_topsql)

    p = sub.add_parser("topsql-statements",
                       help="Per-statement Top SQL with SQL text (REST endpoint)")
    p.add_argument("--target", required=True,
                   help="Target moRef (e.g. connection-545) or itemId")
    p.add_argument("--hours", type=float, default=1.0)
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--sort", default="duration",
                   choices=["duration", "cpu", "reads", "writes", "startTime", "endTime"],
                   help="Server-side sort key (descending)")
    p.add_argument("--app",
                   help="Filter to applications matching this substring (e.g. 'SecurityMaster-Core'); "
                        "resolves to all matching app variants via topSqlFilterDataList")
    p.add_argument("--exact-app", action="store_true",
                   help="Treat --app as exact match (no expansion)")
    p.add_argument("--database", help="Filter to a single database name (exact)")
    p.add_argument("--json", action="store_true", help="Emit raw JSON instead of formatted")
    p.set_defaults(func=cmd_topsql_statements)

    p = sub.add_parser("tenant-lookup", help="Look up tenant DB / server / firm in bundled CSV")
    p.add_argument("--db", help="Database name (substring, case-insensitive)")
    p.add_argument("--firm", help="Firm name (substring)")
    p.add_argument("--server", help="ServerName (substring, e.g. AEPROD01SQL05)")
    p.add_argument("--count", action="store_true", help="Print only the match count")
    p.set_defaults(func=cmd_tenant_lookup)

    p = sub.add_parser("graphql", help="Execute a raw GraphQL query string")
    p.add_argument("query_string")
    p.set_defaults(func=cmd_raw_graphql)

    p = sub.add_parser("introspect", help="Introspect schema (root or named type)")
    p.add_argument("--type", dest="type_name",
                   help="Type name to introspect (omit for root query fields)")
    p.set_defaults(func=cmd_introspect)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)
    args.func(args)


if __name__ == "__main__":
    main()
