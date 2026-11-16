---
name: sentryone-sql-investigation
description: >
  Investigates SQL Server health, blocking, deadlocks, Top SQL, alert logs, and query
  performance via SentryOne (SolarWinds SQL Sentry) GraphQL API. Use this skill whenever
  the user mentions SQL Server slowness, a slow database, blocking chains, deadlocks,
  tempdb issues, Top SQL or query duration / CPU / logical reads breakdowns, alerts on
  a SQL instance, what's running on a server like AEPROD01SQL05, or any database
  performance investigation across monitored instances — even if they don't say
  "SentryOne" by name. Also use it to look up which tenant database lives on which
  SQL Server, identify a firm by its database name, or find every tenant on a given
  server: the skill ships with a bundled CSV mapping ~458 Eclipse tenants to firms
  and servers. Works for prod (TALTRADE.COM, EZESOFT.NET, SSCNYDIRECT.LOCAL), dev
  (AWSDEV.EZESOFTCLOUD.COM), and staging. Requires network access to
  s1portal.taltrade.com:9991 and an EZESOFT AD account.
license: Proprietary
metadata:
  author: "@kjatti"
  version: "2.1.0"
  tags: "sql-server,sentryone,solarwinds,monitoring,blocking,deadlocks,performance,database"
  scope-roles: "dev,qa"
  scope-products: "eclipse"
  scope-agents: "claude-code"
---

# SentryOne SQL Server Investigation

Queries the SolarWinds SQL Sentry portal to investigate SQL Server performance issues
across all monitored instances.

## Gotchas (read first)

- **Time zones are misleading.** The API accepts UTC inputs but returns timestamps
  with a `Z` suffix that are actually ET. Send `2026-05-11T18:00:00Z` (2 PM ET) and
  you'll get `lastBatch` values like `14:xx:xxZ` — those are 2 PM ET, not 2 PM UTC.
  Input as UTC, interpret returned times as ET.
- **`eventSourceConnectionId` is the integer `itemId`** — the number inside
  `connection-NNN`. Connection `connection-545` → `eventSourceConnectionId: 545`.
- **Root queries (`blocking`, `deadlocks`, `alertLogFilter`) take no arguments
  themselves** — the sub-fields do (e.g. `blocking.chain`, `alertLogFilter.getAlertLogByFilter`).
  Required-but-non-obvious input fields are catalogued in `references/schema.md`.
- **`programName` and `applicationName` carry the Kubernetes pod name** for
  microservice clients (e.g. `Ibor-PEProcessorSvc-peprocessor-service-57b84d4b4b-b8v29`).
  Strip the trailing `-<replicaset-hash>-<pod-id>` to map a SQL session back to
  a service. SQL Agent jobs appear as `SQLAgent - TSQL JobStep (Job 0x... : Step N)`.
- **`moRef` is a scalar** — query it directly, never sub-select fields from it.
- **`HealthOverview` exposes only `healthScore`** (Float) — there is no status field.

## Connection & auth

- **Portal**: `http://s1portal.taltrade.com:9991`
- **GraphQL**: `POST /api/graphql` with header `X-Tenant-ID: 6ab3ee5f-cd43-719e-2e48-b0376940eafc` (CHISNTRYONEDB01)
- **Auth**: NTLM with an EZESOFT AD account

Always prefer the bundled script — it handles NTLM + tenant ID + GraphQL error
reporting and covers every common operation. It reads:
- `SENTRYONE_USERNAME` (required) — your AD username
- `SENTRYONE_DOMAIN` (default `EZESOFT`)
- `SENTRYONE_PASSWORD` env var, or macOS keyring entry (service
  `eclipse-splunk-investigation`, key `SPLUNK_PASSWORD` — shared with the splunk
  skill so users only store the AD password once)

Dependencies: `requests`, `requests-ntlm`, `keyring`. For one-off GraphQL not
wrapped by a subcommand, use the script's raw passthrough:

```bash
python scripts/query_sentryone.py graphql '{ targets { name moRef } }'
```

## Eclipse Prod SQL Server Map

