---
name: eclipse-db-review
description: >
  Performs a comprehensive review of a SQL Server / T-SQL database codebase by analyzing
  schema, indexes, stored procedures, functions, UDTTs, and foreign keys. Discovers
  every object type, maps the query patterns each table is subjected to, identifies
  correctness landmines, performance cliffs, concurrency races, and surfaces inconsistencies
  in indexing, datatype, transaction, and upsert patterns. Use when asked to review a
  database, audit schema/procs/indexes, find DB perf issues, or run a "DBA review".
license: Proprietary
metadata:
  author: "@raston"
  version: "1.0.0"
  tags: "database,sql-server,t-sql,review,performance,schema,index,concurrency"
  scope-roles: "dev"
compatibility: >
  SQL Server / T-SQL codebases only (the rule pack is dialect-specific). Works with
  any layout where T-SQL objects live in source-controlled .sql files (SSDT/.sqlproj,
  flat folders, generator output). Postgres / MySQL / Oracle / SQLite are out of scope —
  warn the user and stop. No external tools or credentials needed; the review is purely
  static analysis. DMV data (sys.dm_db_index_usage_stats, Query Store) required to
  confirm redundant and unused index findings.
allowed-tools: Read, Grep, Glob, Workflow, Bash
---

# Database Review

Produces a comprehensive review document for a SQL Server / T-SQL database codebase by performing static analysis across schema, indexes, stored procedures, functions, UDTTs, and foreign keys, fanning out across functional domains in parallel and adversarially verifying every high-severity finding before synthesis.

The review is organized around five priority focus areas plus a sixth concurrency lens:

1. **Schema** — table design, constraints, computed columns, identity hot spots, FK coverage and indexing, nullability intent.
2. **Data types** — same-logical-id divergence across tables, money in FLOAT/REAL, NVARCHAR(MAX) abuse, DECIMAL precision, GUID clustered keys, PK/FK type mismatches.
3. **Indexes** — bidirectional audit. Forward (does each hot predicate have a matching index?) and reverse (for each existing index, who uses it? rate `useful / marginal / useless`).
4. **Stored procs / functions** — cost smells (I/O, CPU, plan instability) drawn from an explicit catalog.
5. **Anti-patterns** — full sweep of every proc against an explicit anti-pattern catalog. (Folders named `Generated/` are historical; their contents are hand-maintained code subject to the same review standards as everything else.)
6. **Concurrency, MERGE/upsert races, SOD/bulk hot path** — kept as a dedicated dimension because it consistently produces the highest-severity findings in this codebase shape.

---

## Invocation

The user will ask something like:
- "Run a database review on [project]"
- "Review the resiliency / performance of our database"
- "Audit our schema, procs, and indexes"
- "DBA review of [project]"
- "What perf issues do we have in the database?"

If the user does not specify a target project or the workspace contains multiple `.sqlproj` roots, ask which one to analyze.

---

## Output

A single markdown document placed at `docs/database-review.md` in the target project's root (or a path the user specifies), structured per the Output Format below and starting with a prioritized Executive Summary.

---

## Output Format

### Executive Summary

Start with a short, prioritized table of the highest-risk findings so the document is actionable without reading every section.

| Risk | Severity | Category | Blast Radius | Why It Matters | Recommended Action | Evidence |
|------|----------|----------|--------------|----------------|--------------------|----------|

### 1. Overview

Brief description of the database's role, its top-level layout (Tables / Indexes / StoredProcedures / Functions / UserDefinedTableTypes / ForeignKeys), object counts per type, and how procs are organized (entity prefixes, version-suffix conventions like `_V2`). Note: subfolders named `Generated/` are historical; their contents are hand-maintained code, not codegen output.

### 2. Object Inventory

A flat inventory by object type — the database is a single artifact, not a collection of subsystems. Counts are real integers from the Inventories phase, not placeholders.

| Object Type | Count | Notes |
|-------------|-------|-------|
| Tables | N | Includes Latest/History pair count |
| Indexes | N | clustered vs nonclustered split, filtered indexes used? |
| Stored Procedures | N | version sprawl count (_V2/_V3/_V6), naming conventions (_MergeBulk, _FindLatest, _SOD_) |
| Functions | N | scalar UDFs vs inline TVF vs multi-statement TVF (counts) |
| User-Defined Table Types | N | passed as TVPs to *_MergeBulk patterns |
| Foreign Keys | N | coverage relative to FK-shaped columns |
| Views / Triggers | N | 0 if absent (still listed) |

The Notes column captures the high-level shape — concentration in one area, conventions worth flagging, anything a reviewer reading the report would want to know before reading findings.

#### 2.1 Hot-Path Register

The 10-20 procs that drive the critical workload — closeout, SOD, MergeBulk fan-in, NAV/P&L reporting, position-event processing, tenant init. Use this to know which procs to scrutinize first.

