---
name: eclipse-log-size-analysis
description: >
  Analyzes which log patterns are the biggest contributors to Splunk ingest volume for a
  service, and whether a volume increase is a regression or normal growth. Use this skill
  when asked why a service's log volume or ingest cost went up, which logs to trim to reduce
  Splunk spend, what is driving a sourcetype's GB/day, how much a service costs to log, or
  to review a service's logging verbosity. Produces a ranked by-bytes report with file:line
  locations and specific remediation per pattern. Works for any Splunk sourcetype, not just
  registry-backed Eclipse services. Requires SPLUNK_HOST and SPLUNK_USERNAME environment
  variables, plus SPLUNK_PASSWORD in the OS keyring or SPLUNK_TOKEN.
compatibility: >
  Requires Python 3.10+. Standard library only (`keyring` optional for password storage).
  Requires network access to Splunk (default port 8089) and SPLUNK_HOST / SPLUNK_USERNAME
  environment variables with SPLUNK_PASSWORD in the OS keyring, or SPLUNK_TOKEN. Reads
  index=_internal license_usage.log, so the account needs internal-index search rights.
license: Proprietary
metadata:
  author: "@kjatti"
  version: "1.0.0"
  tags: "splunk,logging,ingest-cost,log-volume,observability,cost-optimization,performance"
  scope-roles: "dev"
  scope-products: "eclipse"
allowed-tools: bash
---

# Eclipse Log Size Analysis

Find which log lines cost the most Splunk ingest, and tell the owning team exactly what to change.

## The one rule that matters

**Rank by bytes, never by event count.** A 200-byte line firing 10M times costs 10× more than a
5KB stack trace firing 1000 times. Every query here computes `sum(len(_raw))`.

## Decide which investigation you're running

These have different entry points and different conclusions. Getting this wrong produces a
useless report.

| The question | Investigation | Start with |
|---|---|---|
| "Volume jumped recently — why?" | **Regression triage** | `volume_trend.py` → compare mode |
| "This service is expensive — what do we trim?" | **Steady-state reduction** | `pattern_ranker.py` |

A spike investigation that skips the trend step degenerates into "your INFO logs are verbose" —
which is true of every service and helps no one.

---

## Workflow

### Step 0 — Find the service's sourcetype (if unknown)

```bash
cd scripts
python3 volume_trend.py --top-sourcetypes --days 7
```

Lists the highest-volume sourcetypes by GB. Cheap — reads Splunk's `license_usage.log`, which is
pre-aggregated metadata, not raw events.

### Step 1 — Trend and onset detection

```bash
python3 volume_trend.py --sourcetype "kube:container:peprocessor-service" --days 45
```

Prints a sparkline chart and a verdict: `STEP-CHANGE`, `RAMP`, `STABLE`, or `INSUFFICIENT-DATA`.
It auto-excludes weekend/idle troughs from the baseline (they otherwise fake a step change) and
requires 2+ consecutive elevated days so a one-off burst isn't misread as a plateau.

Interpret the verdict:

| Verdict | Means | Do next |
|---|---|---|
| `STEP-CHANGE` | Flat, then a new plateau | Pin the hour, then **compare mode** (Step 2) |
| `RAMP` | Gradual growth | Tenant/dataset growth — capacity planning, then Step 3 |
| `STABLE` | No change | Steady-state reduction (Step 3) |

For a step change, pin the onset hour:

```bash
python3 volume_trend.py --sourcetype "<st>" --hourly \
    --earliest "07/19/2026:00:00:00" --latest "07/20/2026:12:00:00"
```

An onset with no corresponding deploy points at a **data condition** (batch job, tenant reload,
replica lag) rather than a release. Note the hour and hand it to the team to correlate.

### Step 2 — Attribute the increase (regressions only)

This is the step that separates a real finding from a guess:

```bash
python3 pattern_ranker.py --sourcetype "<st>" --index main \
    --at "07/22/2026:14:00:00" \
    --compare-before "07/16/2026:14:00:00"
```

Samples both windows, then ranks patterns by **share of the delta** and growth factor.

**Pick the "before" window from the same weekday and same hour.** Weekend volume is far lower
and will inflate every growth factor.

Reading the output:

| Signal | Meaning | Fix |
|---|---|---|
| One pattern >25% of delta, growth ≫ others | **Code/data regression** | Fix that line — usually logging in a loop |
| Pattern shows `NEW` | Newly deployed log line | Check recent PRs touching that file |
| All patterns grew similarly | Traffic/tenant/replica growth | Not a logging bug; capacity planning |

A pattern growing 66× while the service grows 3.7× is a regression, not verbosity. That
distinction determines who owns the fix.

### Step 3 — Rank the current offenders