| Server | Tenants | Listener | itemId (connection) |
|--------|---------|----------|---------------------|
| AEPROD01SQL05 | 93 | EclipseProdL02.prod.ezesoftcloud.com | 545 |
| AEPROD01SQL06 | 92 | EclipseProdL03.prod.ezesoftcloud.com | 546 |
| AEPROD01SQL07 | 77 | EclipseProdL04.prod.ezesoftcloud.com | 547 |
| AEPROD01SQL08 | 76 | EclipseProdL05.prod.ezesoftcloud.com | 548 |
| AEPROD01SQL09 | 61 | EclipseProdL06.PROD.ezesoftcloud.com | 623 |
| AEPROD01SQL10 | 57 | EclipseProdL07.PROD.ezesoftcloud.com | 625 |
| AEPROD01SQL20 | 1 | AEPROD01SQL20.prod.ezesoftcloud.com | 690 |

The full tenant-to-database-to-server mapping ships at
`assets/eclipse-tenant-map.csv` (~458 rows; snapshot 2026-05-21). Columns:
`Firm_Id, Firm_Name, Database_Name, Auth_Domain, Auth_Token, Firm_Active,
Create_Date__UTC_, DB_Server_Name, ServerName`. `Auth_Token` is a friendly hash of
`Firm_Id`, not a credential — nothing here is sensitive.

```bash
python scripts/query_sentryone.py tenant-lookup --db Ims_10659_331C
python scripts/query_sentryone.py tenant-lookup --server AEPROD01SQL05 --count
python scripts/query_sentryone.py tenant-lookup --firm Periwinkle
```

The CSV is point-in-time. If a tenant or firm the user mentions isn't in it, the
snapshot is stale — re-export the Eclipse Configuration Report, replace the file,
and bump the snapshot date above.

## Query patterns

Default to the bundled script — every common operation has a subcommand:

```bash
python scripts/query_sentryone.py targets --unhealthy 80
python scripts/query_sentryone.py blocking         --target connection-545 --hours 2
python scripts/query_sentryone.py deadlocks        --target connection-545 --hours 24
python scripts/query_sentryone.py alerts           --search AEPROD01SQL05 --hours 6
python scripts/query_sentryone.py health-history   --object-id <guid> --hours 24
python scripts/query_sentryone.py topsql           --target connection-545 --dimension applications --hours 2
python scripts/query_sentryone.py topsql-statements --target connection-545 --hours 1 --sort cpu --app SecurityMaster-Core
python scripts/query_sentryone.py tenant-lookup    --db Ims_10659_331C
python scripts/query_sentryone.py introspect       --type BlockChainGroup
```

`alerts --search` is a substring match against `targetName` — pass a server name
to scope it. `topsql-statements --app <substring>` auto-expands to every pod
variant via `topSqlFilterDataList`. `introspect` is the live-schema escape hatch
when something isn't in `references/schema.md`.

The GraphQL examples below are for custom selection sets or composed queries —
use them with the script's `graphql` passthrough.

### List targets with health

```graphql
{ targets { name moRef objectId itemId isWatched healthOverview { healthScore } } }
```

### Blocking chains
```graphql
{
  blocking {
    chain(blockChainRequest: {
      eventSourceConnectionId: 545
      startDate: "2026-05-11T18:00:00Z"
      endDate: "2026-05-11T20:00:00Z"
      limit: 500
      offset: 0
    }) {
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
```

### Deadlocks
```graphql
{
  deadlocks {
    list(deadlocksRequest: {
      eventSourceConnectionId: 545
      startDate: "2026-05-11T18:00:00Z"
      endDate: "2026-05-11T20:00:00Z"
      limit: 50
      offset: 0
    }) {
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
```

Key fields on `DeadlockProcess`: `processId`, `sPID` (not `spid`), `clientApplication`
(not `clientApp`), `inputBufferText` (the SQL text), `waitResource`, `lockMode`.

### Alert log
```graphql
{
  alertLogFilter {
    getAlertLogByFilter(alertlogFilterRequest: {
      startDateTimeUtc: "2026-05-11T18:00:00Z"
      endDateTimeUtc: "2026-05-11T20:00:00Z"
      limit: 200
      offset: 0
      sortProperty: "startDateTimeUtc"
      sortIsDescending: false
      alertLogFilterOptions: {
        searchKey: "AEPROD01SQL05"
      }
    }) {
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
```