| Proc | Flow | Call Shape | Tables Touched | Version | Notes |
|------|------|------------|----------------|---------|-------|

#### 2.2 Stored Procedure Inventory

Two tables: (a) distribution by proc-name kind (computed across every proc in the codebase) with TRY/CATCH, XACT_ABORT, and cursor coverage as `N of M`; (b) procs flagged with cost smells, ranked by smell count. Clean procs are NOT individually listed — this section is a fix-list.

| Kind | Count | Has TRY/CATCH | Has XACT_ABORT | Uses Cursor | Notes |
|------|-------|---------------|----------------|-------------|-------|

| Proc | Kind | Statements | Smells |
|------|------|------------|--------|

#### 2.3 Function Inventory

Lists scalar UDFs (always shown — CPU/parallelism risk pre-2019), multi-statement TVFs (always shown — fixed cardinality), and any function carrying a cost smell. **Clean inline TVFs (e.g. the generated `*_FindLatest` / `*_SelectLatest` fleet) are summarized in a one-line note rather than listed individually** — they inline into callers and add no review value.

| Function | Kind | Returns | Called By (sample) | Smell |
|----------|------|---------|--------------------|-------|

#### 2.4 Column Dictionary (Tables with Concerns)

Per-table column documentation for tables that appear in a finding OR have a flagged index. Clean tables are intentionally omitted — see per-finding citations in Section 3 for the rest.

For each table, an H5 heading + table file citation + column list:

| Column | Type | Null | PK | Identity / Computed | FK | Notes |
|--------|------|------|----|---------------------|----|-------|

Tables with >40 columns show only interesting ones (PK/FK/computed/divergent) plus a "<N> additional columns omitted" line.

#### 2.5 Index Portfolio (Tables with Index Concerns)

Per-table index breakdown for tables with at least one flagged index, non-useful verdict, or index-related finding. Clean tables (every index marked useful) are dropped. The reader uses this to spot redundancy, oversized INCLUDEs, useless leading columns, and missing filters at a glance.

For each table, clustered key + index list:

| Index | KEY columns | INCLUDE | Filter | Unique | Sample Callers | Verdict | Reason |
|-------|-------------|---------|--------|--------|----------------|---------|--------|

`Verdict ∈ useful / marginal / useless / redundant / design-defect / unknown`. Verdicts of `useless` / `redundant` are tagged ❓ and require DMV confirmation. After all per-table tables, a "Cross-table notes" subsection calls out codebase-wide index patterns.

### 3. Findings

The findings section is organized by REVIEW DIMENSION, not by entity family or subsystem. Each subsection covers one of the six dimensions and contains every finding routed to it (whether raised by a cross-cutting agent or by a chunked deep-dive agent). Findings carry `[DISCREPANCY]` tags when they represent a divergence from the dominant pattern.

**Column definitions used in dimension tables:**
- **Files**: Specific file paths (and line numbers when known) showing the implementation
- **Evidence / Predicate / Smell / Anti-Pattern** (column varies by dimension): The exact code snippet, DDL excerpt, or pattern match
- **Impact / Why It Matters**: What goes wrong, under what data volume / concurrency / configuration
- **Severity**: `critical` (correctness / data loss / silent corruption), `high` (major perf cliff or scaling problem), `medium` (meaningful perf or maintainability), `low` (nit / cleanup)
- **Confidence**: `✅ Verified from code`, `⚠️ Inferred from context`, or `❓ Unknown / needs DMV or runtime verification`
- **Recommendation / Action Items**: Concrete fix, with `[TBD]` JIRA placeholder

#### 3.1 Schema Design & Integrity

| Table | PK Choice | Clustered Key | CHECK Constraints | Computed Cols | FK Coverage | FK Indexed? | Notes |
|-------|-----------|---------------|-------------------|----------------|-------------|-------------|-------|

**Questions to surface:**
- Is `PRIMARY KEY` ever declared without `CLUSTERED` (and no other clustered index exists), defaulting silently to a nonclustered PK on a heap?
- Are random GUIDs or wide composite keys being used as the clustered key? (Page splits, fragmentation.)
- Are there referential columns without an FK constraint, or FK columns lacking a supporting index? (Slow joins, slow cascade deletes.)
- Are CHECK constraints absent for invariants the proc layer assumes?
- Are there IDENTITY hot spots — single-table insertion bottlenecks for high-throughput workloads?
- Are computed columns used in indexes declared `PERSISTED`?
- Does column nullability contradict proc-layer assumptions?
- Do "unique" natural-key indexes include NULLable columns and silently allow duplicates? (`NULL != NULL`.)

#### 3.2 Data Type Choices & Consistency

| Logical Concept | Tables | Datatypes Seen | Nullability | Recommended Type | Source | Recommendation |
|-----------------|--------|----------------|-------------|------------------|--------|----------------|

