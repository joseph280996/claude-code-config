# eclipse-log-size-analysis

Finds which log lines are costing the most Splunk ingest, and tells the owning team exactly
what to change.

Built for service owners to run against their own service, without needing to know SPL.

## Install

```bash
npx skills add git@code.ssnc.dev:WIT/wit-ai-skills.git --skill eclipse-log-size-analysis
```

Then configure credentials (shared with `eclipse-splunk-investigation` if you already use it):

```bash
export SPLUNK_HOST=splunk-awsprod.ezesoft.net
export SPLUNK_USERNAME=your-username
python3 -c "import keyring; keyring.set_password('eclipse-splunk-investigation', \
  'SPLUNK_PASSWORD', 'your-password')"
```

`SPLUNK_TOKEN` works as an alternative. Scripts are stdlib-only; `keyring` is optional.

## Quick start

```bash
cd scripts

# 0. Which sourcetypes cost the most?
python3 volume_trend.py --top-sourcetypes --days 7

# 1. Is my service's volume flat, ramping, or step-changed — and when?
python3 volume_trend.py --sourcetype "kube:container:my-service"

# 2a. If STEP-CHANGE: what caused the increase?
python3 pattern_ranker.py --sourcetype "kube:container:my-service" \
    --at "07/22/2026:14:00:00" --compare-before "07/16/2026:14:00:00"

# 2b. If STABLE: what costs the most right now?
python3 pattern_ranker.py --sourcetype "kube:container:my-service"

# 3. Why is the top pattern expensive, and what do I change?
python3 sample_pattern.py --sourcetype "kube:container:my-service" --type "<Type>"
```

All scripts accept `--json` for piping into other tooling.

## Design notes

**Bytes, not counts.** Every ranking is `sum(len(_raw))`. Event-count rankings mislead: a
200-byte line firing 10M times costs 10× more than a 5KB stack trace firing 1000 times.

**Spike ≠ verbosity.** These need different investigations and have different owners. A spike
investigation that skips trend analysis produces "your INFO logs are verbose" — true of every
service, useful to no one. `volume_trend.py` classifies first, then routes.

**Growth factors, not absolutes.** One pattern growing 66× while the service grows 3.7× is a
regression. Everything growing 4× is capacity planning. `--compare-before` surfaces that contrast.

**Small windows, adaptive.** Splunk search jobs die around 120s, so raw-event scans use windows
of seconds-to-minutes and halve automatically on timeout. `license_usage.log` (pre-aggregated
metadata) handles anything longer. Rule of thumb: license_usage over 4h, `len(_raw)` under 10min,
nothing in between.

**Serialized by design.** Concurrent searches make the search head return 503. The client runs
one at a time, retries with backoff, and deletes finished jobs to free slots.

**Honest about its own limits.** A pattern missing from a truncated "before" list is reported as
`NEW?`, not `NEW`. Fields that look constant only because the sample was narrow are listed
separately as "do NOT drop." Sample windows are always printed so extrapolation is auditable.

**Names and messages aren't evidence.** The tooling warns that a field's name may not be its
meaning (`FirmAuthToken` is a tenant id, not a secret) and that a log message's self-diagnosis is
a hypothesis, not a finding. Both were real errors in the investigation this was built from.

## Layout

| Path | Purpose |
|---|---|
| `SKILL.md` | Skill definition and workflow — what the agent reads |
| `scripts/splunk_client.py` | Search client: 503 retry, `SearchTimeout`, shrinking windows |
| `scripts/volume_trend.py` | Trend + onset detection; sourcetype discovery |
| `scripts/pattern_ranker.py` | Rank by bytes; `--compare-before` attribution |
| `scripts/sample_pattern.py` | Diagnose one pattern; detects per-row loops |
| `references/METHODOLOGY.md` | Full reasoning, hand-run SPL, worked example |

## Provenance

Built from a real investigation: pe-processor went from ~70 GB/day to ~790 GB/day on
2026-07-19. One WARN inside a per-row loop was 96% of the increase. Tracked as DAVOS-2646.

The worked example in `references/METHODOLOGY.md` includes the two wrong conclusions reached
along the way and why they were wrong — those are the reason the tooling nudges toward verifying
field semantics and separating measured from inferred.