The `searchKey` in `alertLogFilterOptions` filters by target name substring.
The `message` field is the most informative — it contains SPIDs, SQL text,
blocking chain heads, job names, and duration info. See `references/schema.md`
for the catalog of common alert condition names.

### Health score history

```graphql
query HealthHistory($request: healthScoreHistoryRequest!) {
  healthScoreHistory(healthScoreHistoryRequest: $request) {
    objectId
    score
    timestampUtc
  }
}
```

Variables:
```json
{
  "request": {
    "objectId": "f8a579c0-bfbb-4a7f-a2f8-63624e66e326",
    "dateTimeRangeUtc": {
      "startDateTime": "2026-05-11T00:00:00Z",
      "endDateTime": "2026-05-11T23:59:00Z"
    }
  }
}
```

Note: health score of 0 with only 1 data point means the server is offline/unreachable
from SentryOne — not necessarily a database problem.

### Top SQL

Top SQL has two data paths: the **GraphQL metric** (`sqlserver.topsql.*`) gives
complete CPU/duration/reads aggregates and time series; the **REST trace
endpoint** (`/api/topSql/queryTraceEvents`) gives per-execution SQL text but
only for batches above the agent's ~3-second threshold. `references/topsql.md`
has the full comparison table, metric keys, request/response shapes, the
50K-char `textData` truncation caveat, and pod-name normalization rules —
read it before composing a custom Top SQL GraphQL or REST query.

```bash
# Aggregate top-N by dimension (GraphQL metrics)
python scripts/query_sentryone.py topsql --target connection-545 --dimension applications --hours 2

# Per-statement events with SQL text (REST trace)
python scripts/query_sentryone.py topsql-statements --target connection-545 --hours 1 --sort cpu
python scripts/query_sentryone.py topsql-statements --target connection-545 --hours 1 --app SecurityMaster-Core
```

To fan out across all 7 Eclipse prod servers, call the script per connection ID
(545, 546, 547, 548, 623, 625, 690) and merge.

## Team self-serve: "did my service's DB workload change?"

The default Top SQL views in the portal and via the bulk metric `instances()`
field are dominated by the noisiest services (PublisherSvc, PEProcessorSvc,
pto-rts on Eclipse prod). Quieter services — SecurityMaster, WebReporting,
audit-service, settings-service, Trading, Compliance, and most of the long
tail — almost never crack the top 10 on any server, so a naive "show me Top
SQL on SQL07" never surfaces their queries. **This is a visibility artifact
of the default view, not of what SentryOne has captured.** The data is
there; it just requires asking explicitly.

The recipe for any service owner asking about their own workload:

1. **Resolve every pod variant of the app.** Kubernetes registers each pod as
   a distinct `ApplicationName` (`<service>-<replicaset-hash>-<pod-id>`), so
   "SecurityMaster-Core" is actually 30–50 variants per server. Pull them from
   `topSqlFilterDataList.applicationNames` per server and substring-match.
2. **Pull CPU aggregate with explicit `instances:`.** `metric.aggregate()`
   accepts an `instances` argument — when present, it bypasses the top-10 cap
   and returns the requested apps' totals even if they're nowhere near the top
   of the server's leaderboard. Sum across pod variants and across servers.
3. **For per-statement detail, filter the REST endpoint to your app.** Set
   `ApplicationNames: [<all variants>]` in the `queryTraceEvents` body. This
   shifts the top-N competition from "the whole server" to "just your app" —
   your 3-second queries no longer have to out-rank PublisherSvc's
   45-second ones for a slot.

### Worked examples (verified on Eclipse prod)

```bash
# Per-statement Top SQL for SecurityMaster on one server, last 2 hours.
# The script auto-expands the substring via topSqlFilterDataList.
python scripts/query_sentryone.py topsql-statements \
    --target connection-547 --hours 2 --app SecurityMaster-Core --sort cpu
```

