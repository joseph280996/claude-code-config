# Splunk Log Volume Analysis Methodology

Two distinct investigations share this playbook. **Decide which one you're doing first** —
they have different entry points and different success criteria.

| Question | Investigation | Start at |
|---|---|---|
| "This service is expensive — what should we trim?" | **Steady-state reduction** | Part B |
| "Volume jumped last week — why?" | **Regression / spike triage** | Part A |

A spike investigation that skips Part A degenerates into a generic "your INFO logs are verbose"
report. Part A finds the *delta*; Part B ranks the *baseline*.

---

## Core principles

**Rank by bytes, not event count.** A 200-byte line firing 10M times costs more than a 5KB
stack trace firing 1000 times. Always compute `total_bytes = count × avg_bytes`.

**Two numbers define a spike**: *when* it started (onset) and *what share* of the delta one
pattern owns (attribution). Get both before writing any recommendation.

**A pattern that grows 60× while the service grows 3× is a regression, not verbosity.**
Distinguish these — the fix is completely different:

| Pattern | Interpretation | Fix owner |
|---|---|---|
| All patterns grew proportionally | Traffic/tenant growth, or replica count change | Capacity planning |
| One pattern grew, others flat | **Code or data regression** | Service team — fix the cause |
| One pattern is large but was always large | Verbosity | Service team — demote/sample |

**Prefer license_usage for trends, `len(_raw)` for attribution.** `index=_internal
license_usage.log` is pre-aggregated and cheap — use it for any window over a few hours.
Raw-event `len(_raw)` scans are accurate per-pattern but expensive — use them only in
windows of ~2–10 minutes.

---

# Part A — Spike / regression triage

## A1. Establish the trend and confirm a step change

License usage is metadata-only, so this is safe over 30–60 days:

```spl
search index=_internal source=*license_usage.log type="Usage"
  st="kube:container:<service>-service" earliest=-45d latest=now
| timechart span=1d sum(b) as bytes
| eval GB=round(bytes/1024/1024/1024,2)
| table _time GB
```

Read the shape before drilling in:
- **Step change** (flat, then a new plateau) → code deploy, config/flag change, or a data condition. Continue to A2.
- **Ramp** → growing tenant count or dataset. Correlate with tenant onboarding.
- **Spiky/business-hours** → workload-driven; compare like-for-like hours only (see A4).

Establish the weekday baseline explicitly — weekends are much lower and will fool a naive
"before" window.

## A2. Pin the onset to the hour

Narrow to a 2–3 day span across the suspected transition:

```spl
search index=_internal source=*license_usage.log type="Usage"
  st="kube:container:<service>-service"
  earliest="07/19/2026:00:00:00" latest="07/21/2026:12:00:00"
| timechart span=1h sum(b) as bytes
| eval GB=round(bytes/1024/1024/1024,2)
```

An onset that lands mid-evening on a weekday, with no deploy, points at a **data condition**
(a batch job, a tenant migration, a wipe-and-load) rather than a release. Note the hour — you'll
hand it to the service team to correlate against their change log.

## A3. Attribute the delta — the diff that matters

This is the step the old methodology lacked. Pick a **10-minute window before onset** and a
**10-minute window after**, then compare pattern shares. Same time-of-day, same day-of-week
where possible.

Two-bucket probe (cheap, run this first — it either confirms a single dominant cause or tells
you to fall back to the full ranking):

```spl
search index=main sourcetype="kube:container:<service>-service"
  earliest="<pre-onset>" latest="<pre-onset +10m>"
| eval bytes=len(_raw)
| eval pat=if(like(_raw,"%<candidate phrase>%"),"SUSPECT","OTHER")
| stats count, sum(bytes) as tb by pat
| eval mb=round(tb/1024/1024,1)
| table pat count mb
```

Run the identical query on the post-onset window and compute growth per bucket:

| Bucket | Pre | Post | Growth |
|---|---|---|---|
| SUSPECT | 71 MB | 4,655 MB | **66×** |
| OTHER | 68 MB | 249 MB | 3.3× |

**Interpretation rule**: if one bucket's growth factor is an order of magnitude above the
rest, that pattern *is* the incident. Stop broadening and go deep on it (A5).

If you don't yet have a candidate phrase, get one from A4 first.

## A4. Rank patterns in the post-onset window