```bash
python3 pattern_ranker.py --sourcetype "<st>" --index main
```

Auto-discovers the grouping key by measuring what fraction of events each candidate **covers**,
not merely whether it exists. Strategies tried in order: `Type`+`Method` (.NET), `Class`+`Name`
(ASP.NET Core), `Layer`+`Method` (Go services), `logger_name`, `Level`, then `punct`. A field
covering <60% of events is rejected and the tool falls through; coverage under 98% prints a
warning naming the unattributed share. Override with `--group-by`.

Why coverage and not existence: `position-lot-enricher` populates `Type` on **0.1%** of its
events. Grouping by it produced a ranking of 42 events out of 118,079 that looked authoritative
and was wrong by three orders of magnitude.

Reports GB/day, share, events/sec, and avg bytes per pattern, plus concentration ("top 3 = 80%
of bytes") and a level breakdown. Null grouping values appear as `(unset)` rather than being
silently dropped by `stats`.

**If WARN/ERROR is >40% of bytes, that's an anomaly, not verbosity** — a healthy service logs
mostly INFO. The tool says so explicitly. Go back to Step 2.

### Step 4 — Diagnose the top offender

```bash
python3 sample_pattern.py --sourcetype "<st>" \
    --type "Eze.Eclipse.Accounting.PEProcessor.Domain.Managers.PositionLoadPerformanceManager"
```

Pulls raw samples and detects *why* the pattern is expensive:

- **Per-row loop** — near-sequential entity ids in the message. Highest-leverage finding: this
  log call is inside a loop over a result set, so volume scales with dataset size.
- **Per-operation amplification** — many lines sharing one `OperationId`/`CorrelationId`.
- **Envelope bloat** — % of each line that is fields identical across every sample. Candidates
  found in the sample are then re-checked with `dc()` over the whole window, because a 15-event
  sample cannot tell a constant from a low-cardinality field. Fields that turn out to vary are
  listed separately and excluded from the byte total. This matters: an unverified sample put
  `position-lot-enricher`'s envelope bloat at 382 B (43%); `dc()` over 60,451 events put it at
  95 B (11%) once `SnapshotId`, `TransactionGroupId`, and `StartPrice` were ruled out.
- **Intra-line redundancy** — the same value appearing in both envelope and message.
- **Tenant concentration** — one firm producing most of the volume, which scopes the fix.

It also reports `File:Line` so the team knows exactly where to edit.

---

## Remediation, ordered by leverage

Recommend in this order. The first is often a >99% reduction; the last is ~30%.

1. **Aggregate per-row logs** — replace N per-entity lines with one summary carrying a count and
   a few sample ids:
   `"StartValuation missing for 4,182 of 5,004 groups; samples: [293778, 293779, 293780]"`
   Preserves the diagnostic signal — arguably improves it, since a count is more actionable than
   4,000 near-identical lines.
2. **Rate-limit / dedupe** — first N occurrences per operation, then a count.
3. **Demote level** — DEBUG for anything not actionable in production.
4. **Emit a metric instead** — counters belong in Prometheus, not log lines.
5. **Trim envelope** — real but modest; do it after 1–4.

Prefer aggregation over indexer-side filtering: filtering discards evidence, aggregation keeps it.

## What counts as low-value

| Signal | Verdict |
|---|---|
| Fires once per row of a result set | **Aggregate** — the biggest win available |
| Logs every call to a getter/accessor | Delete |
| Logs every HTTP request *and* response at INFO | Demote or sample |
| Warns about an expected/recoverable state | Demote to DEBUG, or emit a metric |
| Same message with only IDs varying | Aggregate or sample |
| Fields duplicated in envelope + message | Dedupe |
| Workflow state transitions at INFO | Usually demote — recoverable from the store |

---

## Two mistakes that discredit a report

Both produce confident, wrong findings that make the analysis look uninformed about the domain.

### A field's name is not its meaning

Verify before calling anything sensitive. Known example in Eclipse services:

- **`FirmAuthToken`** is **not a secret** — it's a 5-character tenant identifier users type at
  login to pick their firm (like an account slug). The "AuthToken" name is a historical misnomer.
  Never flag it as a credential leak. It's fair to question as *redundant* with `FirmId`, but
  that's duplication, not security.
- **`FirmId`** is the internal integer tenant id; **`FirmName`** is the display name.

Ask the owning team before reporting any field as a security issue. One message costs nothing;
a wrong security finding derails the review.

### A log message's account of its own cause is a hypothesis

When a message diagnoses itself, that text is what its *author* suspected — not fact.

Real example: `"Response will report StartPrice=0 for this group; suspect concurrent
wipe-and-load or replica lag."` This was reported as a probable correctness incident. It wasn't —
`StartPrice=0` is valid in some cases. The only real defect was the logging volume.

**Separate measured from inferred in every write-up:**

| Assert it | Ask about it |
|---|---|
| Byte counts, event rates, GB/day | Why the condition started |
| Onset time, growth factors | Whether a value is business-correct |
| Which patterns and tenants dominate | Whether the message's stated cause is real |

---

## Query performance constraints

These are the real limits; they shape every query in this skill.

| Constraint | Consequence |
|---|---|
| Search jobs time out ~120s | Raw-event scans must use windows of **seconds to minutes**, not hours |
| `timechart` over raw events for days | Always times out — use `license_usage` instead |
| Concurrent searches → **HTTP 503** | Never parallelize. The client serializes and backs off |
| Dotted fields (`k8s.pod.name`) | Must be double-quoted or the query **silently returns zero** |
| Leading wildcards (`*Timeout`) | Disable the term index; full scan |
| `MM/DD/YYYY:HH:MM:SS` time bounds | The REST API **rejects Splunk's own display format** (HTTP 400 "Invalid earliest_time"). The scripts normalize absolute bounds to epoch, so you can pass either form |
| Absolute bounds are read as **UTC** | Not the search head's local time — buckets are offset from what Splunk's UI shows (~4h for US/Eastern). Label report timestamps UTC |

**Rule of thumb**: `license_usage` for anything over ~4 hours; `len(_raw)` for anything under
~10 minutes; nothing in between.

`pattern_ranker.py` and `sample_pattern.py` **halve their window automatically on timeout**, so a
loud service degrades to a smaller sample instead of failing. The window actually used is always
printed — quote it in the report, and extrapolate explicitly.

Sampling caveat: a 2-minute window is statistically ample when one pattern owns >90% of bytes,
but thin for a flat distribution. If the top pattern is <20% of volume, widen with `--window 300`.

**Never extrapolate a short window to GB/day for a bursty service without checking.** Run
`volume_trend.py --hourly` for the sample day first. `pe-processor` swings 0.54–71.30 GB/hour
within one day (130×): the same 30-second query implies 5 GB/day at 17:00 and 311 GB/day at
10:00. Batch-driven services are the norm here, not the exception. Quote the `license_usage`
daily total as the headline figure and use `len(_raw)` only for *shares between patterns*, which
are stable even when the absolute rate is not. Cross-check the two over the same window and
report the agreement (it was within 3–7% for all three services measured).

---

## Reporting template

```markdown
# <service> Log Volume Analysis — <date>

## Summary
<one sentence: what's driving volume, and is it a regression or verbosity>

| Metric | Before | After |
|---|---:|---:|
| Daily ingest | X GB/day | Y GB/day |

## Onset            (regressions only)
Step change at <date hour UTC>. Baseline X GB/day → Y GB/day (Nx).

## Attribution
| Bucket | Before | After | Growth |
|---|---:|---:|---:|
| <pattern> | ... | ... | **Nx** |
| all others | ... | ... | Mx |

One pattern = N% of the increase.

## The log line
**File**: `Foo.cs:117`  **Level**: WARN
<sample event, trimmed>
**Why it amplified**: <per-row loop / retry storm / new deploy>

## Blast radius
<tenant / pod concentration>

## Recommendations
1. <aggregate/demote/sample — with expected GB/day saved>

## Questions for the owning team
- <anything inferred rather than measured>

## Method notes
Sample windows used, and the trend source (license_usage vs raw).
```

Always state the sample window and that figures are extrapolated. A reviewer who can't tell a
2-minute sample from a full day can't trust the numbers.

---

## Setup

```bash
export SPLUNK_HOST=splunk-awsprod.ezesoft.net
export SPLUNK_USERNAME=your-username
python3 -c "import keyring; keyring.set_password('eclipse-splunk-investigation', \
  'SPLUNK_PASSWORD', 'your-password')"
```

`SPLUNK_TOKEN` works instead of username/password. A `.env` file in the skill root holding
`SPLUNK_HOST` / `SPLUNK_USERNAME` is also read. Scripts are **stdlib-only** (`keyring` optional).

## Files

| Path | Purpose |
|---|---|
| `scripts/splunk_client.py` | Search client: retries 503s, raises `SearchTimeout`, shrinking windows |
| `scripts/volume_trend.py` | Cheap trend + automatic onset detection; `--top-sourcetypes` discovery |
| `scripts/pattern_ranker.py` | Rank patterns by bytes; `--compare-before` for attribution |
| `scripts/sample_pattern.py` | Diagnose one pattern: per-row loops, envelope bloat, tenants |
| `references/METHODOLOGY.md` | Full reasoning, worked example, SPL to run by hand |