```python
# Week-over-week CPU comparison for a service across all 7 prod servers.
# Pattern: enumerate pod variants → aggregate(instances=[...]) per window.
for server_name, cid in SERVERS:
    catalog = graphql_query(
        f'{{ topSqlFilterDataList {{ applicationNames(eventSourceConnectionID: {cid}) }} }}'
    )
    my_pods = [a for a in catalog['topSqlFilterDataList']['applicationNames']
               if 'securitymaster-core' in a.lower()]
    rows = graphql_query(f'''{{
      target(moRef: "connection-{cid}") {{ ... on EventSourceConnection {{
        metric(key: "sqlserver.topsql.applications.cpu") {{
          aggregate(dateRange: {{ from: "{start}", to: "{end}" }},
                    instances: {json.dumps(my_pods)}) {{ instanceName value }}
        }}
      }} }}
    }}''')
    # sum rows[*].value → service's total CPU(ms) on this server
```

### Caveats this pattern does NOT escape

- **The ~3-second threshold still applies to the REST trace endpoint.** If
  your service runs many fast queries, the metric aggregate will show real
  CPU but `topsql-statements --app YourService` may return zero rows. That's a
  signal — death-by-many-fast-queries — not a tooling failure. Read CPU from
  the metric chart; you won't get per-statement text without lowering the
  threshold (which only the SentryOne admin can do).
- **Pod-name normalization matters for sums.** `--app SecurityMaster-Core`
  matches every pod-suffixed variant, but if you aggregate manually be sure
  to fold the variants together or you'll undercount.

## Investigation Workflow

### For a performance degradation report:

1. **Identify the target** — get the `itemId` (eventSourceConnectionId) and `objectId`
2. **Check alerts first** — use `alertLogFilter` with `searchKey` for the server name.
   This gives the fastest overview: what conditions fired, severity, and timing.
3. **Get Top SQL breakdown** — query `sqlserver.topsql.databases.duration` (aggregate)
   to find which databases consumed the most time, then drill into applications and
   time-series to pinpoint the spike. This replaces manually looking at the SSRS report.
   To see the **actual SQL text** of the worst offenders, use the REST endpoint —
   `python scripts/query_sentryone.py topsql-statements --target connection-545 --hours 1`.
   For a *specific service* (not a server-wide investigation), use the Team
   self-serve recipe above — default aggregates are top-10 capped per server and
   quieter services won't surface without an explicit `instances` / `--app` filter.
4. **Analyze blocking** — query `blocking.chain` for the time window. Aggregate by
   `databaseName` and `programName` to find the culprit service/database.
5. **Check deadlocks** — query `deadlocks.list`. The `inputBufferText` on processes
   shows the actual SQL being executed.
6. **Cross-reference tenant mapping** — run
   `python scripts/query_sentryone.py tenant-lookup --db <DatabaseName>` to identify
   which firm owns it (e.g., `Ims_10659_331C` = Periwinkle Trading LLC).

### For identifying what's on a server:

Use `tenant-lookup --server <ServerName>`. The CSV's `ServerName` column matches
SentryOne target names, and `Database_Name` is the tenant DB.

## Reference files

- `references/schema.md` — field catalogs (`Target`, `EventSourceConnection`,
  `BlockChainGroup`, `DeadlockProcess`, `AlertLogResponse`), input shapes for every
  request type, and the catalog of common alert condition names. Read this when you
  need a field name not in the examples above.
- `references/topsql.md` — full Top SQL reference: metric key catalog, GraphQL
  aggregate/time-series/instance patterns, REST `queryTraceEvents` body and response
  shapes, sampling-threshold and 50K-char truncation caveats, pod-name normalization.
- `references/introspection.md` — recipe for live schema introspection when
  something isn't documented anywhere in the skill.

## Trivia & survival notes

- `GET /account/UserInfo` (no `X-Tenant-ID` required) returns the tenant list and
  your role — useful when debugging auth.
- The SPA is currently `2026.1.1` on-prem Kestrel. If a query suddenly stops
  working after a portal upgrade, re-introspect with the recipe in
  `references/introspection.md`.