**Questions to surface:**
- Is the same logical id used with different datatypes across tables? (Implicit conversion disables seeks — always a finding.)
- Are monetary / quantity columns using `FLOAT` / `REAL` instead of `DECIMAL`?
- Are `DECIMAL(p,s)` precisions inconsistent across tables for the same logical concept?
- Is `NVARCHAR(MAX)` / `VARCHAR(MAX)` used where a bounded length would do (and would allow the column in indexes)?
- Are GUIDs used as clustered keys?
- Is `DATETIME` used where `DATETIME2` would be more precise and smaller?
- Are `BIT` columns being treated as `TINYINT` in callers (or vice versa)?
- Are PK and FK column types mismatched?

#### 3.3 Index Audit (Forward + Reverse + Design)

| Lens | Table / Index | Hot Predicate / Caller / Defect | Match Quality | Status | Source | Recommendation |
|------|---------------|----------------------------------|----------------|--------|--------|----------------|

`Status` ∈ `useful` / `marginal` / `useless` / `missing` / `design-defect`. Mark `useless` as `❓` until DMV usage stats confirm.

**Forward — does each hot predicate have a matching index?**
- Are there hot predicates with no supporting index? (Forces full scans.)
- Are there indexes whose leading key column doesn't match the dominant predicate? (Rendered useless for that query.)
- Are there sparse predicates (`WHERE IsDeleted = 0`, `WHERE IsActioned = 0`) that would benefit from a filtered index?

**Reverse — does each existing index have a caller?**
- For each index, identify which proc/query its leading-key shape could plausibly serve.
- Are there indexes with no caller, or fully prefix-redundant with another index? (Mark `❓` — DMV `sys.dm_db_index_usage_stats` required to confirm unused.)

**Design — is each index defined sensibly, regardless of who calls it?**
- **Key column order** — is the leading column the most selective for the dominant equality predicate? Flag indexes led by low-cardinality columns (BIT, status enum, `IsDeleted`, `IsActioned`, type discriminators) when a more selective column exists later in the key. Leading with a BIT column is almost always wrong unless paired with a filter on that BIT.
- **Key vs INCLUDE placement** — columns used in WHERE / JOIN / ORDER BY belong in the KEY; columns only projected in SELECT belong in INCLUDE. Flag columns in the key that are never filtered/sorted on, and columns in INCLUDE that are filtered/sorted on.
- **Composite key order for range queries** — if the dominant query is "equality on A, range on B", the key should be `(A, B)`. Flag the inverse.
- **INCLUDE size** — oversized INCLUDE lists (>5 wide columns, LOB columns, or every column in the table) bloat the index to 50-100% of table size.
- **Missing filter predicate** — for sparse columns, a filtered index is dramatically smaller and faster. Flag missing opportunities.
- **Sort direction** — `ORDER BY col DESC` queries benefit from the index declaring `col DESC`.
- **Uniqueness** — natural keys declared as non-unique allow silent duplicate inserts; UNIQUE on a NULLable key allows duplicate NULLs.
- **DATA_COMPRESSION / FILLFACTOR** — flag inconsistency across indexes on the same table; `FILLFACTOR < 100` on append-only IDENTITY clustered keys wastes space.
- **Clustered choice** — random GUID, wide composite, low-selectivity leading column, or heavily-updated columns all degrade clustered-index performance.

#### 3.4 Stored Proc / Function Cost Smells (I/O, CPU)

| Proc / Function | Smell | Bound (I/O / CPU / Plan) | Hot Path? | Files | Source | Recommendation |
|-----------------|-------|--------------------------|-----------|-------|--------|----------------|

**Questions to surface (smell catalog):**
- Are scalar UDFs invoked in WHERE / JOIN / SELECT? (Per-row CPU; single-threaded plan pre-2019.)
- Are multi-statement TVFs joined in queries? (Cardinality estimate fixed at 100 / 1.)
- Are sorts or aggregations running with no supporting index? (Sort operator + spill risk.)
- Are there wide UPDATEs that touch columns whose values did not change? (Extra log + index maintenance.)
- Are there implicit datatype conversions on indexed columns?
- Leading-wildcard LIKE / function-on-indexed-column / `ISNULL(col, x)` on indexed column?
- `(@p IS NULL OR col = @p)` filter patterns without `OPTION(RECOMPILE)` or dynamic SQL?
- Cursors / `WHILE @@FETCH_STATUS = 0` driving per-row work that should be set-based?
- Table variables holding >100 rows? (No stats → nested-loop plan.)
- MERGE source TVF read outside the MERGE's lock scope? (Breaks atomicity.)
- DML that fires triggers / cascades — write amplification not visible at the call site?
- `SELECT *` in a production code path or view definition?

#### 3.5 Anti-Pattern Sweep (Full)

| Anti-Pattern | Severity | Occurrences | Sample Files | Discrepancy? | Source | Recommendation |
|--------------|----------|-------------|--------------|---------------|--------|----------------|