```spl
search index=main sourcetype="kube:container:<service>-service"
  earliest="<post-onset>" latest="<post-onset +2m>"
| eval bytes=len(_raw)
| stats count, sum(bytes) as tb, avg(bytes) as ab by Type Method Level
| eval mb=round(tb/1024/1024,1), avg_b=round(ab,0)
| sort -tb | head 20
| table mb count avg_b Level Method Type
```

**Use a 2-minute window.** During a 10×-volume incident, wider windows time out at 120s.
When a single pattern owns >90% of bytes, a 2-minute sample is statistically ample.

## A5. Characterize the offending pattern

Pull raw samples and answer these specific questions:

```spl
search index=main sourcetype="kube:container:<service>-service"
  earliest="<post-onset>" latest="<post-onset +1m>"
  Type="<offending type>"
| head 3 | table _raw
```

1. **Is the message per-entity?** Look for an ID in the text (`CloseoutGroupId [293779]`). A
   warning emitted once per row inside a loop scales with dataset size — that's the amplifier.
2. **Is it the same logical event repeated?** Consecutive events differing only in ID, sharing
   one `ActivityId`/`OperationId`, mean one operation is producing thousands of lines.
3. **Does the message text admit the cause?** Self-diagnosing messages ("suspect concurrent
   wipe-and-load or replica lag") are a strong hint about the upstream trigger.

## A6. Scope the blast radius

Find whether this is one tenant or systemic — it determines urgency and the fix:

```spl
search index=main sourcetype="kube:container:<service>-service"
  earliest="<post-onset>" latest="<post-onset +2m>"
  Type="<offending type>"
| eval bytes=len(_raw)
| stats count, sum(bytes) as tb by FirmId FirmName
| eval mb=round(tb/1024/1024,1)
| sort -tb | head 12
| table mb count FirmId FirmName
```

Also check pod spread (`"k8s.pod.name"`) to rule out a single bad replica.

## A7. Deliverable for a spike

State plainly:
- **Onset**: date + hour, UTC and local
- **Magnitude**: baseline GB/day → current GB/day
- **Attribution**: "one pattern = N% of the increase", with the growth-factor table from A3
- **The log line**: `File:Line`, level, sample event
- **Mechanism**: why it amplified (per-row loop, retry storm, data condition)
- **Two separate asks**: (1) stop the bleeding — demote/rate-limit the line; (2) fix the
  underlying condition. Don't let (1) hide (2).

---

# Part B — Steady-state volume reduction

Use when there's no spike, or after Part A's regression is fixed and you want the baseline down.

## B1. Confirm index and event volume

```spl
search index=* sourcetype=<sourcetype> earliest=-60m latest=now
| stats count by index sourcetype
```

## B2. Discover field schema

```bash
cd ~/.claude/skills/eclipse-splunk-investigation
python3 scripts/splunk_explorer.py --mode list_fields \
  --index main --sourcetype "kube:container:<service>-service" --pretty
```

Note: `splunk_explorer.py` takes no `--earliest` flag; it samples a fixed recent window.

Look for `Type`, `Method`, `Level`, `Message`, `punct` — these are grouping candidates.

## B3. Choose the right pattern key

| Log structure | Best grouping key |
|---|---|
| Structured with `Type` + `Method` fields | `Type`, `Method`, `Level` |
| JSON logs with `Message` object | `spath` the discriminating path (e.g. `Message.Purpose`) |
| Unstructured text | `punct` (cheap) or `cluster` (accurate, expensive) |

**Avoid `punct` when most lines share the same shell** (timestamp + prefix) — it collapses
everything into one bucket.

## B4. Aggregate by pattern, rank by total bytes

```spl
search index=main sourcetype=<sourcetype> earliest=-10m latest=now
| eval bytes=len(_raw)
| stats count, sum(bytes) as total_bytes, avg(bytes) as avg_bytes by Type Method Level
| eval total_mb=round(total_bytes/1024/1024,1), avg_b=round(avg_bytes,0)
| sort -total_bytes | head 30
| table total_mb count avg_b Level Type Method
```

Scale the window to the service's volume: 60m for a quiet service, 2–10m for a loud one.
Always state the window in the report and extrapolate explicitly.

## B5. Level breakdown for context

```spl
search index=main sourcetype=<sourcetype> earliest=-10m latest=now
| eval bytes=len(_raw)
| stats count, sum(bytes) as total_bytes by Level
| eval total_mb=round(total_bytes/1024/1024,1)
| sort -total_bytes
```

Usually INFO dominates. **If WARN or ERROR dominates bytes, that's an anomaly, not verbosity** —
switch to Part A.

## B6. Sample top offenders

```spl
search index=main sourcetype=<sourcetype> earliest=-10m
  Type="<type>" Method=<method>
| head 3 | table _raw
```

Inspect: what's in `Message`? What repeats across the envelope? What's constant per process?

---

## Evaluation criteria for "low value"

| Signal | Likely low value |
|---|---|
| Level=INFO or DEBUG | Yes — unless it carries unique business data |
| Same `Message` structure with only IDs varying | Yes — noise |
| Logs every call to a getter/accessor | Yes — delete |
| Logs every HTTP request/response at INFO | Yes — demote or sample |
| Fires once per row of a result set | **Yes — aggregate to one summary line per operation** |
| Warns about an expected/recoverable data state | Yes — demote to DEBUG or emit a metric |
| Workflow state transitions | Maybe — demote unless needed for debugging |
| Fields duplicated in envelope + Message | Yes — dedupe |

## Common envelope bloat to recommend trimming

- `File=` / full workspace paths — redundant with `Type`+`Line`
- `FirmName` when `FirmId` exists — join on lookup
- `FirmAuthToken` — redundant with `FirmId`/`FirmName` (**volume**, not security — see below)
- `DevRoute` — long static feature-flag lists; push to startup log or pod metadata
- `AppDomain`, `ProcessId`, `Silo` — constant per process, push to host metadata
- `AcceptEncoding`, `ContentEncoding` — header noise
- Genuine secrets (passwords, bearer tokens, connection strings) — remove entirely

---

## Don't trust names or self-diagnosis

Two failure modes that produce confident, wrong findings. Both cost credibility with the owning
team, because they make the report look like it was written by someone who doesn't know the
domain.

### 1. A field name is not its meaning

Verify semantics before reporting a field as sensitive or redundant.

| Field | Actual meaning |
|---|---|
| `FirmAuthToken` | **Not a secret.** A unique 5-character tenant identifier (e.g. `TPYT2`). Users type it at login to specify unambiguously which firm/tenant they're signing into — comparable to an account slug or subdomain. The "AuthToken" name is a historical misnomer that stuck. |
| `FirmId` | Internal integer tenant id (e.g. `10275`). Internal-only; users generally don't know their own. |
| `FirmName` | Tenant display name (e.g. `Actus Ray Partners`). |

**Never flag `FirmAuthToken` as a credential leak.** It's fair to question on *redundancy*
grounds when trimming volume — it correlates 1:1 with `FirmId` and `FirmName` — but frame it as
duplication, not as a secret.

Before calling any field a security issue, confirm with the owning team. The cost of asking is
one message; the cost of a wrong security finding is a derailed review.

### 2. A log message's account of its own cause is a hypothesis

When a message appears to diagnose itself or implies a defect, that text reflects what the
*author of the log line* suspected — not established fact, and not necessarily current truth.

Real example: a WARN read *"Response will report StartPrice=0 for this group; suspect concurrent
wipe-and-load or replica lag."* Reported as a likely correctness incident. It wasn't —
`StartPrice=0` is **valid in some cases**. The message overstates severity; the only real defect
was the per-row logging volume.

**How to apply**: in any write-up, separate what you *measured* from what you *inferred*.

| Safe to assert | State as an open question |
|---|---|
| Byte counts, event rates | Why the condition started |
| Onset time, growth factors | Whether a value is business-correct |
| Which patterns/tenants dominate | Whether the message's stated cause is real |

Volume facts are yours to assert — you measured them. A message's claim about its own cause
belongs in a "questions for the team" section.

## Structural fixes, in order of leverage

1. **Aggregate per-row logs** — replace N per-entity lines with one summary (`"142 groups
   missing StartValuation; sample ids: ..."`). Biggest win on regressions.
2. **Rate-limit or dedupe** — log the first N occurrences per operation, then a count.
3. **Demote level** — DEBUG for anything not actionable in production.
4. **Emit a metric instead** — counters belong in Prometheus, not log lines.
5. **Trim envelope** — 20–40% across the board, but only after 1–4.

---

## Query performance notes

Learned the hard way; these prevent most 120s timeouts:

| Constraint | Guidance |
|---|---|
| Script poll timeout is 120s | Any raw-event scan must fit; use minutes-wide windows |
| `timechart` over raw events for days | Will time out. Use license_usage instead |
| Text search over hours during a spike | Will time out even with an indexed phrase |
| Concurrent queries | Splunk returns **503** under parallel load — serialize instead |
| `timeout` command | Not available on macOS/zsh by default |
| Dotted fields (`k8s.pod.name`) | Must be double-quoted or the query silently returns zero |

**Rule of thumb**: license_usage for anything over 4 hours; `len(_raw)` for anything under
10 minutes; nothing in between.

---

## Output format for owning team

For each top pattern:
1. **File:Line** — exact source location
2. **Volume** — MB/hr and event count, with the sample window stated
3. **Sample raw event** — trimmed to show structure
4. **Recommendation** — aggregate/demote/sample/trim/delete, with rationale
5. **For regressions**: separate the *log-volume* fix from the *root-cause* fix

---

# Worked example — pe-processor, July 2026

A real investigation, start to finish, illustrating each step and the two wrong turns.

## What was reported

"pe-processor's log volume went up significantly recently."

## Step 1 — Trend (license_usage, 45 days)

Weekday baseline 60–80 GB/day, weekends 5–13 GB/day. Then:

| Date | GB/day |
|---|---:|
| Jul 19 (Sun) | 70.3 |
| **Jul 20** | **721.4** |
| Jul 21 | 794.2 |
| Jul 22 | 755.0 |

Verdict: **step change, ~9.7×**, sustained. Note the weekend troughs — a naive
"compare to yesterday" from a Monday would have produced a nonsense growth factor.

## Step 2 — Onset (hourly)

| Hour (UTC) | GB |
|---|---:|
| Jul 19 14:00–19:00 | 0.19–0.41 |
| Jul 19 20:00 | 0.80 |
| Jul 19 21:00 | **6.32** |
| Jul 19 22:00 | **29.99** |

Onset: **Jul 19, 20:00–22:00 UTC** — a Sunday evening, no deploy window. That pointed at a
data condition rather than a release, which turned out to be right.

## Step 3 — Attribution (10-min windows either side)

| Bucket | Pre | Post | Growth |
|---|---:|---:|---:|
| `StartValuation row missing` WARN | 80,078 ev / 71.2 MB | 5,328,669 ev / **4,654.9 MB** | **66×** |
| All other patterns | 98,317 ev / 68.3 MB | 329,215 ev / 249.4 MB | 3.7× |

**96.2% of the byte increase** from one pattern. The 66× vs 3.7× contrast is the whole finding:
had everything grown ~4×, this would have been a capacity story with no log line to fix.

Note the pattern **already existed** pre-onset at modest volume. It amplified; it wasn't new.
Don't assume "absent from the before-list" means "newly deployed" — check.

## Step 4 — Diagnosis

```
Level=WARN ... Type="...PositionLoadPerformanceManager" Line=117
File="PositionLoadPerformanceManager.cs"
FirmId=10275 FirmName="Actus Ray Partners" FirmAuthToken=TPYT2
DevRoute="EKS-STAGE3;ACC_DISABLE_ITD_CALC;...;SCHEDULER3"
ActivityId="019f8a20-..." OperationId="1a294ffb-..."
Message="StartValuation row missing for CloseoutGroupId [293779] (Historic present,
  PortfolioId [1] AccountId [2274] IsClosed [True]). Response will report StartPrice=0
  for this group; suspect concurrent wipe-and-load or replica lag."
```

Mechanism: emitted **once per `CloseoutGroupId`** inside a result-set loop. Consecutive events
shared `ActivityId`, `OperationId`, and `ThreadId` — one "Post to IBOR" operation producing
thousands of lines. Volume scaled with affected-group count.

Blast radius: **Actus Ray Partners 89.9%**, Arena Holdings 8.5% — two tenants, 98.4%. Not
systemic, which made the fix tractable.

## Outcome

Tracked as DAVOS-2646: aggregate the per-row logging into one summary line per operation across
four call sites. Root cause was PR #1330 (merged Jul 14) adding per-row `logger.Warn()` calls,
which met a data condition on Jul 19.

## The two wrong turns

Both were confident and wrong, and both are the reason this methodology has a
"don't trust names or self-diagnosis" section.

1. **Flagged `FirmAuthToken` as a plaintext credential leak.** It isn't a secret — it's the
   5-character tenant identifier users type at login. A misleading field name, taken at face value.

2. **Reported `StartPrice=0` as a probable correctness incident**, because the message said
   "suspect concurrent wipe-and-load or replica lag." `StartPrice=0` is valid in some cases. The
   message's self-diagnosis overstated severity; the only real defect was log volume.

Lesson encoded in the tooling: assert what you measured (bytes, rates, onset, growth factors);
route what you inferred to a "questions for the team" section.
