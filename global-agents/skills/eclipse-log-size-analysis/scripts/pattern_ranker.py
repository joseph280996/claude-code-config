#!/usr/bin/env python3
"""
pattern_ranker.py — Rank log patterns by BYTES and attribute volume changes.

Two modes:

  RANK (default)   Which log patterns cost the most bytes right now?
  COMPARE          Which patterns caused a volume increase? (--compare-before)

Ranking is always by total bytes, never event count: a 200-byte line firing 10M
times costs more than a 5KB stack trace firing 1000 times.

Windows are deliberately small (default 120s) and shrink automatically on
timeout. When one pattern owns most of the volume, a 2-minute sample is ample.

Usage:
    # what costs the most, right now
    python3 pattern_ranker.py --sourcetype "kube:container:peprocessor-service"

    # attribute a step change: compare a pre-onset window to a post-onset one
    python3 pattern_ranker.py --sourcetype "kube:container:peprocessor-service" \
        --at "07/22/2026:10:00:00" --compare-before "07/16/2026:10:00:00"

    # unstructured logs (no Type/Method fields)
    python3 pattern_ranker.py --sourcetype my-app --group-by punct
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

from splunk_client import SplunkClient, SearchTimeout

MB = 1024 * 1024
# Field sets to try, most specific first. Discovery falls back down the list.
# Each strategy names the field whose COVERAGE decides whether it applies: a
# field that exists on 0.1% of events would rank 0.1% of the volume and produce
# a confidently wrong report, so existence is not enough.
GROUPING_STRATEGIES = {
    "dotnet": ["Type", "Method", "Level"],
    "aspnet": ["Class", "Name", "Level"],
    "layered": ["Layer", "Method", "Level"],
    "level-type": ["Level", "Type"],
    "logger": ["logger_name", "level"],
    "punct": ["punct"],
}
# Discovery order and the field that must be well-populated for each.
STRATEGY_PROBES = [
    ("dotnet", "Type"),
    ("aspnet", "Class"),
    ("layered", "Layer"),
    ("logger", "logger_name"),
    ("level-type", "Level"),
]
# Below this coverage a grouping field describes too little of the stream to
# rank by. Falls through to the next strategy, ultimately `punct`.
MIN_COVERAGE = 0.60


def parse_time(value: str) -> int:
    """Accept epoch, ISO, or Splunk MM/DD/YYYY:HH:MM:SS and return epoch seconds."""
    value = value.strip()
    if value.isdigit():
        return int(value)
    for fmt in ("%m/%d/%Y:%H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return int(datetime.strptime(value, fmt).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
    raise SystemExit(f"[error] Cannot parse time {value!r}. Use epoch, "
                     f"'YYYY-MM-DD HH:MM:SS', or 'MM/DD/YYYY:HH:MM:SS'.")


def discover_grouping(client: SplunkClient, index: str, sourcetype: str,
                      latest: int) -> tuple[str, list[str]]:
    """Pick a grouping key by measuring how much of the stream each field COVERS.

    Coverage, not existence. A field present on a handful of events yields a
    ranking that describes a sliver of the volume while looking authoritative.
    """
    probes = ", ".join(
        f'count(eval(isnotnull({field}))) as cov_{strategy}'
        for strategy, field in STRATEGY_PROBES)
    spl = (f'search index={index} sourcetype="{sourcetype}" '
           f'| stats count as n, {probes}')
    try:
        rows = client.search(spl, earliest=str(latest - 60), latest=str(latest), count=1)
    except SearchTimeout:
        return "punct", GROUPING_STRATEGIES["punct"]

    if not rows:
        return "punct", GROUPING_STRATEGIES["punct"]

    def num(key: str) -> float:
        try:
            return float(rows[0].get(key, 0) or 0)
        except (TypeError, ValueError):
            return 0.0

    total = num("n")
    if total <= 0:
        return "punct", GROUPING_STRATEGIES["punct"]

    for strategy, field in STRATEGY_PROBES:
        coverage = num(f"cov_{strategy}") / total
        if coverage >= MIN_COVERAGE:
            if coverage < 0.98:
                print(f"[warn] {field} covers only {coverage:.0%} of events; "
                      f"{1 - coverage:.0%} of the stream is unattributed.",
                      file=sys.stderr)
            return strategy, GROUPING_STRATEGIES[strategy]

    best = max(((s, num(f"cov_{s}") / total) for s, _ in STRATEGY_PROBES),
               key=lambda item: item[1])
    print(f"[warn] no grouping field covers >={MIN_COVERAGE:.0%} of events "
          f"(best: {best[0]} at {best[1]:.0%}). Falling back to punct — "
          f"patterns will be shapes, not names.", file=sys.stderr)
    return "punct", GROUPING_STRATEGIES["punct"]


def rank_spl(index: str, sourcetype: str, fields: list[str], limit: int,
             extra: str = "") -> str:
    quoted = [f'"{f}"' if "." in f else f for f in fields]
    by_clause = " ".join(quoted)
    # fillnull BEFORE stats: `stats ... by X` silently drops events where X is
    # null, so without this the ranking omits part of the volume it claims to
    # describe. Unattributed bytes show up as a "(unset)" row instead.
    return (f'search index={index} sourcetype="{sourcetype}" {extra}'
            f'| eval _bytes=len(_raw) '
            f'| fillnull value="(unset)" {by_clause} '
            f'| stats count as events, sum(_bytes) as total_bytes, '
            f'avg(_bytes) as avg_bytes by {by_clause} '
            f'| sort -total_bytes | head {limit}')


def level_spl(index: str, sourcetype: str) -> str:
    return (f'search index={index} sourcetype="{sourcetype}" '
            f'| eval _bytes=len(_raw) '
            f'| stats count as events, sum(_bytes) as total_bytes by Level '
            f'| sort -total_bytes')


def normalize(rows: list[dict], fields: list[str], window: int) -> list[dict]:
    out = []
    for row in rows:
        try:
            total = float(row.get("total_bytes", 0) or 0)
            events = int(float(row.get("events", 0) or 0))
        except (TypeError, ValueError):
            continue
        key = " | ".join(str(row.get(f, "") or "-") for f in fields)
        out.append({
            "key": key,
            "fields": {f: row.get(f, "") for f in fields},
            "events": events,
            "total_bytes": total,
            "mb": round(total / MB, 2),
            "avg_bytes": round(total / events) if events else 0,
            "gb_per_hour": round(total / MB / 1024 * (3600 / window), 3) if window else 0,
            # GB/day is the unit license_usage reports and the unit owners budget
            # in, so it is what the table shows.
            "gb_per_day": round(total / MB / 1024 * (86400 / window), 1) if window else 0,
            "events_per_sec": round(events / window, 1) if window else 0,
        })
    return out


def render_rank(patterns: list[dict], fields: list[str], window: int,
                strategy: str, levels: list[dict]) -> None:
    total_bytes = sum(p["total_bytes"] for p in patterns) or 1
    daily_gb = total_bytes / MB / 1024 * (86400 / window)

    print(f"\n{'=' * 78}")
    print(f"TOP LOG PATTERNS BY BYTES   (grouped by {'+'.join(fields)} "
          f"via '{strategy}' strategy)")
    print(f"sample window: {window}s   ->   extrapolated ~{daily_gb:,.0f} GB/day")
    print(f"{'=' * 78}")
    print(f"\n{'GB/day':>8} {'share':>7} {'events/s':>9} {'avg B':>7}  Pattern")
    print("-" * 78)
    for p in patterns:
        share = p["total_bytes"] / total_bytes * 100
        print(f"{p['gb_per_day']:>8.1f} {share:>6.1f}% {p['events_per_sec']:>9.1f} "
              f"{p['avg_bytes']:>7}  {shorten(p['key'])}")

    if patterns:
        top = patterns[0]
        top_share = top["total_bytes"] / total_bytes * 100
        print(f"\nConcentration: the top pattern is {top_share:.1f}% of sampled bytes.")
        if top_share > 50:
            print("  -> Volume is dominated by ONE pattern. Fix that one line first;")
            print("     everything below it is rounding error until it's addressed.")
        cumulative = 0.0
        for i, p in enumerate(patterns, 1):
            cumulative += p["total_bytes"] / total_bytes * 100
            if cumulative >= 80:
                print(f"  -> Top {i} pattern(s) account for {cumulative:.0f}% of bytes.")
                break

    if levels:
        print(f"\n{'Level':<12} {'events':>12} {'MB':>10} {'share':>8}")
        print("-" * 46)
        lvl_total = sum(float(l.get("total_bytes", 0) or 0) for l in levels) or 1
        warn_error = 0.0
        for l in levels:
            b = float(l.get("total_bytes", 0) or 0)
            name = l.get("Level", "-") or "-"
            if name.upper() in ("WARN", "WARNING", "ERROR", "FATAL"):
                warn_error += b
            print(f"{name:<12} {int(float(l.get('events', 0) or 0)):>12,} "
                  f"{b / MB:>10.1f} {b / lvl_total * 100:>7.1f}%")
        pct = warn_error / lvl_total * 100
        print()
        if pct > 40:
            print(f"  !! WARN/ERROR is {pct:.0f}% of bytes — that is NOT normal verbosity.")
            print("     A healthy service logs mostly INFO. Treat this as a regression:")
            print("     something is firing an error path in a loop. Use --compare-before.")
        else:
            print(f"  WARN/ERROR is {pct:.1f}% of bytes — normal. The cost is INFO verbosity.")


def shorten(key: str, width: int = 46) -> str:
    """Keep the DISCRIMINATING tail of a pattern key.

    .NET type names share long namespace prefixes, so truncating the head makes
    every row look identical. Drop namespace segments from the left instead.
    """
    if len(key) <= width:
        return key
    parts = [p.strip() for p in key.split("|")]
    # Collapse each dotted namespace to its last two segments.
    collapsed = []
    for part in parts:
        if part.count(".") >= 2:
            collapsed.append(".".join(part.split(".")[-2:]))
        else:
            collapsed.append(part)
    out = " | ".join(collapsed)
    return out if len(out) <= width else "..." + out[-(width - 3):]


def render_compare(before: list[dict], after: list[dict], win_b: int, win_a: int,
                   before_truncated: bool = False) -> None:
    """Show which patterns actually drove a change, by growth factor."""
    def rate(rows, window):
        return {r["key"]: r["total_bytes"] / window for r in rows}

    rb, ra = rate(before, win_b), rate(after, win_a)
    total_b, total_a = sum(rb.values()) or 1e-9, sum(ra.values()) or 1e-9
    delta_total = total_a - total_b

    print(f"\n{'=' * 78}")
    print("VOLUME ATTRIBUTION — before vs after")
    print(f"  before: {total_b * 3600 / MB / 1024:8.2f} GB/hr   ({win_b}s sample)")
    print(f"  after:  {total_a * 3600 / MB / 1024:8.2f} GB/hr   ({win_a}s sample)")
    print(f"  change: {(total_a / total_b):8.1f}x   "
          f"(+{delta_total * 3600 / MB / 1024:,.1f} GB/hr)")
    print(f"{'=' * 78}")

    rows = []
    for key in set(rb) | set(ra):
        b, a = rb.get(key, 0.0), ra.get(key, 0.0)
        # A pattern absent from the truncated 'before' top-N is NOT proven new —
        # it may simply have ranked below the cutoff. Only claim NEW when the
        # before-list was complete.
        unknown_before = (key not in rb) and before_truncated
        growth = (a / b) if b > 0 else (float("inf") if a > 0 else 0.0)
        rows.append({"key": key, "before_gbhr": b * 3600 / MB / 1024,
                     "after_gbhr": a * 3600 / MB / 1024, "growth": growth,
                     "unknown_before": unknown_before, "delta": a - b,
                     "share_of_delta": min((a - b) / delta_total * 100, 100.0)
                                       if delta_total > 0 else 0.0})
    rows.sort(key=lambda r: r["delta"], reverse=True)

    def growth_label(r: dict) -> str:
        if r["unknown_before"]:
            return "NEW?"
        if r["growth"] == float("inf"):
            return "NEW"
        return f"{r['growth']:.1f}x"

    print(f"\n{'before':>9} {'after':>9} {'growth':>8} {'%delta':>8}  Pattern")
    print("-" * 78)
    for r in rows[:15]:
        print(f"{r['before_gbhr']:>9.2f} {r['after_gbhr']:>9.2f} {growth_label(r):>8} "
              f"{r['share_of_delta']:>7.1f}%  {shorten(r['key'])}")

    if before_truncated and any(r["unknown_before"] for r in rows[:15]):
        print("\n  NEW? = absent from the 'before' top-N, which was truncated at --limit.")
        print("        It may be genuinely new, or just previously below the cutoff.")
        print("        Confirm with:  --filter '<the pattern>' --at '<before time>'")

    culprits = [r for r in rows if r["share_of_delta"] > 25]
    print()
    if culprits:
        lead = culprits[0]
        others = [r["growth"] for r in rows[1:10]
                  if r["growth"] not in (0.0, float("inf")) and r["before_gbhr"] > 0]
        typical = sum(others) / len(others) if others else 1.0
        print(f"VERDICT: {shorten(lead['key'], 60)}")
        print(f"  is {lead['share_of_delta']:.0f}% of the increase "
              f"({growth_label(lead)} growth, vs ~{typical:.1f}x for other patterns).")
        print()
        if lead["unknown_before"]:
            print("  This pattern dominates now but was below the cutoff before, so it either")
            print("  appeared new or amplified sharply. Either way the volume is concentrated")
            print("  in ONE log line — fix that line first.")
            print("  Determine which by re-running with a larger --limit, or by sampling the")
            print("  'before' window filtered to this pattern.")
        elif lead["growth"] == float("inf"):
            print("  This pattern did not exist before — a newly deployed log line.")
            print("  Check PRs merged shortly before the onset that touch this file.")
        elif typical > 0 and lead["growth"] / typical > 5:
            print("  One pattern grew far faster than the service as a whole:")
            print("  this is a CODE or DATA REGRESSION, not general verbosity.")
            print("  Look for logging inside a loop over a result set.")
        else:
            print("  Growth is concentrated here but not wildly out of line with the")
            print("  service overall — could be workload-driven. Confirm with request rates.")
        print("\n  Next: diagnose the mechanism —")
        print(f"    python3 sample_pattern.py --sourcetype \"<st>\" --type \"<Type>\"")
    else:
        print("VERDICT: no single dominant pattern; volume rose broadly.")
        print("  Likely cause: more traffic, more tenants, or more replicas —")
        print("  not a logging regression. Check pod count and request rate before")
        print("  asking the service team to change any log line.")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sourcetype", required=True)
    ap.add_argument("--index", default="main")
    ap.add_argument("--at", help="end of the sample window (default: now)")
    ap.add_argument("--window", type=int, default=120,
                    help="sample window in seconds (default 120; shrinks on timeout)")
    ap.add_argument("--compare-before", metavar="TIME",
                    help="also sample this earlier time and attribute the delta")
    ap.add_argument("--group-by", choices=sorted(GROUPING_STRATEGIES),
                    help="force a grouping strategy instead of auto-discovering")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--filter", default="", help="extra SPL filter, e.g. 'Level=WARN '")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    client = SplunkClient()
    latest = parse_time(args.at) if args.at else int(datetime.now(timezone.utc).timestamp())

    if args.group_by:
        strategy, fields = args.group_by, GROUPING_STRATEGIES[args.group_by]
    else:
        strategy, fields = discover_grouping(client, args.index, args.sourcetype, latest)
        print(f"[info] grouping by {'+'.join(fields)} ('{strategy}')", file=sys.stderr)

    extra = f"{args.filter.strip()} " if args.filter.strip() else ""
    spl = rank_spl(args.index, args.sourcetype, fields, args.limit, extra)

    try:
        rows, window = client.search_shrinking(spl, latest, args.window, count=args.limit)
    except SearchTimeout:
        print("[error] Even a 10s window timed out. This service is extremely loud, or\n"
              "  Splunk is under load. Try again, or add --filter to narrow the search.",
              file=sys.stderr)
        return 1

    patterns = normalize(rows, fields, window)
    if not patterns:
        print(f"[error] No events for sourcetype=\"{args.sourcetype}\" in index={args.index}.\n"
              f"  Check the sourcetype string and that the window has traffic.", file=sys.stderr)
        return 1

    if args.compare_before:
        before_latest = parse_time(args.compare_before)
        try:
            brows, bwindow = client.search_shrinking(spl, before_latest, window,
                                                     count=args.limit)
        except SearchTimeout:
            print("[error] The 'before' window timed out; try a smaller --window.",
                  file=sys.stderr)
            return 1
        before = normalize(brows, fields, bwindow)
        # If the before-list filled the limit, patterns missing from it may have
        # been cut off rather than absent.
        before_truncated = len(before) >= args.limit
        if args.json:
            print(json.dumps({"before": before, "after": patterns,
                              "before_window_s": bwindow, "after_window_s": window,
                              "before_truncated": before_truncated}, indent=2))
        else:
            render_compare(before, patterns, bwindow, window, before_truncated)
        return 0

    levels: list[dict] = []
    try:
        levels, _ = client.search_shrinking(level_spl(args.index, args.sourcetype),
                                            latest, min(window, 60), count=20)
    except SearchTimeout:
        pass

    if args.json:
        print(json.dumps({"sourcetype": args.sourcetype, "window_s": window,
                          "strategy": strategy, "patterns": patterns}, indent=2))
    else:
        render_rank(patterns, fields, window, strategy, levels)
        print(f"\nNext: inspect the top offender's actual log lines —")
        print(f'  python3 sample_pattern.py --sourcetype "{args.sourcetype}" \\')
        if patterns and "Type" in patterns[0]["fields"]:
            print(f'      --type "{patterns[0]["fields"].get("Type", "")}"')
        else:
            print(f'      --filter \'<field>="<value>"\'')
    return 0


if __name__ == "__main__":
    sys.exit(main())