A full sweep over every proc (including anything inside `Generated/` folders — those are historical names; the contents are hand-maintained), ticked through the explicit anti-pattern catalog.

**Correctness / data loss:**
- Swallowed `BEGIN CATCH` blocks (no `THROW` / re-raise) — data-loss candidates.
- `RAISERROR` re-raise instead of `THROW` (loses error number, line, severity).
- Multi-statement DML procs missing `SET XACT_ABORT ON`.
- `IF EXISTS-then-INSERT/UPDATE` upsert race.
- `MERGE` used as a concurrent upsert without `HOLDLOCK` on the target.
- Per-batch transaction inside a `WHILE` loop in a proc whose name implies atomicity.

**Safety:**
- `TOP` without `ORDER BY` where ordering matters.
- `@@IDENTITY` instead of `SCOPE_IDENTITY`.
- Hardcoded `WITH (INDEX(...))` plan-pinning hints.
- `NOLOCK` / `READ UNCOMMITTED` outside reporting/staging.
- `DELETE` / `UPDATE` missing `WHERE` in non-truncate context.

**Legacy syntax:**
- `SET ROWCOUNT` for DML (deprecated).
- 3-part-name cross-database access where a synonym would do.
- Anti-pattern repeated across many similarly-shaped procs (e.g. every `*_FindLatest`, every `*_MergeBulk`) — report ONCE as a fleet-wide finding citing a sample of files, not 200 per-file findings.

#### 3.6 Concurrency, Locking, MERGE/Upsert Races, SOD Hot Path

| Proc / Pattern | Risk | Lock Hints | XACT_ABORT? | Batched? | Atomic? | Source | Recommendation |
|----------------|------|------------|-------------|----------|---------|--------|----------------|

**Questions to surface:**
- Are read-then-write upsert patterns missing `UPDLOCK, HOLDLOCK` on the existence check?
- Are MERGE statements used as concurrent upserts without `HOLDLOCK` on the target?
- Are TVF / source rows read outside the MERGE's lock scope, breaking atomicity?
- Are large `DELETE`s / `UPDATE`s run without batching, allowing lock escalation past the 5,000-lock threshold?
- Are batched-delete loops (`WHILE ... DELETE TOP (N)`) committing per batch, breaking the apparent atomicity of the proc name?
- Are there long-running transactions blocking concurrent readers?
- Are there deadlock-prone access orderings — two procs touching tables in different orders?
- Are SOD-path predicates aligned with an existing index, or being absorbed by the lock manager?
- Are batched deletes resumable after mid-loop failure?
- Is there a missing unique index that would have serialized a race the merge logic is racing on?

### 4. Refuted Findings

Findings that the adversarial verification pass refuted, listed with the reason. This section gives the reader confidence that the report's positive findings have been challenged, and surfaces near-misses that future reviewers may want to revisit.

| Finding | Files | Reason Refuted | Reviewer Severity |
|---------|-------|----------------|-------------------|

### 5. Unknowns / Requires Verification

Checklist of items that cannot be determined from code alone and require:
- DMV data (`sys.dm_db_index_usage_stats`, `sys.dm_db_missing_index_details`, Query Store)
- Production trace / Extended Events capture
- Actual data volume and distribution
- Team input (intended SLA, criticality of specific procs)

---

## Execution Plan

### Phase 1: Discovery

Before launching the workflow, perform a fast structural pass.

**Path discipline — read first.** All Phase 1 commands MUST use absolute paths. NEVER use `cd` to change directory before running a command — your shell state does not persist between Bash calls, so `cd X && find Y` works the FIRST time and silently fails on retries when the working directory has reset. Symptom: `bash: line 1: cd: Tenant/Ibor: No such file or directory`. Fix: drop the `cd` and pass absolute paths to every command.

```
✅ CORRECT (absolute path, no cd)
find "C:/Dev/Eclipse/Accounting/ibor-database/Tenant/Ibor/StoredProcedures" -name "*.sql" -printf "%f\n" | awk -F_ '{print $1}' | sort | uniq -c | sort -rn

❌ WRONG (relative path with cd — fails non-deterministically)
cd Tenant/Ibor && find StoredProcedures -name "*.sql" ...
```

Prefer Glob/Grep over Bash for counting — they don't depend on working directory at all and don't need permission prompts.

