#!/usr/bin/env python3
"""
volume_trend.py — Cheap ingest-volume trend and automatic onset detection.

Reads Splunk's own license_usage.log (metadata only, pre-aggregated), so it is
safe over 30-60 days where raw-event scans would time out.

Answers two questions:
  1. Is this service's volume flat, ramping, or step-changed?
  2. If step-changed, WHEN did it start (to the hour)?

Usage:
    # 45-day daily trend + verdict
    python3 volume_trend.py --sourcetype "kube:container:peprocessor-service"

    # zoom to hourly around a detected onset
    python3 volume_trend.py --sourcetype "kube:container:peprocessor-service" \
        --hourly --earliest "07/19/2026:00:00:00" --latest "07/21/2026:12:00:00"

    # list the loudest sourcetypes overall (no --sourcetype needed)
    python3 volume_trend.py --top-sourcetypes --days 7
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from datetime import datetime, timezone

from splunk_client import SplunkClient, SearchTimeout

GB = 1024 ** 3
# Weekend/holiday troughs are normal for batch-driven services; a day below this
# fraction of the median is treated as idle and excluded from baseline stats.
IDLE_FRACTION = 0.35
STEP_RATIO = 2.5      # sustained increase over baseline that counts as a step change
SUSTAIN_DAYS = 2      # consecutive elevated days required to rule out a one-off spike


def daily_spl(sourcetype: str) -> str:
    return (f'search index=_internal source=*license_usage.log type="Usage" '
            f'st="{sourcetype}" | timechart span=1d sum(b) as bytes')


def hourly_spl(sourcetype: str) -> str:
    return (f'search index=_internal source=*license_usage.log type="Usage" '
            f'st="{sourcetype}" | timechart span=1h sum(b) as bytes')


def top_sourcetypes_spl(limit: int) -> str:
    return ('search index=_internal source=*license_usage.log type="Usage" '
            '| stats sum(b) as bytes by st '
            f'| sort -bytes | head {limit}')


def normalize_bound(value: str) -> str:
    """Convert an absolute time bound to epoch; leave relative bounds alone.

    Splunk's REST API accepts epoch and ISO but NOT the MM/DD/YYYY:HH:MM:SS
    format its own UI and search bar use — it returns "Invalid earliest_time".
    """
    value = (value or "").strip()
    if not value or value == "now" or value.startswith(("-", "+", "@")):
        return value
    if value.isdigit():
        return value
    for fmt in ("%m/%d/%Y:%H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(value, fmt).replace(tzinfo=timezone.utc)
            return str(int(parsed.timestamp()))
        except ValueError:
            continue
    return value  # let Splunk decide; it may be a relative form we don't know


def parse_series(rows: list[dict]) -> list[tuple[str, float]]:
    series = []
    for row in rows:
        raw = row.get("bytes")
        if raw in (None, ""):
            continue
        try:
            series.append((row.get("_time", ""), float(raw) / GB))
        except (TypeError, ValueError):
            continue
    return series


def detect_onset(series: list[tuple[str, float]]) -> dict:
    """Classify the shape of a volume series and locate a step change if present."""
    active = [gb for _, gb in series if gb > 0]
    if len(active) < 6:
        return {"verdict": "insufficient-data",
                "detail": f"only {len(active)} non-zero buckets; widen the window"}

    median_all = statistics.median(active)
    busy = [gb for gb in active if gb >= median_all * IDLE_FRACTION]
    baseline = statistics.median(busy) if busy else median_all

    # Scan for the earliest point where volume stays elevated for SUSTAIN_DAYS+.
    threshold = baseline * STEP_RATIO
    onset_index = None
    for i in range(len(series) - SUSTAIN_DAYS):
        window = [gb for _, gb in series[i:i + SUSTAIN_DAYS + 1]]
        if all(gb >= threshold for gb in window):
            onset_index = i
            break

    peak_time, peak = max(series, key=lambda item: item[1])

    if onset_index is None:
        first_half = [gb for _, gb in series[: len(series) // 2] if gb > 0]
        second_half = [gb for _, gb in series[len(series) // 2:] if gb > 0]
        ramp = (statistics.median(second_half) / statistics.median(first_half)
                if first_half and second_half else 1.0)
        if ramp >= 1.5:
            verdict, detail = "ramp", (
                f"no step change, but volume grew {ramp:.1f}x between the first and "
                f"second half of the window — suspect tenant/dataset growth")
        else:
            verdict, detail = "stable", (
                f"no step change detected; typical active-period volume is "
                f"{baseline:.1f} GB with a peak of {peak:.1f} GB")
        return {"verdict": verdict, "detail": detail,
                "baseline_gb": round(baseline, 2), "peak_gb": round(peak, 2),
                "peak_at": peak_time}

    onset_time, onset_value = series[onset_index]
    elevated = [gb for _, gb in series[onset_index:] if gb > baseline * IDLE_FRACTION]
    plateau = statistics.median(elevated) if elevated else onset_value
    return {
        "verdict": "step-change",
        "detail": (f"volume stepped from ~{baseline:.1f} GB to ~{plateau:.1f} GB "
                   f"({plateau / baseline:.1f}x) starting {onset_time}"),
        "onset_at": onset_time,
        "baseline_gb": round(baseline, 2),
        "plateau_gb": round(plateau, 2),
        "growth_factor": round(plateau / baseline, 1) if baseline else None,
        "peak_gb": round(peak, 2),
        "peak_at": peak_time,
    }


def render(series: list[tuple[str, float]], analysis: dict, hourly: bool) -> None:
    unit = "hour" if hourly else "day"
    peak = max((gb for _, gb in series), default=0.0) or 1.0
    print(f"\n{'Bucket':<22} {'GB':>9}  Volume")
    print("-" * 62)
    onset = analysis.get("onset_at")
    for stamp, gb in series:
        bar = "#" * max(0, min(28, round(gb / peak * 28)))
        marker = "  <-- onset" if stamp == onset else ""
        label = stamp[:16].replace("T", " ")
        print(f"{label:<22} {gb:>9.2f}  {bar}{marker}")

    print(f"\nVerdict: {analysis['verdict'].upper()}")
    print(f"  {analysis['detail']}")

    if analysis["verdict"] == "step-change":
        st = analysis.get("_sourcetype", "<st>")
        onset_iso = (analysis.get("onset_at") or "")[:10]        # YYYY-MM-DD
        try:
            day = datetime.strptime(onset_iso, "%Y-%m-%d")
        except ValueError:
            day = None

        if hourly:
            print("\nOnset is now pinned to the hour. Attribute the delta to log patterns:")
            print(f'  python3 pattern_ranker.py --sourcetype "{st}" --index main \\')
            print(f'      --at "<an hour AFTER onset>" --compare-before "<an hour BEFORE onset>"')
            return

        if day:
            splunk_day = day.strftime("%m/%d/%Y")
            print(f"\nNext step — pin the onset to the hour (day before + onset day):")
            print(f'  python3 volume_trend.py --sourcetype "{st}" --hourly \\')
            print(f'      --earliest "{splunk_day}:00:00:00" --latest "{splunk_day}:23:59:59"')
            print("\nThen attribute the delta to specific log patterns:")
            print(f'  python3 pattern_ranker.py --sourcetype "{st}" --index main \\')
            print(f'      --at "{splunk_day}:HH:00:00"  # an hour AFTER onset \\')
            print(f'      --compare-before "MM/DD/YYYY:HH:00:00"  # same hour, a normal day')
            print("\n  Tip: pick a 'before' hour from the SAME weekday — weekend volume is"
                  "\n  much lower and will exaggerate the growth factor.")
    elif analysis["verdict"] in ("stable", "ramp"):
        print("\nNext step — rank the steady-state offenders:")
        print(f'  python3 pattern_ranker.py --sourcetype "<st>" --index main')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sourcetype", help="Splunk sourcetype (st= in license_usage)")
    ap.add_argument("--days", type=int, default=45, help="lookback in days (default 45)")
    ap.add_argument("--hourly", action="store_true", help="hourly instead of daily buckets")
    ap.add_argument("--earliest", help="explicit earliest bound (overrides --days)")
    ap.add_argument("--latest", default="now")
    ap.add_argument("--top-sourcetypes", action="store_true",
                    help="list the highest-volume sourcetypes and exit")
    ap.add_argument("--limit", type=int, default=25, help="rows for --top-sourcetypes")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a chart")
    args = ap.parse_args()

    client = SplunkClient()

    if args.top_sourcetypes:
        # license_usage has one row per sourcetype per indexer per 30s, so a
        # repo-wide stats over many days can still exceed the job timeout.
        try:
            rows = client.search(top_sourcetypes_spl(args.limit),
                                 earliest=f"-{args.days}d", latest=args.latest,
                                 count=args.limit)
        except SearchTimeout:
            print(f"[error] Ranking all sourcetypes over {args.days}d timed out.\n"
                  f"  Retry with a shorter window, e.g. --days {max(1, args.days // 4)}.\n"
                  f"  Daily totals scale linearly, so a 1-2 day ranking is representative.",
                  file=sys.stderr)
            return 1
        table = [{"sourcetype": r.get("st", ""),
                  "gb": round(float(r.get("bytes", 0) or 0) / GB, 2)} for r in rows]
        if args.json:
            print(json.dumps(table, indent=2))
        else:
            print(f"\n{'GB':>12}  Sourcetype   (last {args.days}d)")
            print("-" * 62)
            for entry in table:
                print(f"{entry['gb']:>12.2f}  {entry['sourcetype']}")
            print("\nPick the loudest and run:")
            print('  python3 volume_trend.py --sourcetype "<st>"')
        return 0

    if not args.sourcetype:
        ap.error("--sourcetype is required unless --top-sourcetypes is used")

    spl = hourly_spl(args.sourcetype) if args.hourly else daily_spl(args.sourcetype)
    # The REST API rejects Splunk's own MM/DD/YYYY:HH:MM:SS display format, so
    # normalize absolute times to epoch. Relative forms (-24h, @d) pass through.
    earliest = normalize_bound(args.earliest) if args.earliest else f"-{args.days}d"
    latest = normalize_bound(args.latest)

    try:
        rows = client.search(spl, earliest=earliest, latest=latest, count=1000)
    except SearchTimeout:
        print("[error] license_usage query timed out — unusual. Try a shorter --days.",
              file=sys.stderr)
        return 1

    series = parse_series(rows)
    if not series:
        print(f"[error] No license_usage data for st=\"{args.sourcetype}\".\n"
              f"  Verify the sourcetype string with: --top-sourcetypes", file=sys.stderr)
        return 1

    analysis = detect_onset(series)
    analysis["_sourcetype"] = args.sourcetype

    if args.json:
        public = {k: v for k, v in analysis.items() if not k.startswith("_")}
        print(json.dumps({"sourcetype": args.sourcetype,
                          "granularity": "hour" if args.hourly else "day",
                          "analysis": public,
                          "series": [{"time": t, "gb": round(v, 3)} for t, v in series]},
                         indent=2))
    else:
        render(series, analysis, args.hourly)
    return 0


if __name__ == "__main__":
    sys.exit(main())
