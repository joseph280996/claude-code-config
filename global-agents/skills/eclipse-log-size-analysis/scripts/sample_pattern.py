#!/usr/bin/env python3
"""
sample_pattern.py — Pull raw samples of one log pattern and diagnose WHY it's expensive.

Ranking tells you which pattern costs the most. This tells you what to change.

Detects:
  * per-row logging in a loop      (same correlation id, sequential entity ids)
  * envelope bloat                 (constant key=value pairs on every line)
  * intra-line redundancy          (same value repeated in envelope and message)
  * single-tenant concentration    (one firm/tenant dominates the volume)

Usage:
    python3 sample_pattern.py --sourcetype "kube:container:peprocessor-service" \
        --type "Eze.Eclipse.Accounting.PEProcessor.Domain.Managers.PositionLoadPerformanceManager"

    python3 sample_pattern.py --sourcetype my-app --filter 'Level=WARN' --at "07/22/2026:10:00:00"
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

from splunk_client import SplunkClient, SearchTimeout
from pattern_ranker import parse_time

KV = re.compile(r'(\w[\w.]*)=(?:"([^"]*)"|(\{.*?\})|(\S+))')
# Fields that identify a logical operation — repeated values here across many
# lines mean one operation is emitting many log entries.
CORRELATION_FIELDS = ("OperationId", "CorrelationId", "ActivityId", "RequestId",
                      "JobId", "TraceId", "trace_id")
TENANT_FIELDS = ("FirmName", "FirmId", "TenantId", "tenant", "CustomerId")
ENTITY_ID = re.compile(r'\[(\d{3,})\]|\b(?:Id|ID|id)[=:\s]+(\d{3,})')

# Fields whose NAME invites a wrong conclusion. A field's name is not its meaning;
# never report one of these as a secret without asking the owning team.
MISLEADING_NAMES = {
    "FirmAuthToken": ("NOT a secret — a 5-char tenant identifier users type at login. "
                      "Drop only for redundancy with FirmId, never as a 'credential leak'."),
}


def parse_kv(raw: str) -> dict[str, str]:
    out = {}
    for match in KV.finditer(raw):
        key = match.group(1)
        value = next((g for g in match.groups()[1:] if g is not None), "")
        if key not in out:
            out[key] = value
    return out


def analyze(events: list[dict]) -> dict:
    raws = [e.get("_raw", "") for e in events if e.get("_raw")]
    if not raws:
        return {}

    parsed = [parse_kv(r) for r in raws]
    sizes = sorted(len(r) for r in raws)
    avg = sum(sizes) / len(sizes)

    # Constant fields — same value on every sampled line.
    keys_everywhere = set(parsed[0])
    for p in parsed[1:]:
        keys_everywhere &= set(p)
    constant_raw = {k: parsed[0][k] for k in sorted(keys_everywhere)
                    if len({p.get(k) for p in parsed}) == 1 and parsed[0][k]}

    # A tight sample (one operation, one second) makes per-request and per-moment
    # fields look constant when they are not. Never recommend dropping these —
    # report them separately as "constant within this sample only".
    sample_scoped = set(CORRELATION_FIELDS) | {
        "Date", "date", "timestamp", "ts", "time", "ThreadId", "thread",
        "Level", "level", "Type", "Method", "File", "Line", "logger_name",
    } | set(TENANT_FIELDS)

    constant = {k: v for k, v in constant_raw.items() if k not in sample_scoped}
    incidental = {k: v for k, v in constant_raw.items() if k in sample_scoped}

    # Bytes spent on genuinely-constant fields (the defensible waste figure).
    constant_bytes = sum(len(f'{k}="{v}" ') for k, v in constant.items())

    # Correlation concentration: one operation emitting many lines.
    correlation = {}
    for field in CORRELATION_FIELDS:
        values = [p.get(field) for p in parsed if p.get(field)]
        if len(values) >= max(3, len(parsed) * 0.5):
            counts = Counter(values)
            top_value, top_count = counts.most_common(1)[0]
            correlation = {"field": field, "distinct": len(counts),
                           "samples": len(values), "top_count": top_count,
                           "lines_per_operation": round(len(values) / len(counts), 1)}
            break

    # Entity ids in the message — the signature of a per-row loop.
    entity_ids = []
    for raw in raws:
        message = raw.split("Message=", 1)[-1] if "Message=" in raw else raw
        for match in ENTITY_ID.finditer(message):
            value = match.group(1) or match.group(2)
            if value:
                entity_ids.append(int(value))
    sequential = False
    if len(entity_ids) >= 4:
        ordered = sorted(set(entity_ids))
        gaps = [b - a for a, b in zip(ordered, ordered[1:])]
        sequential = bool(gaps) and sum(1 for g in gaps if g <= 3) / len(gaps) > 0.5

    # Tenant concentration.
    tenants = {}
    for field in TENANT_FIELDS:
        values = [p.get(field) for p in parsed if p.get(field)]
        if len(values) >= max(3, len(parsed) * 0.5):
            counts = Counter(values)
            name, count = counts.most_common(1)[0]
            tenants = {"field": field, "top": name,
                       "share_pct": round(count / len(values) * 100, 1),
                       "distinct": len(counts)}
            break

    # Values duplicated within a single line (envelope + message).
    redundant = []
    sample = parsed[0]
    for key, value in sample.items():
        if not value or len(str(value)) < 8 or key == "Message":
            continue
        if raws[0].count(str(value)) > 1:
            redundant.append({"field": key, "occurrences": raws[0].count(str(value))})

    return {
        "sampled": len(raws),
        "avg_bytes": round(avg),
        "min_bytes": sizes[0],
        "max_bytes": sizes[-1],
        "constant_fields": constant,
        "incidental_fields": incidental,
        "constant_bytes": constant_bytes,
        "constant_pct": round(constant_bytes / avg * 100, 1) if avg else 0,
        "correlation": correlation,
        "sequential_entity_ids": sequential,
        "entity_id_count": len(set(entity_ids)),
        "tenants": tenants,
        "redundant_values": redundant[:6],
        "example": raws[0],
        "source_hint": {k: parsed[0].get(k) for k in ("File", "Line", "Type", "Method")
                        if parsed[0].get(k)},
    }


def render(a: dict) -> None:
    print(f"\n{'=' * 78}")
    print(f"PATTERN DIAGNOSIS   ({a['sampled']} events sampled)")
    print(f"{'=' * 78}")
    print(f"\nSize: avg {a['avg_bytes']} B  (min {a['min_bytes']}, max {a['max_bytes']})")

    if a.get("source_hint"):
        loc = a["source_hint"]
        where = f"{loc.get('File', '?')}:{loc.get('Line', '?')}"
        print(f"Source: {where}")
        if loc.get("Type"):
            print(f"        {loc['Type']}.{loc.get('Method', '')}")

    print("\n--- Findings " + "-" * 64)
    findings = []

    corr = a.get("correlation")
    if corr and corr["lines_per_operation"] >= 3:
        findings.append(
            f"PER-OPERATION AMPLIFICATION: {corr['lines_per_operation']} log lines per "
            f"distinct {corr['field']}\n"
            f"     ({corr['samples']} lines share only {corr['distinct']} operation ids).\n"
            f"     One logical operation is emitting many lines.")

    if a.get("sequential_entity_ids"):
        findings.append(
            f"PER-ROW LOOP: message contains {a['entity_id_count']} near-sequential entity ids.\n"
            f"     This log call is almost certainly inside a loop over a result set,\n"
            f"     so volume scales with dataset size. THIS IS THE HIGHEST-LEVERAGE FIX:\n"
            f"     replace N per-row lines with ONE summary line carrying a count and\n"
            f"     a few sample ids. Typically a >99% reduction with no loss of signal.")

    if a.get("constant_pct", 0) > 25:
        findings.append(
            f"ENVELOPE BLOAT: {a['constant_bytes']} B ({a['constant_pct']}%) of each line is\n"
            f"     fields that never vary across the sample — pure overhead.")

    if a.get("redundant_values"):
        fields = ", ".join(f"{r['field']} (x{r['occurrences']})" for r in a["redundant_values"])
        findings.append(f"INTRA-LINE REDUNDANCY: repeated values — {fields}")

    tenants = a.get("tenants")
    if tenants and tenants["share_pct"] > 60:
        findings.append(
            f"TENANT CONCENTRATION: {tenants['share_pct']}% of these lines are\n"
            f"     {tenants['field']}={tenants['top']} ({tenants['distinct']} distinct seen).\n"
            f"     Not systemic — a data condition in one tenant. Scope the fix there.")

    if findings:
        for i, text in enumerate(findings, 1):
            print(f"\n  {i}. {text}")
    else:
        print("\n  No structural pathology detected. This pattern is likely just")
        print("  high-frequency INFO logging — consider demoting or sampling it.")

    if a.get("constant_fields"):
        suffix = (f" — dc()-verified over {a['verified_events']:,} events"
                  if a.get("cardinality_checked") else " — sample only, unverified")
        print(f"\n--- Constant fields (candidates to drop){suffix} " + "-" * 8)
        for key, value in list(a["constant_fields"].items())[:14]:
            shown = value if len(value) <= 42 else value[:39] + "..."
            note = MISLEADING_NAMES.get(key, "")
            print(f"  {key:<18} = {shown}  ({len(f'{key}={value}')} B)")
            if note:
                print(f"  {'':<18}   ^ {note}")

    if a.get("low_cardinality_fields"):
        print(f"\n--- Looked constant, but VARY over the window " + "-" * 31)
        for key, distinct in sorted(a["low_cardinality_fields"].items(),
                                    key=lambda kv: kv[1])[:12]:
            print(f"  {key:<22} {distinct:>7,} distinct values")
        print("  Low cardinality is not constant. These carry real information;")
        print("  they are excluded from the bloat figure above. A per-batch id")
        print("  looks fixed in a 15-event sample and is not droppable.")

    if a.get("incidental_fields"):
        names = ", ".join(list(a["incidental_fields"])[:10])
        print(f"\n--- Constant in THIS SAMPLE only (do NOT drop) " + "-" * 30)
        print(f"  {names}")
        print("  These are per-request or per-moment fields. They look constant because")
        print("  the sample is narrow (often one operation in one second). They carry real")
        print("  information across the wider log stream — excluded from the bloat figure.")

    print(f"\n--- Sample event " + "-" * 60)
    example = a["example"]
    print(f"  {example[:1100]}{'...' if len(example) > 1100 else ''}")

    print(f"\n--- Recommended action " + "-" * 54)
    if a.get("sequential_entity_ids"):
        print("  1. AGGREGATE the per-row log into one summary line per operation:")
        print('       "StartValuation missing for 4,182 of 5,004 groups; samples: 1,2,3"')
        print("     Keeps the diagnostic value, drops ~99% of bytes.")
        print("  2. If aggregation can't ship now: rate-limit to the first N per operation,")
        print("     or demote to DEBUG and emit a counter metric instead.")
    elif corr and corr["lines_per_operation"] >= 3:
        print("  1. Reduce lines per operation — log once at completion, not per step.")
        print("  2. Demote intermediate steps to DEBUG.")
    else:
        print("  1. Demote to DEBUG if not actionable in production.")
        print("  2. Sample it (e.g. 1-in-10) if it's a success-path record.")
    if a.get("constant_pct", 0) > 25:
        print("  3. Move constant fields to host/pod metadata instead of every line.")
    print("\n  Verify semantics with the owning team before calling any field a secret;")
    print("  a field's NAME is not its meaning.")


def verify_constants(client, args, where: str, latest: int, window: int,
                     analysis: dict) -> None:
    """Re-check 'constant' fields with dc() over the whole window.

    A handful of raw events cannot distinguish a truly constant field from a
    low-cardinality one (a per-batch id looks constant in a 15-event sample).
    Claiming the latter is droppable overstates the saving, so ask Splunk.
    """
    fields = list(analysis.get("constant_fields") or {})
    if not fields:
        return
    aggs = ", ".join(f'dc({f}) as dc_{f}' for f in fields
                     if re.fullmatch(r"\w+", f))
    if not aggs:
        return
    spl = (f'search index={args.index} sourcetype="{args.sourcetype}"{where} '
           f'| stats count as n, {aggs}')
    try:
        rows = client.search(spl, earliest=str(latest - window),
                             latest=str(latest), count=1)
    except (SearchTimeout, Exception):
        analysis["cardinality_checked"] = False
        return

    if not rows:
        analysis["cardinality_checked"] = False
        return

    def num(key, default=0):
        try:
            return int(float(rows[0].get(key, default) or default))
        except (TypeError, ValueError):
            return default

    truly_constant, varying = {}, {}
    for field in fields:
        distinct = num(f"dc_{field}", -1)
        if distinct == 1:
            truly_constant[field] = analysis["constant_fields"][field]
        elif distinct > 1:
            varying[field] = distinct

    analysis["cardinality_checked"] = True
    analysis["verified_events"] = num("n")
    analysis["constant_fields"] = truly_constant
    analysis["low_cardinality_fields"] = varying
    # Recompute the bloat figure from only the verified-constant fields.
    verified_bytes = sum(len(f'{k}="{v}" ') for k, v in truly_constant.items())
    avg = analysis.get("avg_bytes") or 0
    analysis["constant_bytes"] = verified_bytes
    analysis["constant_pct"] = round(verified_bytes / avg * 100, 1) if avg else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sourcetype", required=True)
    ap.add_argument("--index", default="main")
    ap.add_argument("--type", help="exact Type field value to isolate")
    ap.add_argument("--filter", default="", help="raw SPL filter, e.g. 'Level=WARN'")
    ap.add_argument("--at", help="end of sample window (default now)")
    ap.add_argument("--window", type=int, default=60)
    ap.add_argument("--count", type=int, default=25)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    clauses = []
    if args.type:
        clauses.append(f'Type="{args.type}"')
    if args.filter.strip():
        clauses.append(args.filter.strip())
    where = (" " + " ".join(clauses)) if clauses else ""

    client = SplunkClient()
    latest = parse_time(args.at) if args.at else int(datetime.now(timezone.utc).timestamp())
    spl = (f'search index={args.index} sourcetype="{args.sourcetype}"{where} '
           f'| head {args.count} | table _raw')

    try:
        rows, window = client.search_shrinking(spl, latest, args.window, count=args.count)
    except SearchTimeout:
        print("[error] Sampling timed out. Narrow with --type or --filter.", file=sys.stderr)
        return 1

    if not rows:
        print(f"[error] No events matched. Check --type / --filter spelling and the window.",
              file=sys.stderr)
        return 1

    analysis = analyze(rows)
    if not analysis:
        print("[error] Events returned but no _raw content to analyze.", file=sys.stderr)
        return 1

    verify_constants(client, args, where, latest, window, analysis)

    if args.json:
        print(json.dumps(analysis, indent=2))
    else:
        render(analysis)
    return 0


if __name__ == "__main__":
    sys.exit(main())