1. **Identify the SQL root** — commonly `Tenant/`, `Database/`, `db/`, `sql/`, or wherever a `.sqlproj` lives. Use Glob (with an absolute `path` arg) to confirm. Capture the absolute path of the SQL root in a variable you'll use throughout — call it `repoRoot`.
2. **Confirm dialect by sampling files** — T-SQL markers: `CREATE PROCEDURE`, `[bracketed].[identifiers]`, `NVARCHAR`, `IDENTITY`, `EXEC sp_*`, `WITH (NOLOCK)`. Postgres / MySQL markers (`RETURNS SETOF`, `$$ LANGUAGE plpgsql`, `AUTO_INCREMENT`) → **STOP and warn the user** that this skill is T-SQL only.
3. **Count files by object type** — use Glob with absolute paths: `<repoRoot>/Tables/**/*.sql`, `<repoRoot>/Indexes/**/*.sql`, etc. Infer from filenames if the layout differs.
4. **Identify excluded directories** — typically `Migrations/`, `BuildScripts/`, `DataScripts/`, `obj/`, `bin/`. Always confirm with the user if a folder is ambiguous (e.g., `Tests/`, `LegacyScripts/`).
5. **Group all procs by entity prefix for parallel fan-out** — Glob `<repoRoot>/StoredProcedures/**/*.sql` (absolute path), extract the first underscore-delimited token of each filename, and tally. Include procs from any `Generated/` subfolders alongside the rest (those folder names are historical; the contents are hand-maintained code). Pick the **8-12 largest groups** as analysis chunks (purely a parallelization technique — agents review their chunk and return findings; the report does NOT carve the database into per-chunk subsystems).
6. **Summarize back to the user** — "I see N tables, M indexes, P procs. Splitting into N analysis chunks for parallel review: [list]. Excluding [folders]. Going to launch the workflow; ETA 30-60 minutes; will produce `docs/database-review.md`."

### Phase 1.5: Launch the Workflow — DO THIS EXACTLY

**The most common failure of this skill is a fumbled launch.** Follow this checklist literally.

#### Pre-flight checklist

Before calling the Workflow tool, confirm out loud (to yourself) that you have:

- [ ] An **absolute** path for `repoRoot` (no relative paths, no `~`). On Windows, use double-backslashes inside JSON strings, e.g. `"C:\\Dev\\Eclipse\\Accounting\\ibor-database\\Tenant\\Ibor"`.
- [ ] An **absolute** path for `reportPath`, ending in `.md`.
- [ ] A `domainGroups` **array** with 8-12 objects, each having `key`, `label`, `focus` keys. Not a string. Not stringified JSON.
- [ ] An `excludePaths` **array** of folder names relative to `repoRoot` (or `[]`).
- [ ] You will pass `scriptPath` pointing to the workflow file shipped with this skill. **Never** inline the script body — the script lives at `<this-skill-folder>/assets/workflow.js` and contains template literals + unicode that round-trip badly through inline JSON encoding.

#### Locating the workflow script

The workflow file ships next to this SKILL.md. Resolve its absolute path before calling Workflow:

- Skills installed globally live under `~/.claude/skills/eclipse-db-review/assets/workflow.js` (Windows: `C:\Users\<you>\.claude\skills\eclipse-db-review\assets\workflow.js`).
- Skills installed per-project live under `<project>/.claude/skills/eclipse-db-review/assets/workflow.js`.
- If unsure, run a quick Glob for `**/eclipse-db-review/assets/workflow.js` to confirm before launching.

#### Tool call template

Call the **Workflow** tool with these exact parameter shapes:

```
Workflow({
  scriptPath: "C:\\Users\\<you>\\.claude\\skills\\eclipse-db-review\\assets\\workflow.js",
  args: {
    repoRoot: "C:\\Dev\\Example\\Database\\Tenant\\Foo",
    excludePaths: ["Migrations", "BuildScripts", "DataScripts", "obj", "bin"],
    domainGroups: [
      { key: "lot", label: "Lot prefix chunk", focus: "All Lot* tables, indexes, and procs (Lot_, LotValuation_, LotProfitLoss_)" },
      { key: "positionevent", label: "PositionEvent prefix chunk", focus: "PositionEvent, PositionState, EventState tables and PositionEvent_*, EventStatus* procs" }
      // ... 8-12 entries total
    ],
    reportPath: "C:\\Dev\\Example\\Database\\docs\\database-review.md"
  }
})
```

#### Allowed top-level keys — Workflow tool has `additionalProperties: false`

The Workflow tool's JSON Schema accepts ONLY these top-level keys: `scriptPath`, `args`, `name`, `script`, `resumeFromRunId`, `description`, `title`. ANY other top-level key (e.g. `repoRoot`, `domainGroups`, `excludePaths`, `reportPath`, `phases`, `inventory`, `script_path`, `argsObj`, `params`) returns "Invalid tool parameters" and the call fails silently — the workflow does NOT launch.

**Every db-review-specific field MUST be nested under `args`.** When in doubt, the only top-level keys you should ever set are `scriptPath` and `args`. That is it.

```
✅ CORRECT
{ "scriptPath": "...", "args": { "repoRoot": "...", "domainGroups": [...] } }

❌ WRONG — repoRoot/domainGroups at top level
{ "scriptPath": "...", "repoRoot": "...", "domainGroups": [...] }

❌ WRONG — phases is a meta-block field, not a tool argument
{ "scriptPath": "...", "args": {...}, "phases": [...] }
```

#### Common mistakes — read before calling

1. **DO NOT inline the script.** Use `scriptPath` pointing at `assets/workflow.js`. Inlining the 700-line script as a string has caused parse errors (template literals, regexes, and unicode characters survive disk read but corrupt under inline JSON encoding).
2. **Pass `args` as a real object, not a stringified one.** The workflow auto-parses a JSON-string `args` as a fallback, but real objects are the supported shape. `domainGroups` and `excludePaths` should be real arrays.
3. **Never put db-review fields at the top level.** `repoRoot`, `domainGroups`, `excludePaths`, `reportPath` belong INSIDE `args`. The Workflow tool rejects unknown top-level keys with "Invalid tool parameters" and does NOT launch the workflow. (See the allowlist above.)
4. **DO NOT modify `assets/workflow.js`** before launching. If you need to tweak it, copy it elsewhere first and point `scriptPath` at the copy.
5. **DO NOT call Workflow without `domainGroups`.** The script throws immediately with `args.domainGroups must be a non-empty array`. Run Phase 1 first.
6. **DO NOT poll after launching.** The workflow runs in the background and emits a `<task-notification>` when complete. Continue with other work or respond to the user; do not loop on `/workflows` or sleep waiting for it.
7. **Path quoting on Windows**: inside the JSON `args` and for `scriptPath`, paths must use `\\` (double backslash) or `/` (forward slash). A single `\` is a JSON escape character and will break parsing.
8. **If you see "Invalid tool parameters"**: the call did NOT launch. Re-issue with corrected shape. Do NOT assume a partial launch occurred. The "Running in background · Task ID..." line that appears AFTER an "Invalid tool parameters" is from your retry — the rejected call left no state behind.

#### Worked example — copy this shape exactly

If you have never invoked the Workflow tool before, this is the literal JSON the tool call expects. The `args` value is an object (curly braces), not a string.

```json
{
  "scriptPath": "C:/Users/<you>/.claude/skills/eclipse-db-review/assets/workflow.js",
  "args": {
    "repoRoot": "C:/Dev/Eclipse/Accounting/ibor-database/Tenant/Ibor",
    "excludePaths": ["Migrations", "BuildScripts", "DataScripts", "obj", "bin"],
    "reportPath": "C:/Dev/Eclipse/Accounting/ibor-database/docs/database-review.md",
    "domainGroups": [
      { "key": "lot",           "label": "Lot prefix chunk",           "focus": "Lot* tables, indexes, and procs" },
      { "key": "positionevent", "label": "PositionEvent prefix chunk", "focus": "PositionEvent, PositionState, EventState tables and procs" }
    ]
  }
}
```

If your tool-calling layer is forcing everything to strings, the workflow now tolerates a stringified `args` (and stringified `domainGroups` / `excludePaths`) as a fallback. But the supported shape is real objects/arrays — fix the caller if it keeps stringifying.

#### What success looks like

The Workflow tool returns immediately with something like:

```
Workflow launched in background. Task ID: w12345abc
Run ID: wf_abcdef-123
Script file: <path>.js
```

You should respond to the user with a one-liner: "Launched the review (Task `w12345abc`). Will report back when it completes — usually 30-60 minutes." Then stop. Do not call Workflow again, do not poll.

### Phase 2: Inventories (parallel single-shot agents)

Three structured inventory agents run before the deep-dive so the report has hard counts and structural data, not "—" placeholders:

1. **Object counts** — Glob-and-count every table / index / proc / function / UDTT / FK file. Returns exact integers, plus the `_V2/_V3/_V6` version-suffix count and the count of entities with both `*Latest` and `*History` tables.
2. **Hot-path register** — names the 10-20 procs that drive the critical workload (SOD, MergeBulk fan-in, NAV/P&L, closeout, tenant init). Each entry: file, flow, call-shape, tables touched.
3. **Function inventory** — every UDF / TVF with kind (scalar / inline-tvf / multi-statement-tvf), return type, sample callers, and a smell rating.

These run in parallel and are independent of the chunked deep-dive — they feed Section 2 of the report directly.

### Phase 3: Chunked Deep-Dive Reviews (parallel fan-out)

The workflow fans out one Explore subagent per analysis chunk. The chunking is purely a parallelization technique — one agent can't reasonably review 500 procs. **Findings from these agents are NOT reported per-chunk.** They are pooled and routed into the matching review dimension by category. Each agent returns BOTH findings AND a structured inventory of its chunk's tables, columns, indexes, and procs:

1. Reads the table DDL, indexes, FKs, and all procs/functions for its slice (including any in `Generated/` folders — historical name only).
2. Maps the dominant query predicates per table to the existing index set, identifying sample callers per index.
3. Identifies failure modes per proc by examining `BEGIN CATCH`, `XACT_ABORT`, transaction scope, lock hints, and isolation assumptions.
4. Treats fleet-wide patterns specially — when the same defect recurs across many similarly-shaped procs, it's reported once with `patternScope='fleet-wide'` AND a complete `affectedFiles` list (not "53+" — the actual list).
5. Returns a structured findings list with a category that determines routing at synthesis time.
6. Returns a per-chunk inventory: every table (with column-level type/nullability/PK/identity/FK detail), every index (with key/include/filter/sample-callers/verdict), and every proc (with kind, version, has-XACT_ABORT, has-TRY/CATCH, cursor flag, smell tags). This data is aggregated across chunks and passed to the synthesis stage to write Sections 2.4 and 2.5.

### Phase 4: Cross-Cutting Reviews

In parallel with the chunked reviews, the workflow runs six cross-cutting agents — one per review dimension:

1. **Schema design & integrity** — table design, constraints, computed columns, identity hot spots, FK coverage and FK indexing.
2. **Data type choices & consistency** — same-logical-id divergence, money in FLOAT/REAL, NVARCHAR(MAX) abuse, DECIMAL precision, GUID clustered keys, PK/FK type mismatches.
3. **Index audit (forward + reverse + design)** — three lenses. Forward: hot predicate → matching index. Reverse: each index → its likely caller, rated `useful / marginal / useless`. Design: each index judged on its own merits (key column order, KEY vs INCLUDE, composite key order, INCLUDE size, FILTER, sort direction, uniqueness, FILLFACTOR, clustered choice).
4. **Stored proc / function cost smells (I/O, CPU)** — full sweep against an explicit cost-smell catalog.
5. **Anti-pattern sweep (full)** — full sweep against an explicit anti-pattern catalog.
6. **Concurrency, locking, MERGE/upsert races, SOD hot path** — the consistently-highest-severity dimension.

Each cross-cutting agent surfaces **issues from its catalog** plus **inconsistencies** — a divergence from the dominant pattern across the codebase is itself a finding. Findings from chunked deep-dive reviews (Phase 3) are routed into the matching dimension at synthesis time based on their category.

### Phase 5: Adversarial Verification

Every finding with severity `critical` or `high` gets an independent skeptic agent that:

1. Reads the cited files itself.
2. Defaults to refuted unless it can independently confirm both the evidence claim and the impact claim.
3. Looks for nearby mitigations — a covering index that the original agent missed, an isolation level that prevents the race, a comment explaining the choice.
4. Optionally refines severity (over-stated → high becomes medium; under-stated → medium becomes high).
5. Returns `{confirmed, reason, refinedSeverity}`.

In practice, ~50% of high/critical findings get refuted at this stage. Refuted findings are surfaced in **Section 4** so the reader can see what was challenged and why.

### Phase 6: Synthesis

The synthesis stage runs in parallel writers (markdown only, no JSON schema — schema-based synthesis previously failed at this scale):

1. **Executive Summary** — produces the prioritized risk table ranked by severity × blast radius.
2. **Overview & Object Inventory** — describes the database's role and inventories objects by TYPE (Tables, Indexes, Procs, Functions, UDTTs, FKs). Real integers from the Inventories phase land in the Count column.
3. **Hot-Path Register (2.1)** — written from the dedicated inventory agent's payload.
4. **Stored Procedure Inventory (2.2)** — distribution-by-kind table + top-15 most-cost-smelling procs, computed across the aggregated chunk inventories.
5. **Function Inventory (2.3)** — every UDF/TVF with kind, returns, callers, and smell rating.
6. **Column Dictionary (2.4)** — per-table column-by-column documentation for hot/notable tables only (`*Latest`, finding-cited, hot-path).
7. **Index Portfolio (2.5)** — per-table index breakdown for hot/notable tables, with sample callers and verdicts.
8. **Per-dimension Findings (3.1 .. 3.6)** — one agent per review dimension. Each receives every finding routed to that dimension (whether raised by a chunked deep-dive agent or a cross-cutting agent), dedupes, and writes the dimension's table. Fleet-wide findings emit their full `affectedFiles` enumeration as an indented bullet list under the row.
9. **Refuted Findings** and **Unknowns / Requires Verification** — written from the verification pass results.

The final report is written to `docs/database-review.md` (or the user-specified path) in a final Persist phase. The Persist phase splits the report at section dividers and at any H2-H5 heading, then writes each chunk to a numbered `.part-NNN` file via the Write tool. A stitcher agent runs `cat part-* > final && rm part-*` to assemble. This avoids the 16384-token per-agent output cap that would otherwise truncate large reports, and avoids fragile heredoc escaping in shell commands.

---

## Rules

1. **NEVER invent implementation details.** Every claim must reference a specific file (and line number when reasonably knowable). If the claim is `redundant index`, cite both index DDL files.
2. **NEVER guess intent.** If the purpose of a proc / index isn't clear from the code, mark as `[UNKNOWN: purpose not clear from code — needs team input]`.
3. **Use sub-agents** (Explore agent type) for parallel codebase investigation. The workflow embedded in this skill orchestrates them.
4. **Include file references for every finding.** Cite full repo-relative paths (e.g., `Tenant/Ibor/StoredProcedures/Foo_MergeBulk.sql:130`).
5. **Mark confidence levels:**
   - ✅ Verified from code
   - ⚠️ Inferred from context (explain reasoning in the cell)
   - ❓ Unknown / needs DMV or runtime verification
6. **Do NOT analyze migration scripts** for production behavior — migrations are point-in-time changes, not steady-state code. They can be used to *date* a finding but not to argue current behavior.
7. **Don't silently skip object types.** The Object Inventory must list every object type present in the repo. If a type has no findings, leave it in the inventory but say so.
8. **Cross-database interactions are out of scope.** Document only what the analyzed database does. If a proc references a linked server, note it but do not attempt to review the remote side.
9. **Challenge every inconsistency.** If two tables of similar role have different datatypes for the same logical id, two procs of similar shape have different `XACT_ABORT` settings, or two `_MergeBulk` versions diverge — mark as `[DISCREPANCY]` and ask the team to justify. Do NOT assume the inconsistency is intentional.
10. **No implicit defaults.** If a proc relies on the database default isolation level, the implicit `XACT_ABORT OFF`, the implicit `ROWLOCK` choice, or `HttpClient`-equivalent framework defaults — call it out explicitly. Relying on implicit behavior is a finding.
11. **Verify index coverage arithmetic.** For every flagged "missing index", confirm the predicate cannot be served by an existing index (including filtered or covering ones). If verification failed, mark as `❓` not as a positive finding.
12. **Adversarially verify every critical / high finding.** Do not ship the report without the verification phase. Refuted findings go to Section 4; confirmed findings go to the matching Section 3.x dimension.
13. **Prioritize for action.** The Executive Summary must rank by severity × blast radius, not enumerate every defect. Twelve to fifteen rows max.
14. **Question swallowed exceptions.** Every `BEGIN CATCH` that does not re-`THROW` is a data-loss candidate. State: what data is lost, who detects the loss, what the recovery is. If unknown, mark as `[DISCREPANCY: unacknowledged data loss]`.
15. **Verify idempotency for retried operations.** Any operation called from a retry policy or batched loop must be idempotent OR have receiver-side deduplication. If neither, flag as `[DISCREPANCY: retry without idempotency guarantee]`.
16. **Every finding row must include evidence and confidence.** Do not leave either blank. If no direct evidence, mark `❓` and state what is missing.
17. **Operational config is in scope.** Inspect database-level options (recovery model, isolation, snapshot) and SSDT settings as far as the repo encodes them — they shape every proc's behavior.
18. **Prefer effective values over declared defaults.** If a setting can be overridden by deployment or environment, document the precedence chain and only state the effective value when it is provable.
19. **Fleet-wide pattern findings must enumerate every affected file.** A defect repeated across every `*_FindLatest` or every `*_MergeBulk` proc affects every entity. Set `patternScope='fleet-wide'` AND populate `affectedFiles` with the COMPLETE matching list (Glob + Grep to find every match — line numbers when known). The `files` field carries the canonical 1-3 citations; `affectedFiles` carries the full fix-list. Never write "53+" or "8+" — that placeholder is unactionable. If you cannot enumerate the full set, downgrade to a single-file finding for the files you CAN cite, plus a discrepancyTag noting that broader scope is suspected but unverified.
20. **Versioned procedure sprawl is a finding by itself.** When `_V2` / `_V3` / `_V6` exist, document each version's divergence and ask whether older versions can be retired — undocumented version drift is silent behavior change.
21. **DMV-dependent claims must be marked `❓`.** "Redundant index" and "unused index" cannot be proven from DDL alone. Flag them as needing `sys.dm_db_index_usage_stats` confirmation.
22. **Refuted findings go to Section 4.** Do not silently drop them. The reader needs to see what was challenged so they can revisit if context changes.

---

## Workflow script

The workflow lives in a sibling file, **not inline**, because the script contains template literals, regex escapes, and unicode (✅ ⚠️ ❓) that round-trip badly through inline JSON encoding. Past launches that inlined the body produced parse errors at column offsets that did not correspond to anything in the source — a classic symptom of mid-flight string corruption.

**Path:** `assets/workflow.js`, sibling to this SKILL.md.

**How to launch:** call the Workflow tool with `scriptPath` pointing at that file. See **Phase 1.5** above for the exact tool call template, the pre-flight checklist, and the common-mistakes list.

**To inspect or modify the workflow:** open `assets/workflow.js` directly. It is plain JavaScript, no build step. The phases are: Domain reviews → Cross-cutting reviews → Adversarial verify → Synthesize → Persist. The two schemas (`FINDINGS_SCHEMA`, `VERDICT_SCHEMA`) are at the top of the file.
