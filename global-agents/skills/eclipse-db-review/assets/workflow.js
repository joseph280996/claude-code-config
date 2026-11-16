export const meta = {
  name: 'db-review',
  description: 'Comprehensive review of a SQL Server / T-SQL codebase. Returns a ranked, verified, structured markdown report.',
  whenToUse: 'When the user asks to review/audit a T-SQL database project',
  phases: [
    { title: 'Chunked deep-dive reviews' },
    { title: 'Cross-cutting reviews' },
    { title: 'Adversarial verify' },
    { title: 'Synthesize' },
    { title: 'Persist' },
  ],
}

let _args = args
if (typeof _args === 'string') {
  try {
    _args = JSON.parse(_args)
    log('args was passed as a JSON string; parsed it. Next time, pass args as a real object.')
  } catch (e) {
    throw new Error(`args was a string but not valid JSON. Pass args as an object, not a stringified one. Parse error: ${e.message}`)
  }
}
if (!_args || typeof _args !== 'object' || Array.isArray(_args)) {
  throw new Error(`db-review workflow requires args to be an object: { repoRoot, excludePaths?, domainGroups, reportPath, inventory? }. Received: ${typeof args}${Array.isArray(args) ? ' (array)' : ''}`)
}
let { repoRoot, excludePaths = [], domainGroups, reportPath, inventory = null } = _args
if (typeof domainGroups === 'string') {
  try { domainGroups = JSON.parse(domainGroups) } catch (e) {
    throw new Error(`args.domainGroups was a string but not valid JSON. Pass it as a real array. Parse error: ${e.message}`)
  }
}
if (typeof excludePaths === 'string') {
  try { excludePaths = JSON.parse(excludePaths) } catch (e) {
    throw new Error(`args.excludePaths was a string but not valid JSON. Pass it as a real array. Parse error: ${e.message}`)
  }
}
if (!repoRoot) throw new Error('args.repoRoot is required (absolute path to the SQL root)')
if (!Array.isArray(domainGroups) || domainGroups.length === 0) {
  throw new Error('args.domainGroups must be a non-empty array of {key,label,focus}')
}
if (!reportPath) throw new Error('args.reportPath is required (absolute path where the .md report should be written)')

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'category', 'title', 'files', 'evidence', 'impact', 'recommendation', 'confidence'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string', enum: ['correctness', 'performance', 'concurrency', 'index', 'schema', 'anti-pattern', 'maintainability', 'security'] },
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative file paths with line numbers when known, e.g. "Tenant/Ibor/StoredProcedures/Foo.sql:130"' },
          evidence: { type: 'string', description: 'Exact code/DDL excerpt' },
          impact: { type: 'string', description: 'What goes wrong, under what data volume/concurrency' },
          recommendation: { type: 'string', description: 'Concrete fix' },
          confidence: { type: 'string', enum: ['verified', 'inferred', 'needs-verification'], description: 'verified=read directly in cited files; inferred=deduced from context; needs-verification=requires DMV/runtime data' },
          discrepancyTag: { type: 'string', description: 'If this finding represents a divergence from the dominant pattern in the codebase, the [DISCREPANCY: ...] tag, e.g. "[DISCREPANCY: missing XACT_ABORT in V2-V6]"' },
          patternScope: { type: 'string', enum: ['single', 'fleet-wide'], description: 'single = one site; fleet-wide = the same defect recurs across many similarly-shaped procs/files. Set fleet-wide ONLY when you can list all matching files in affectedFiles below.' },
          affectedFiles: { type: 'array', items: { type: 'string' }, description: 'For fleet-wide findings, list ALL matching files (with line numbers when known) — not just samples. Goal: a fleet-wide finding must be actionable as a fix-list. Use `files` for the canonical 1-3 citations and `affectedFiles` for the full enumeration.' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['confirmed', 'reason'],
  properties: {
    confirmed: { type: 'boolean' },
    reason: { type: 'string' },
    refinedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    refinedConfidence: { type: 'string', enum: ['verified', 'inferred', 'needs-verification'] },
  },
}

// Object-type counts produced by a one-shot Glob/count agent. Feeds Section 2.
const OBJECT_COUNTS_SCHEMA = {
  type: 'object',
  required: ['tables', 'indexes', 'storedProcedures', 'functions', 'userDefinedTableTypes', 'foreignKeys'],
  properties: {
    tables: { type: 'integer' },
    indexes: { type: 'integer' },
    storedProcedures: { type: 'integer' },
    functions: { type: 'integer' },
    userDefinedTableTypes: { type: 'integer' },
    foreignKeys: { type: 'integer' },
    views: { type: 'integer' },
    triggers: { type: 'integer' },
    procVersionSuffixes: { type: 'integer', description: 'count of files with a _V2/_V3/_V6 etc suffix' },
    latestHistoryPairs: { type: 'integer', description: 'count of distinct entities with both *Latest and *History tables' },
    notes: { type: 'string', description: 'one-line shape commentary per object type the writer should know' },
  },
}

// Hot-path register — the 10-20 procs that drive the critical workload.
const HOT_PATH_SCHEMA = {
  type: 'object',
  required: ['hotPath'],
  properties: {
    hotPath: {
      type: 'array',
      items: {
        type: 'object',
        required: ['proc', 'flow', 'callShape', 'tablesTouched'],
        properties: {
          proc: { type: 'string', description: 'repo-relative path to the proc file' },
          flow: { type: 'string', description: 'which flow this runs in: "SOD", "closeout", "MergeBulk", "report", "tenant-init", etc.' },
          callShape: { type: 'string', description: 'how it is invoked — "per-event", "per-batch", "once per portfolio per day", "once per tenant init", etc.' },
          tablesTouched: { type: 'array', items: { type: 'string' }, description: 'top 3-5 tables this proc reads or writes (without schema prefix is fine)' },
          version: { type: 'string', description: 'version suffix if any (V2/V3/...) or empty' },
          notes: { type: 'string' },
        },
      },
    },
  },
}

// Function inventory — every UDF / TVF.
const FUNCTION_INVENTORY_SCHEMA = {
  type: 'object',
  required: ['functions'],
  properties: {
    functions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'file', 'kind', 'returns'],
        properties: {
          name: { type: 'string' },
          file: { type: 'string', description: 'repo-relative path' },
          kind: { type: 'string', enum: ['scalar', 'inline-tvf', 'multi-statement-tvf', 'unknown'] },
          returns: { type: 'string', description: 'return type or table shape, short' },
          calledBy: { type: 'array', items: { type: 'string' }, description: 'sample of callers (procs/functions); leave empty if unknown' },
          smell: { type: 'string', description: 'short rating — empty if clean, otherwise the cost-smell category (e.g. "scalar UDF in WHERE — per-row CPU", "MS-TVF — fixed cardinality")' },
        },
      },
    },
  },
}

// Per-chunk inventory: tables + their columns + indexes + procs + functions.
// Domain agents emit this alongside their findings so we can build a full
// per-table column dictionary and a per-table index portfolio in synthesis.
const CHUNK_INVENTORY_SCHEMA = {
  type: 'object',
  required: ['tables', 'procs'],
  properties: {
    tables: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'file', 'columns'],
        properties: {
          name: { type: 'string', description: 'table name without schema prefix' },
          file: { type: 'string', description: 'repo-relative path to table DDL' },
          rowShape: { type: 'string', description: 'one-line shape — "Latest table for X", "History table for X", "reference data", "log/audit", "operational"' },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'type', 'nullable'],
              properties: {
                name: { type: 'string' },
                type: { type: 'string', description: 'datatype incl. precision/scale, e.g. "DECIMAL(28,10)" or "NVARCHAR(100)"' },
                nullable: { type: 'boolean' },
                isPk: { type: 'boolean' },
                isClustered: { type: 'boolean', description: 'true if part of clustered index' },
                isIdentity: { type: 'boolean' },
                isComputed: { type: 'boolean' },
                fkTo: { type: 'string', description: 'target if FK declared, else empty' },
                notes: { type: 'string' },
              },
            },
          },
          indexes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'file', 'kind', 'keyColumns'],
              properties: {
                name: { type: 'string' },
                file: { type: 'string' },
                kind: { type: 'string', enum: ['clustered', 'nonclustered', 'unique-clustered', 'unique-nonclustered', 'pk-clustered', 'pk-nonclustered', 'unknown'] },
                keyColumns: { type: 'array', items: { type: 'string' }, description: 'in order, with ASC/DESC suffix if specified' },
                includeColumns: { type: 'array', items: { type: 'string' } },
                filter: { type: 'string', description: 'WHERE clause if filtered, else empty' },
                isUnique: { type: 'boolean' },
                fillFactor: { type: 'integer' },
                callers: { type: 'array', items: { type: 'string' }, description: 'procs that plausibly use this index (sample), based on predicate matching against the leading-key shape' },
                verdict: { type: 'string', enum: ['useful', 'marginal', 'useless', 'redundant', 'design-defect', 'unknown'], description: 'set unknown unless you can defend the verdict from code' },
                verdictReason: { type: 'string' },
              },
            },
          },
        },
      },
    },
    procs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'file', 'kind'],
        properties: {
          name: { type: 'string' },
          file: { type: 'string' },
          kind: { type: 'string', description: 'shape — "MergeBulk", "MergeSelect", "Insert", "Update", "Delete", "Select", "SOD", "Find", "DeleteOrphan", or other inferred from the suffix' },
          version: { type: 'string', description: 'version suffix _V2/_V3/_V6 if any, else empty' },
          tablesWritten: { type: 'array', items: { type: 'string' } },
          tablesRead: { type: 'array', items: { type: 'string' } },
          hasTryCatch: { type: 'boolean' },
          hasXactAbort: { type: 'boolean' },
          usesCursor: { type: 'boolean' },
          statementCount: { type: 'integer', description: 'rough count of top-level DML statements (1-3 = small, 4-15 = medium, >15 = large)' },
          smells: { type: 'array', items: { type: 'string' }, description: 'short tags from the cost-smell or anti-pattern catalog if present' },
        },
      },
    },
  },
}

const excludeNote = excludePaths.length
  ? `\nIGNORE these subfolders (the user has excluded them): ${excludePaths.map(p => `\`${p}\``).join(', ')}.\n`
  : ''

const baseContext = `You are reviewing a SQL Server (T-SQL) database codebase as part of a multi-agent review. Output structured findings only — your text becomes a row in the final report, not a human-facing message.

REPO ROOT: ${repoRoot}
${excludeNote}
PRIMARY FOCUS AREAS (in priority order):
1. SCHEMA — table design, constraints, computed columns, identity hot spots, FK coverage, FK indexing, nullability intent.
2. DATA TYPES — same-logical-id datatype divergence across tables, money in FLOAT/REAL, NVARCHAR(MAX) where bounded works, DECIMAL precision/scale, GUID clustered keys, PK/FK type mismatches.
3. INDEXES — bidirectional audit: (a) does each hot predicate / join / order-by have a matching index with correct leading column? (b) for each existing index, which procs/queries actually use it? Rate useful / marginal / useless. Flag redundant indexes (prefix overlap), oversized INCLUDEs, missing filtered indexes.
4. STORED PROC / FUNCTION COST SMELLS — patterns that translate to I/O or CPU pain (catalog below).
5. ANTI-PATTERNS — correctness, safety, and legacy-syntax issues (catalog below).

Concurrency, locking, MERGE/upsert races, and SOD/bulk hot-path issues remain in scope — surface them when they appear.

Conventions you may see (verify by sampling):
- Tables, indexes, procs, and functions live in subfolders by object type.
- "Latest" tables hold current row state; "History" tables hold prior versions.
- "_SOD_" procs are start-of-day batch operations (very large data volumes, performance-sensitive).
- "_MergeBulk", "_MergeSelect" patterns are upserts from a UDTT.
- UDTTs in UserDefinedTableTypes/ are passed as table-valued parameters.
- Versioned procs (_V2, _V3, _V6) often coexist; treat divergence as a finding.
- Subfolders named "Generated/" exist for historical reasons but their contents are NOT generated anymore — treat every proc as hand-maintained code subject to the same review standards regardless of folder.

COST-SMELL CATALOG (proc/function performance — match by code shape):
- Scalar UDF invoked in WHERE / JOIN / SELECT (single-threaded plan pre-2019, per-row CPU)
- Multi-statement TVF joined in a query (cardinality estimate fixed at 100, then 1)
- Sort or aggregation with no supporting index (forces sort operator + spill risk)
- Wide UPDATE — updates columns whose values did not change (extra log + index maintenance)
- Implicit datatype conversion on indexed column (disables seek)
- Leading-wildcard LIKE on indexed column ('%foo')
- ISNULL / COALESCE / function call on indexed column inside WHERE/JOIN
- (@p IS NULL OR col = @p) "kitchen sink" filter without OPTION(RECOMPILE) or dynamic SQL
- Cursors / WHILE @@FETCH_STATUS = 0 doing per-row work that should be set-based
- Table variable holding >100 rows (no stats → nested-loop plan)
- Temp table created and immediately indexed BEFORE bulk insert when AFTER would be better (or vice versa)
- SELECT * in a production code path / view definition
- DISTINCT or UNION masking duplicate rows from a join (suggests join cardinality bug)
- MERGE source TVF read outside the MERGE's lock scope (breaks atomicity assumption)
- DML that fires triggers / cascades — write amplification not visible at the call site
- ORDER BY in a view / inline TVF (silently ignored, hides intent)

ANTI-PATTERN CATALOG (correctness, safety, legacy syntax — match by code shape):
- NOLOCK / READ UNCOMMITTED outside reporting/staging
- IF EXISTS (...) UPDATE ELSE INSERT upsert race
- MERGE used as a concurrent upsert without HOLDLOCK on target
- BEGIN CATCH that swallows the error (no THROW / RAISERROR re-raise) — data-loss candidate
- RAISERROR re-thrown after CATCH instead of THROW (loses error number, line, severity)
- Multi-statement DML proc with no SET XACT_ABORT ON
- Per-batch transaction inside a WHILE loop, called from a proc that LOOKS atomic (name implies one transaction)
- TOP without ORDER BY where order matters
- @@IDENTITY instead of SCOPE_IDENTITY
- Hardcoded WITH (INDEX(...)) plan-pinning hints
- DATEDIFF / DATEADD on indexed column inside WHERE (anti-sargable)
- SET ROWCOUNT to limit DML (deprecated)
- DELETE / UPDATE without WHERE in a non-truncate context
- 3-part-name cross-database access where a synonym or replicated copy would do
- Inconsistent CLUSTERED specification on PRIMARY KEY (defaults to nonclustered when other indexes exist)

OUTPUT REQUIREMENTS:
- Cite specific files and line numbers when knowable. Prefer repo-relative paths.
- Severity: critical = correctness/data-loss; high = major perf cliff or scaling problem; medium = meaningful perf or maintainability; low = nit.
- Confidence: verified (read directly in cited files), inferred (deduced from context, explain), needs-verification (requires DMV / Query Store / runtime data).
- discrepancyTag: populate ONLY when this finding represents divergence from a dominant pattern observed elsewhere — leave empty otherwise.
- Be concrete. Generic findings ("some indexes might be redundant") will be rejected.
- Limit to your top 8-15 findings. Better fewer, sharper.
- Treat every proc as hand-maintained code regardless of its folder ("Generated/" is a historical name, not a current property).
- FLEET-WIDE FINDINGS — when the SAME issue recurs across many similarly-named files (e.g. all *_FindLatest, all *_MergeBulk), report it ONCE with patternScope='fleet-wide' AND populate the affectedFiles array with the COMPLETE enumeration (every matching file with line number when known). The 'files' field carries the canonical 1-3 citations; 'affectedFiles' carries the full fix-list. NEVER report a fleet-wide finding with "8+" or "53+" — those numbers without a list are unactionable. If you can't enumerate them all, raise the finding only for the files you can cite and tag it patternScope='single' with a discrepancyTag noting potential broader scope.

SELF-CHECK BEFORE REPORTING (mandatory — refute rate on this skill is high when skipped):
- "Missing index" claims: Glob \`Indexes/**/*.sql\` for the table name, Read each matching file, confirm NO existing index covers the cited predicate (leading key match + INCLUDE coverage). If a covering index exists, drop the finding.
- "No XACT_ABORT" / "No transaction wrapper" / "No TRY/CATCH" claims: Read the cited proc from line 1 through the end of its preamble. Confirm the absence is real, not just absent from the cited line range.
- "Heap / clustered on wrong column" claims: Read the table DDL AND every Indexes/ file for that table — a non-clustered covering index may neutralize the impact you're claiming.
- "Datatype mismatch" / "implicit conversion" claims: Read both column DDLs from their actual table files.
- "Race condition" / "concurrent insert race" claims: confirm there is NO unique index on the natural key that would serialize the race; a unique index on the merge keys is itself the lock that prevents the race.
- "Returns whole table" / "missing WHERE clause" claims on TVFs: confirm the function body has no JOIN to a parameter or filter; account for inline-TVF predicate push-down.
- If ANY self-check fails or you cannot reach the file, downgrade confidence to needs-verification or drop the finding entirely.
`

const CROSS_CUTTING = [
  {
    key: 'schema-design',
    label: 'Schema design & integrity',
    prompt: `Audit Tables/ and ForeignKeys/. Per table, assess: PRIMARY KEY definition (clustered vs nonclustered, key choice — IDENTITY INT vs natural vs GUID; an explicit PRIMARY KEY NONCLUSTERED on a heap-with-clustered-index-elsewhere is fine, but PRIMARY KEY without CLUSTERED defaulting to nonclustered when no other clustered exists is a finding); CHECK constraint coverage for invariants the proc layer assumes; computed columns (PERSISTED vs not, used in indexes?); IDENTITY hot spots (single hot insertion point for high-throughput tables); referential integrity — every column that LOOKS like a foreign key either has an FK or has a justification; FK columns supported by an index on the child side (slow joins, slow cascade-delete); nullability that contradicts proc-layer assumptions (column NOT NULL but proc treats as nullable, or vice versa); unique constraints on natural keys (and whether NULLable columns silently allow duplicates because NULL != NULL); table-level options inconsistent with workload (ALLOW_PAGE_LOCKS = OFF on a heavily-updated table, FILLFACTOR on append-only IDENTITY clustered key). Cite the table DDL file and FK file when relevant.`,
  },
  {
    key: 'datatypes',
    label: 'Data type choices & consistency',
    prompt: `Audit Tables/ for datatype correctness and consistency across the codebase. Look for: same logical id used with different datatypes across tables (PortfolioId BIGINT in one table, INT in another — implicit conversion disables seeks); FLOAT or REAL holding monetary or quantity values (use DECIMAL); inconsistent DECIMAL(p,s) precision/scale for the same logical concept; NVARCHAR(MAX) / VARCHAR(MAX) where a bounded length would do (and would allow the column in indexes); GUIDs as the clustered key (page splits, fragmentation under inserts); DATETIME where DATETIME2 would be more precise and smaller; BIT columns being treated as TINYINT in callers; CHAR(n) vs VARCHAR(n) misuse; nullable PKs (impossible by definition for PK but check for "natural key" unique indexes that include NULLable columns). Build a "logical concept → datatypes seen" map for the top 8-12 cross-cutting concepts (PortfolioId, AccountId, ClientId, Quantity, Amount, etc.). Same id with two datatypes is ALWAYS a finding.`,
  },
  {
    key: 'index-audit',
    label: 'Index audit (forward + reverse + design)',
    prompt: `Three-lens audit of every Indexes/ definition.

FORWARD (does each hot predicate have a matching index?):
- Inventory the WHERE / JOIN / ORDER BY / GROUP BY shapes used across all procs (every proc is hand-maintained code regardless of folder; pay particular attention to high-traffic shapes like _FindLatest, _SelectHistory, _Select_ByFilter, _MergeBulk).
- For each hot predicate, identify whether an index supports it. Specifically: leading-key match (the index's first key column = the most selective equality predicate), INCLUDE coverage for projected columns, filter alignment for sparse predicates.
- Flag MISSING indexes when a hot predicate has no supporting index — would force scan on every call.

REVERSE (does each existing index have a caller?):
- For each index in Indexes/, identify which proc/query its leading-key shape could plausibly serve.
- Rate each: "useful" (clear caller, leading-key match), "marginal" (could serve a rare path, large overlap with another index), "useless" (no caller found, or fully prefix-redundant with another index). Mark useless/redundant findings with confidence=needs-verification — DMV sys.dm_db_index_usage_stats is required to confirm an index is unused.
- Flag redundant indexes (one is a strict prefix of another with similar INCLUDE).

DESIGN (is each index defined sensibly, regardless of who calls it?):
- KEY COLUMN ORDER — does the leading column have the highest selectivity for the dominant equality predicate? Flag indexes led by low-cardinality columns (BIT, status enum, IsDeleted, IsActioned, simple type discriminators) when a more selective column exists later in the key. "Index leads with a BIT column" is almost always wrong unless paired with a filter on that BIT.
- KEY vs INCLUDE placement — columns used in WHERE / JOIN / ORDER BY belong in the KEY; columns only projected in SELECT belong in INCLUDE. Flag columns in the key that are never filtered/sorted on, and columns in INCLUDE that are filtered/sorted on.
- COMPOSITE KEY ORDER for range queries — if the dominant query is "equality on A, range on B", the key should be (A, B). Flag the inverse.
- INCLUDE size — oversized INCLUDE lists (>5 wide columns, or LOB columns, or every column in the table) bloat the index to 50-100% of table size. Worth maintaining only if it covers many hot queries.
- FILTER predicate — for sparse columns (IsDeleted = 0, Status = 'Active', WHERE EndDate IS NULL on slowly-changing dimensions), a filtered index is dramatically smaller and faster. Flag missing filtered-index opportunities.
- SORT DIRECTION — if queries do ORDER BY col DESC, the index should declare col DESC; otherwise SQL Server may scan the index backwards or pick a different plan.
- UNIQUENESS — natural keys declared as non-unique allow silent duplicate inserts and disable some plan optimizations. Conversely, declaring UNIQUE on a key that allows NULLs gets "NULL != NULL" duplicate-NULL behavior.
- DATA_COMPRESSION / FILLFACTOR — flag inconsistency across indexes on the same table; flag FILLFACTOR < 100 on append-only IDENTITY clustered keys (wastes space).
- CLUSTERED choice on the table — is the clustered key the right choice? Random GUID, wide composite, low-selectivity leading column, or columns that are heavily updated all degrade clustered-index performance.

Output THREE finding clusters: missing-index (forward), useless/marginal-index (reverse), and design-defect (this lens). Cite both index DDL files when claiming redundancy. For each design defect, name the specific design rule it violates.`,
  },
  {
    key: 'proc-cost-smells',
    label: 'Stored proc / function cost smells (I/O, CPU)',
    prompt: `Sweep ALL procs and functions for cost smells listed in the COST-SMELL CATALOG above (including anything in "Generated/" folders — historical name only; treat every file as hand-maintained code). For each occurrence, identify which of: I/O-bound (extra logical reads, scan vs seek, sort/spill, write amplification), CPU-bound (scalar UDF per-row, function on indexed col, single-threaded plan), or PLAN-INSTABILITY (parameter sniffing, missing OPTION(RECOMPILE), kitchen-sink filter). Cite file:line. Prioritize hot-path procs (SOD, MergeBulk, FindLatest, anything called per-event).

Pay specific attention to:
- Sargability — function/CONVERT/ISNULL on the indexed column; (@p IS NULL OR col=@p) without RECOMPILE; LIKE '%x'.
- Cardinality estimation traps — multi-statement TVF in a join, table variable >100 rows, missing PK on UDTT.
- Write amplification — UPDATE that touches columns whose values did not change; cascades; trigger fan-out.
- Spill risk — sort/aggregation with no supporting index, large hash join with skewed key.

Top 12-15 worst offenders by blast radius. A pattern that recurs across 20 similarly-shaped procs (e.g. every *_FindLatest) is a higher-leverage finding than one bespoke proc — report the pattern once, citing a sample of affected files.`,
  },
  {
    key: 'antipatterns-sweep',
    label: 'Anti-pattern checklist sweep (full)',
    prompt: `Run a FULL SWEEP over EVERY proc (regardless of folder — "Generated/" is a historical name, all procs are hand-maintained code). Tick through the ANTI-PATTERN CATALOG above. For each match, report: the file, the line, the catalog entry it matches, and the impact at realistic scale.

Priority order — flag instances of these before the long tail:
1. CORRECTNESS / DATA LOSS: swallowed CATCH, RAISERROR re-raise (loses error number), missing XACT_ABORT in multi-statement DML, IF EXISTS upsert race, MERGE without HOLDLOCK as concurrent upsert, per-batch txn in WHILE loop in a proc whose name implies atomicity.
2. SAFETY: TOP without ORDER BY where ordering matters, @@IDENTITY instead of SCOPE_IDENTITY, hardcoded plan-pinning hints, DELETE/UPDATE missing WHERE in non-truncate context.
3. LEGACY SYNTAX: SET ROWCOUNT for DML, RAISERROR (legacy form), 3-part-name cross-DB access where synonym would do.

For repeating patterns: if the same anti-pattern appears across many similarly-shaped procs (e.g. every *_FindLatest, every *_MergeBulk), that is ONE finding describing the pattern. Set patternScope='fleet-wide' AND populate affectedFiles with the COMPLETE list of matching files (Glob + Grep to enumerate). The reader needs the actionable fix-list, not a "53+" placeholder.

Set discrepancyTag when an anti-pattern is present in some procs of a family but not others (one diverging proc is more interesting than 50 consistent ones).`,
  },
  {
    key: 'concurrency-safety',
    label: 'Concurrency, locking, MERGE/upsert races, SOD hot path',
    prompt: `Review concurrency safety across the codebase. Look for:
- Read-then-write upsert patterns missing UPDLOCK, HOLDLOCK on the existence check.
- MERGE statements used as concurrent upserts without HOLDLOCK on the target — two sessions can both miss the existence check and both INSERT.
- TVF / source read outside the MERGE's lock scope, breaking the atomicity assumption.
- Large DELETEs/UPDATEs without batching that will trigger lock escalation past the 5,000-lock threshold.
- Per-batch transactions in WHILE loops inside a proc whose name implies atomic behavior — the proc does NOT roll back as a unit.
- Long-running transactions blocking concurrent readers.
- Deadlock-prone access orderings — two procs touching tables in different orders.
- SOD / bulk hot path: index-aligned predicates, lock escalation risk, batched-resumability after mid-loop failure, XACT_ABORT + explicit transactions, minimal logging requirements.
- Missing unique index that would have serialized a race the merge logic is racing on.

Bulk procs (_SOD_, _MergeBulk, _DeleteOrphan, _Bulk) are the most likely offenders. Cite specific files and the racing scenario in the impact field.

CRITICAL — set category='concurrency' for EVERY finding you raise here. Do NOT use 'anti-pattern' or 'correctness' for HOLDLOCK gaps, MERGE-without-HOLDLOCK, IF-EXISTS-then-INSERT races, missing UPDLOCK, missing XACT_ABORT in DML, lock-escalation risk, deadlock-prone access ordering, or any race condition. The category field drives which dimension the finding lands in — wrong category = your finding shows up in 3.5 (anti-patterns) instead of 3.6 (concurrency).`,
  },
]

// Combined schema: each chunk agent returns BOTH findings AND inventory.
// Doing this in one agent saves a full read-pass per chunk vs. running
// separate inventory and findings agents.
const CHUNK_RESULT_SCHEMA = {
  type: 'object',
  required: ['summary', 'findings', 'inventory'],
  properties: {
    summary: FINDINGS_SCHEMA.properties.summary,
    findings: FINDINGS_SCHEMA.properties.findings,
    inventory: CHUNK_INVENTORY_SCHEMA,
  },
}

phase('Inventories')
// Three single-shot inventory agents run before the deep-dive so the report
// has hard counts and structural data, not "—" placeholders. Each one is
// tightly scoped and returns a structured payload.
const [objectCounts, hotPath, functionInventory] = await parallel([
  () => agent(
    `Inventory the SQL Server codebase under ${repoRoot}. Return EXACT integer counts.

Use Glob with FULLY RECURSIVE patterns. Every Glob below MUST use \`**/*.sql\` (not \`*.sql\`) so any \`Generated/\` subfolder, nested entity folders, and any deeper subtree are all counted. Verify by running Glob TWICE per folder: once at top level, once with \`**\`. If the recursive count is higher than the flat count, the recursive count is the right one.

- tables: \`${repoRoot}/Tables/**/*.sql\`
- indexes: \`${repoRoot}/Indexes/**/*.sql\`
- storedProcedures: \`${repoRoot}/StoredProcedures/**/*.sql\`
- functions: \`${repoRoot}/Functions/**/*.sql\` — this folder typically has a deep \`Generated/<EntityName>/\` subtree with 6 files per entity (Find/FindLatest/FindList/FindListLatest/SelectHistory/SelectLatest). Expect hundreds, not tens. If your count comes back below 50, you are missing the recursive subtree — re-Glob.
- userDefinedTableTypes: \`${repoRoot}/UserDefinedTableTypes/**/*.sql\`
- foreignKeys: \`${repoRoot}/ForeignKeys/**/*.sql\`
- views, triggers: 0 if no folder/content found
- procVersionSuffixes: count of proc files matching \`${repoRoot}/StoredProcedures/**/*_V[0-9]*.sql\`
- latestHistoryPairs: distinct entity prefixes with BOTH \`*Latest.sql\` and \`*History.sql\` under \`${repoRoot}/Tables/**\` (recursive)
- notes: one short line of qualitative shape commentary covering the dominant proc-family prefixes

\`Generated/\` subfolders count toward all of these — they are not separate folders to skip.${excludeNote}

SELF-CHECK before returning: if any count looks anomalously low (functions < 50, indexes < 30, procs < 100), assume you forgot to recurse — re-Glob with \`**\` and resubmit. Be exact. Do not estimate.`,
    { label: 'inventory:object-counts', phase: 'Inventories', schema: OBJECT_COUNTS_SCHEMA, agentType: 'Explore' }
  ),
  () => agent(
    `Identify the HOT-PATH PROCS in the SQL Server codebase under ${repoRoot} — the 10-20 procs that drive the critical workload (closeout, SOD, MergeBulk fan-in, NAV/P&L reporting, position-event processing, tenant init).

For each, return:
- proc: repo-relative file path
- flow: which flow it runs in ("SOD", "closeout", "MergeBulk", "report", "tenant-init", "delete/purge")
- callShape: how often / in what shape ("per-event", "per-batch via UDTT", "once per portfolio per day", "once per tenant init")
- tablesTouched: 3-5 tables read or written
- version: V2/V3/V6 if applicable
- notes: anything notable (cursor-driven, set-based, has-V2-replacement, etc.)

How to find them:
- procs whose names contain _SOD_, _MergeBulk, _MergeSelect, _DeleteAndLoad
- procs in NavProfitLoss_*, RateOfReturn_*, ClearClientData, FinalizedAllocation_*, Lot_Insert*, PositionEvent_*
- the largest proc files (Glob + size sort) usually qualify

Return 10-20 procs. Do NOT exhaustively list every MergeBulk — pick the highest-leverage ones.${excludeNote}`,
    { label: 'inventory:hot-path', phase: 'Inventories', schema: HOT_PATH_SCHEMA, agentType: 'Explore' }
  ),
  () => agent(
    `Inventory EVERY user-defined function in ${repoRoot}/Functions/** (recursively, including any \`Generated/\` subfolders — historical name only, treat as hand-maintained).

For each function file, Read it and return:
- name: function name (without schema prefix)
- file: repo-relative path
- kind: scalar | inline-tvf | multi-statement-tvf | unknown
  - scalar = \`RETURNS <scalar_type>\` followed by \`AS BEGIN ... RETURN ... END\`
  - inline-tvf = \`RETURNS TABLE AS RETURN (SELECT ...)\`
  - multi-statement-tvf = \`RETURNS @t TABLE (...) AS BEGIN ... INSERT @t ... RETURN END\`
- returns: short return-type description
- calledBy: SAMPLE of 1-3 procs that call this function (Grep the function name across StoredProcedures/). Leave empty array if no callers found.
- smell: short cost-smell rating — empty if clean. Examples:
  - "scalar UDF in WHERE/JOIN — per-row CPU, single-threaded plan pre-2019"
  - "MS-TVF — fixed cardinality 100 then 1, poor estimates"
  - "inline TVF — clean"
  - "scalar UDF — verify SQL Server 2019+ inlining"

Return EVERY function. This is a complete inventory, not a sample.${excludeNote}`,
    { label: 'inventory:functions', phase: 'Inventories', schema: FUNCTION_INVENTORY_SCHEMA, agentType: 'Explore' }
  ),
])

phase('Chunked deep-dive reviews')
// We split the codebase by entity prefix purely for PARALLELISM — one agent
// can't read 500 procs. Each agent reviews its slice and returns findings AND
// an inventory of the tables/procs in its slice (so the report has a per-table
// column dictionary and an index portfolio with caller mapping).
// Findings are pooled and routed by category into the cross-cutting dimensions
// at synthesis time. The slice is NOT a "subsystem" and does NOT get its own
// section in the report.
const domainResults = await parallel(
  domainGroups.map(d => () =>
    agent(
      `${baseContext}

YOUR ANALYSIS CHUNK: ${d.label}
SCOPE: ${d.focus}

This chunk is purely a parallelization slice — your findings will be pooled with every other agent's and routed into the appropriate review dimension (schema, datatypes, indexes, proc cost, anti-patterns, concurrency) at synthesis time. Do NOT frame findings as "issues with the X subsystem" — frame them as concrete defects with file:line citations and a clear category.

Use Glob/Grep/Read under ${repoRoot}. Read the table DDL, indexes, FKs, procs, and functions for this slice — including anything in "Generated/" subfolders (those are historical names; the contents are hand-maintained code subject to the same review standards).

You return TWO things:

1) findings — top 10-15 findings (same as before). Set confidence honestly — needs-verification is a valid choice. The category field MUST be set correctly — it determines which dimension your finding gets routed to. If a defect appears across many similarly-shaped procs, set patternScope='fleet-wide' AND populate affectedFiles with the COMPLETE list of matching files (not a sample) — fleet-wide findings without an enumerated fix-list are useless.

2) inventory — a structured snapshot of THIS CHUNK's surface. The synthesis stage uses this to build:
   - a per-table column dictionary (columns, types, nullability, FKs, identity/computed flags)
   - a per-table index portfolio (every index's keys, INCLUDEs, filter, callers, verdict)
   - a proc inventory (kind, version, has-XACT_ABORT, has-TRY/CATCH, cursor flag, statement count, smells)

   Inventory rules:
   - Include EVERY table, EVERY index, EVERY proc in this chunk's scope. Do not sample.
   - For each index, attempt to identify 1-3 callers by Grep'ing the table name across StoredProcedures/ and matching the index's leading-key shape against proc predicates. If you cannot identify a caller, leave callers empty and set verdict='unknown'.
   - For each proc, set hasTryCatch / hasXactAbort by reading the file's preamble. Set usesCursor=true if you see DECLARE CURSOR or WHILE @@FETCH_STATUS. statementCount can be approximate (1-3 / 4-15 / >15 buckets).
   - smells: tag from the catalog above (e.g. "scalar-udf-in-where", "merge-no-holdlock", "raiserror-rethrow", "missing-xact-abort", "cursor-merge"). Empty array means clean.

Return both — the workflow needs both to write a useful report.`,
      { label: `domain:${d.key}`, phase: 'Chunked deep-dive reviews', schema: CHUNK_RESULT_SCHEMA, agentType: 'Explore' }
    ).then(r => r ? { ...r, _source: `domain:${d.key}` } : null)
  )
)

phase('Cross-cutting reviews')
const crossResults = await parallel(
  CROSS_CUTTING.map(c => () =>
    agent(
      `${baseContext}

YOUR DIMENSION: ${c.label}
${c.prompt}

Use Glob/Grep/Read across ${repoRoot}. Cross-cutting reviews can span all subsystems. Cite files. Top 10-15 findings.`,
      { label: `cross:${c.key}`, phase: 'Cross-cutting reviews', schema: FINDINGS_SCHEMA, agentType: 'Explore' }
    ).then(r => r ? { ...r, _source: `cross:${c.key}` } : null)
  )
)

const allRaw = [...domainResults, ...crossResults].filter(Boolean)
const allFindings = allRaw.flatMap(r => (r.findings || []).map(f => ({ ...f, _source: r._source || 'unknown' })))

// Aggregate inventories across chunks. Each domain agent emits its slice of
// tables/procs; concat them into a single global inventory the synthesis
// stage uses to write the column dictionary, index portfolio, and proc
// inventory sections. Dedupe by file path — the same table SHOULD only
// appear in one chunk, but if a chunk boundary doubled it up, last-write-wins.
const chunkTables = []
const chunkProcs = []
const seenTables = new Set()
const seenProcs = new Set()
for (const r of domainResults.filter(Boolean)) {
  const inv = r.inventory || {}
  for (const t of (inv.tables || [])) {
    const key = (t.file || t.name || '').toLowerCase()
    if (key && !seenTables.has(key)) { seenTables.add(key); chunkTables.push(t) }
  }
  for (const p of (inv.procs || [])) {
    const key = (p.file || p.name || '').toLowerCase()
    if (key && !seenProcs.has(key)) { seenProcs.add(key); chunkProcs.push(p) }
  }
}
log(`Aggregated inventory: ${chunkTables.length} tables, ${chunkProcs.length} procs from ${domainResults.filter(Boolean).length} chunks.`)

log(`Collected ${allFindings.length} raw findings. Verifying critical/high...`)

phase('Adversarial verify')
const toVerify = allFindings.filter(f => f.severity === 'critical' || f.severity === 'high')

const verified = await parallel(
  toVerify.map((f, i) => () =>
    agent(
      `You are an adversarial reviewer. A prior agent claimed the following finding about a SQL Server codebase. Your job is to REFUTE it. Default to refuted unless you can independently confirm both the evidence claim AND the impact claim from the cited files.

REPO ROOT: ${repoRoot}

CLAIMED FINDING #${i}:
- Title: ${f.title}
- Severity: ${f.severity}
- Category: ${f.category}
- Confidence: ${f.confidence}
- Files: ${(f.files || []).join(', ')}
- Evidence cited: ${f.evidence}
- Claimed impact: ${f.impact}
- Recommendation: ${f.recommendation}
${f.discrepancyTag ? '- Discrepancy tag: ' + f.discrepancyTag : ''}

VERIFICATION STEPS:
1. Read each cited file. Confirm the code matches the evidence claim verbatim.
2. Check whether mitigations exist nearby — a covering index that DOES serve the predicate, an isolation level that prevents the race, a comment explaining the choice, a deployment-level setting that overrides the apparent default.
3. Consider whether the impact materializes at realistic scale and concurrency. Vague impact claims should be refuted.
4. If severity seems wrong (over- or under-stated), set refinedSeverity.
5. If the original confidence was 'verified' but you cannot reproduce the evidence, refute.

Return confirmed=true ONLY if the issue is real, actionable, and the cited evidence reproduces. Otherwise return confirmed=false with a clear reason that cites files.`,
      { label: `verify:${f.title.slice(0, 40).replace(/[^\w]/g, '_')}`, phase: 'Adversarial verify', schema: VERDICT_SCHEMA, agentType: 'Explore' }
    ).then(v => ({ finding: f, verdict: v }))
  )
)

const confirmedHighCrit = verified.filter(Boolean).filter(v => v.verdict?.confirmed).map(v => ({
  ...v.finding,
  severity: v.verdict.refinedSeverity || v.finding.severity,
  confidence: v.verdict.refinedConfidence || v.finding.confidence,
  _verifiedReason: v.verdict.reason,
}))

const refuted = verified.filter(Boolean).filter(v => !v.verdict?.confirmed).map(v => ({
  title: v.finding.title,
  files: v.finding.files,
  category: v.finding.category,
  originalSeverity: v.finding.severity,
  reasonRefuted: v.verdict?.reason || 'no reason given',
}))

const mediumLow = allFindings.filter(f => f.severity === 'medium' || f.severity === 'low')

log(`Verified: ${confirmedHighCrit.length} confirmed, ${refuted.length} refuted, ${mediumLow.length} medium/low.`)

phase('Synthesize')

// Every writer agent gets this rubric. Prevents "I have enough context now,
// let me write the section." preambles from leaking into the final markdown.
const WRITER_RUBRIC = `WRITER RUBRIC (read carefully — your output IS the file body, not a message to a human):
- Output ONLY the markdown body for this section. No preamble. No "I will write…", no "Let me…", no "Now I'll…", no thinking-out-loud, no "Here is the section:".
- Do NOT add closing remarks or "Files referenced" lists at the end of the section.
- Do NOT wrap your output in code fences (no triple-backticks around the markdown).
- Start your first character with the heading specified by "Start your output with:" below. Anything before that heading will corrupt the report.
- If you have no content for a section (empty findings input), emit ONLY the section heading + a one-line note. Do NOT explain why you have nothing to write.
`

const trim = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : '')
const compact = f => ({
  severity: f.severity,
  category: f.category,
  title: f.title,
  files: (f.files || []).slice(0, 6),
  evidence: trim(f.evidence, 600),
  impact: trim(f.impact, 400),
  recommendation: trim(f.recommendation, 400),
  confidence: f.confidence,
  discrepancyTag: f.discrepancyTag,
  patternScope: f.patternScope || 'single',
  affectedFiles: (f.affectedFiles || []).slice(0, 60),
  source: f._source,
})

const bySource = (arr) => arr.reduce((acc, f) => {
  const k = (f._source || 'unknown')
  ;(acc[k] = acc[k] || []).push(compact(f))
  return acc
}, {})

const allConfirmed = [...confirmedHighCrit, ...mediumLow]
const allBySource = bySource(allConfirmed)
const domainBySource = bySource(allConfirmed.filter(f => (f._source || '').startsWith('domain:')))
const crossBySource = bySource(allConfirmed.filter(f => (f._source || '').startsWith('cross:')))

const confidenceIcon = (c) => c === 'verified' ? '✅ Verified from code' : c === 'inferred' ? '⚠️ Inferred from context' : '❓ Unknown / needs verification'

// SECTION 1+2: Overview + Object Inventory
// Real counts from the Inventories phase land here so Section 2 has integers,
// not "—" placeholders.
const objectCountsBlob = JSON.stringify(objectCounts || {}, null, 2)
const overviewPrompt = `You are writing the OVERVIEW and OBJECT INVENTORY sections of a database review report. Output MARKDOWN only.

${WRITER_RUBRIC}

REPO: ${repoRoot}
${inventory ? `\nDISCOVERED INVENTORY (from caller):\n${JSON.stringify(inventory, null, 2).slice(0, 4000)}\n` : ''}
OBJECT COUNTS (from a dedicated inventory agent — use these EXACT integers in the table):
${objectCountsBlob}

ANALYSIS CHUNKS USED FOR PARALLEL FAN-OUT (these are NOT subsystems — they are how we sliced the codebase for parallel review):
${JSON.stringify(domainGroups.map(d => ({ key: d.key, label: d.label, focus: trim(d.focus, 200) })), null, 2)}

Write two sections:

### 1. Overview
2-3 short paragraphs. Describe the database's role inferred from the object inventory and proc names, its top-level layout (Tables / Indexes / Procs / Functions / UDTTs / FKs), total object counts (use the OBJECT COUNTS above — quote the integers), and any notable conventions (version-suffix conventions like _V2, "Latest"/"History" table pairs — \`latestHistoryPairs\` count is in the inventory). Note: subfolders named "Generated/" are historical — their contents are hand-maintained code, not codegen output, and should not be characterized as "generated CRUD". DO NOT carve the database into "subsystems" — the database is a single artifact; the chunks above were used for parallel agent fan-out only.

### 2. Object Inventory
A markdown table organized by OBJECT TYPE, not by domain. Use the exact integers from OBJECT COUNTS in the Count column — DO NOT write "—".
| Object Type | Count | Notes |

One row per object type (Tables, Indexes, Stored Procedures, Functions, User-Defined Table Types, Foreign Keys, Views, Triggers). The Notes column captures the high-level shape:
- Tables: mention the \`latestHistoryPairs\` count and the dominant table-type pattern.
- Stored Procedures: mention the \`procVersionSuffixes\` count and the dominant proc-naming conventions (_MergeBulk, _SOD_, _FindLatest, _Insert, _Update, _Delete, _Select).
- Functions / UDTTs / FKs: shape commentary from the inventory's \`notes\` field.
- Do NOT label any procs as "generated CRUD" — the "Generated/" folder name is historical; its contents are hand-maintained.

If a count is 0 (e.g., views, triggers), still include the row with "0" and note "none observed".

Start your output with: ### 1. Overview
`

// SECTION 0: Executive Summary
const execSummaryPrompt = `You are writing the EXECUTIVE SUMMARY of a database review report. Output MARKDOWN only.

${WRITER_RUBRIC}

You have ${confirmedHighCrit.length} verified high/critical findings plus ${mediumLow.length} medium/low findings.

Write a single section:

## Executive Summary

A short prose paragraph (2-3 sentences) framing overall health.

Then a markdown table — 12-15 rows max — ranked by severity × blast radius:
| Risk | Severity | Category | Blast Radius | Why It Matters | Recommended Action | Evidence |

- **Risk**: short title (≤8 words)
- **Severity**: critical / high / medium
- **Category**: correctness / concurrency / performance / index / schema / anti-pattern / maintainability
- **Blast Radius**: how widely this affects the system — "Fleet-wide across all *_FindLatest procs", "All SOD runs", "Single proc", "All MERGE upserts", etc.
- **Why It Matters**: 1-2 sentences on impact
- **Recommended Action**: 1 sentence on the fix
- **Evidence**: \`file/path.sql\` with line number when known

DO NOT enumerate every defect — pick the 12-15 with the highest leverage. Pattern-wide issues (a defect repeated across many similarly-shaped procs) outrank single-file findings.

CONFIRMED HIGH/CRITICAL FINDINGS (full data):
${JSON.stringify(confirmedHighCrit.map(compact), null, 2).slice(0, 30000)}

MEDIUM/LOW (for context — surface only if a top-15 candidate):
${JSON.stringify(mediumLow.map(compact), null, 2).slice(0, 15000)}

Start your output with: ## Executive Summary
`

// SECTION 2.1: Hot-Path Register
const hotPathPrompt = `You are writing subsection 2.1 HOT-PATH REGISTER of a database review report. Output MARKDOWN only.

${WRITER_RUBRIC}

The hot-path register names the 10-20 procs that drive the critical workload — closeout, SOD, MergeBulk fan-in, NAV/P&L reporting, position-event processing, tenant init. Readers use it to know which procs to scrutinize first, and which findings have the largest blast radius.

Write:
#### 2.1 Hot-Path Register

A 1-2 sentence intro: "The following procs run on the critical workload. Findings against any of these affect every closeout / SOD / report run."

Then a markdown table:
| Proc | Flow | Call Shape | Tables Touched | Version | Notes |

Rules:
- One row per entry from the inventory below.
- "Tables Touched" — comma-separated list, max 5 tables.
- Cite the proc file in a code span.
- If \`version\` is empty, leave the cell blank.

INPUT (hot-path register from the inventory phase):
${JSON.stringify((hotPath && hotPath.hotPath) || [], null, 2).slice(0, 12000)}

If the input is empty, write: "No hot-path register was produced — the inventory agent could not identify critical procs."

Start your output with: #### 2.1 Hot-Path Register
`

// SECTION 2.2: Stored Procedure Inventory (compact, fleet-wide view)
// Two payloads. The "kind-distribution" table is aggregated from ALL procs
// (every kind, every transactional flag) — sent as a pre-computed counts
// summary so the writer doesn't burn tokens on a 500-row JSON. The "procs
// with smells" table is a pre-filtered list of procs with non-empty smells,
// ranked by smell count.
function procKindBucket(p) {
  const k = String(p.kind || '').toLowerCase()
  if (!k) return 'other'
  // The agent's `kind` field is freeform; bucket common shapes here.
  if (k.includes('mergebulk')) return 'MergeBulk'
  if (k.includes('mergeselect')) return 'MergeSelect'
  if (k === 'merge' || k.endsWith('_merge')) return 'Merge'
  if (k.includes('bulkinsert') || k.includes('insertbulk')) return 'BulkInsert'
  if (k.includes('updatebulk')) return 'UpdateBulk'
  if (k === 'insert') return 'Insert'
  if (k === 'update') return 'Update'
  if (k.includes('deleteorphan')) return 'DeleteOrphan'
  if (k.includes('deleteandload')) return 'DeleteAndLoad'
  if (k === 'delete') return 'Delete'
  if (k.includes('selectlatest')) return 'SelectLatest'
  if (k.includes('findlist')) return 'FindList'
  if (k.includes('findlatest')) return 'FindLatest'
  if (k === 'find') return 'Find'
  if (k === 'select') return 'Select'
  if (k.includes('filter')) return 'Filter'
  if (k.includes('sod')) return 'SOD'
  if (k.includes('enrich')) return 'EnrichAndInsert'
  return p.kind || 'Other'
}
const kindCounts = {}
for (const p of chunkProcs) {
  const b = procKindBucket(p)
  if (!kindCounts[b]) kindCounts[b] = { count: 0, hasTryCatch: 0, hasXactAbort: 0, usesCursor: 0, versionedCount: 0 }
  kindCounts[b].count++
  if (p.hasTryCatch) kindCounts[b].hasTryCatch++
  if (p.hasXactAbort) kindCounts[b].hasXactAbort++
  if (p.usesCursor) kindCounts[b].usesCursor++
  if (p.version && String(p.version).trim()) kindCounts[b].versionedCount++
}
const kindDistribution = Object.entries(kindCounts)
  .sort((a, b) => b[1].count - a[1].count)
  .map(([kind, c]) => ({ kind, ...c }))
const procsWithSmells = chunkProcs
  .filter(p => Array.isArray(p.smells) && p.smells.filter(s => s && String(s).trim()).length > 0)
  .map(p => ({
    name: p.name,
    file: p.file,
    kind: p.kind,
    version: p.version,
    hasTryCatch: p.hasTryCatch,
    hasXactAbort: p.hasXactAbort,
    usesCursor: p.usesCursor,
    statementCount: p.statementCount,
    smells: (p.smells || []).slice(0, 6),
  }))
  .sort((a, b) => (b.smells.length - a.smells.length) || ((b.statementCount || 0) - (a.statementCount || 0)))
const procInventoryBlob = JSON.stringify({
  totalProcs: chunkProcs.length,
  totalsAcrossAllProcs: {
    hasTryCatch: chunkProcs.filter(p => p.hasTryCatch).length,
    hasXactAbort: chunkProcs.filter(p => p.hasXactAbort).length,
    usesCursor: chunkProcs.filter(p => p.usesCursor).length,
    versioned: chunkProcs.filter(p => p.version && String(p.version).trim()).length,
  },
  kindDistribution,
  procsWithSmells,
}, null, 2).slice(0, 60000)

const procInventoryPrompt = `You are writing subsection 2.2 STORED PROCEDURE INVENTORY of a database review report. Output MARKDOWN only.

${WRITER_RUBRIC}

The proc inventory gives the reader a fleet-wide view of the procedure surface — distribution by kind, transactional safety coverage, cursor usage, and the procs carrying the most smells. Counts are pre-computed; you only render them. The per-proc table lists ONLY procs with at least one smell (clean procs are intentionally dropped to keep this section a fix-list).

Write:
#### 2.2 Stored Procedure Inventory

A 1-2 sentence intro framing what this section covers and stating that clean procs are not enumerated. Use the totals from the input to give a one-line headline (e.g. "X of Y procs set XACT_ABORT; Z use cursors.").

Then TWO tables:

(a) Distribution by KIND — render the pre-computed \`kindDistribution\` array verbatim:
| Kind | Count | Has TRY/CATCH | Has XACT_ABORT | Uses Cursor | Notes |

Render Has TRY/CATCH / Has XACT_ABORT / Uses Cursor as "N of count" (using each entry's count as the denominator). Notes is a one-liner — concentrations, version-suffix sprawl (use \`versionedCount\`), etc.

After the kind table, add a totals row using \`totalProcs\` and \`totalsAcrossAllProcs\` from the input.

(b) "Procs flagged with cost smells" — render \`procsWithSmells\` (already sorted by smell count descending). Cap at 15 rows; if there are more, add a one-line "(N additional procs with smells omitted)" note below the table.
| Proc | Kind | Statements | Smells |

Smells = comma-separated tags from the input.

Rules:
- DO NOT compute counts yourself — use the pre-computed integers in the input.
- DO NOT add rows for procs without smells; \`procsWithSmells\` already excludes them.
- Cite proc files in code spans for the second table.

INPUT (pre-aggregated proc summary; per-proc rows pre-filtered to procs with smells):
${procInventoryBlob}

If \`totalProcs\` is 0, write: "No proc inventory was returned by the chunked agents."

Start your output with: #### 2.2 Stored Procedure Inventory
`

// SECTION 2.3: Function Inventory — only functions with concerns + a one-line
// summary of the clean fleet.
const allFunctions = (functionInventory && functionInventory.functions) || []
function functionHasConcern(fn) {
  // Scalar UDFs always interesting (CPU/parallelism risk pre-2019 inlining).
  // Multi-statement TVFs always interesting (fixed cardinality estimate).
  // Anything with a non-empty smell is interesting regardless of kind.
  if (fn.kind === 'scalar') return true
  if (fn.kind === 'multi-statement-tvf') return true
  if (fn.smell && String(fn.smell).trim()) return true
  return false
}
const functionsToList = allFunctions.filter(functionHasConcern)
const cleanInlineTvfs = allFunctions.filter(fn => fn.kind === 'inline-tvf' && !(fn.smell && String(fn.smell).trim()))
const functionInventoryBlob = JSON.stringify(functionsToList, null, 2).slice(0, 30000)
const functionInventoryPrompt = `You are writing subsection 2.3 FUNCTION INVENTORY of a database review report. Output MARKDOWN only.

${WRITER_RUBRIC}

Functions are first-class in this review — scalar UDFs in WHERE/JOIN clauses are a top cost smell, and multi-statement TVFs corrupt cardinality estimates. Inline TVFs that are clean are NOT listed individually; they're summarized in a one-line note instead. The reader doesn't need a 200-row catalogue of \`*_FindLatest\` clones.

Write:
#### 2.3 Function Inventory

A 1-2 sentence intro that names the total count and how many were dropped as clean inline TVFs. Use this exact framing: "Listing scalar UDFs, multi-statement TVFs, and any function carrying a cost smell. **${cleanInlineTvfs.length} clean inline TVFs** (the generated \`*_FindLatest\` / \`*_SelectLatest\` / etc. fleet) are omitted — they inline cleanly into callers."

Then a markdown table — one row per function in the input:
| Function | Kind | Returns | Called By (sample) | Smell |

Rules:
- Cite the function file in a code span (use the \`file\` field).
- "Kind" — scalar / inline-tvf / multi-statement-tvf / unknown.
- "Called By (sample)" — up to 3 callers from the inventory. Truncate to 60 chars total per cell.
- "Smell" — the smell tag from the inventory. Every row in the input has either a non-empty smell OR is a scalar/MS-TVF (intrinsically smell-worthy); never blank.
- Order: scalar UDFs first (highest cost-smell risk), then MS-TVFs, then inline TVFs (only those with a smell), then unknown.
- DO NOT add rows for clean inline TVFs — those were intentionally dropped from the input.

INPUT (functions with concerns; clean inline TVFs already filtered out):
${functionInventoryBlob}

If the input is empty, write: "No functions carry cost smells — see Section 3.4 for any function-level concerns flagged by the proc cost agent."

Start your output with: #### 2.3 Function Inventory
`

// SECTION 2.4: Column Dictionary — tables WITH concerns only
// SECTION 2.5: Index Portfolio — tables WITH index concerns only
//
// Inventories are a fix-list, not a catalogue. A clean table with no findings
// is noise — drop it. We collect every file (table file or index file) that
// any confirmed finding references, then a table qualifies for 2.4 only if
// itself or one of its indexes is flagged.
const findingFiles = new Set() // every file path cited by a finding (lowercased, no line nums)
for (const f of allConfirmed) {
  const allCites = [...(f.files || []), ...(f.affectedFiles || [])]
  for (const cite of allCites) {
    const justFile = String(cite).split(':')[0].trim().toLowerCase().replace(/\\/g, '/')
    if (justFile) findingFiles.add(justFile)
  }
}
const findingFilesArr = Array.from(findingFiles)
function fileMatchesFinding(file) {
  if (!file) return false
  const norm = String(file).toLowerCase().replace(/\\/g, '/')
  if (findingFiles.has(norm)) return true
  // Findings frequently cite a partial path (e.g. "Tables/LotLatest.sql") while
  // the inventory carries a longer one ("Tenant/Ibor/Tables/LotLatest.sql").
  // Match on suffix in either direction.
  return findingFilesArr.some(ff => ff.endsWith(norm) || norm.endsWith(ff))
}
function tableHasConcerns(t) {
  if (fileMatchesFinding(t.file)) return true
  for (const idx of (t.indexes || [])) {
    if (fileMatchesFinding(idx.file)) return true
    if (idx.verdict && idx.verdict !== 'useful' && idx.verdict !== 'unknown') return true
  }
  return false
}
function tableHasIndexConcerns(t) {
  for (const idx of (t.indexes || [])) {
    if (fileMatchesFinding(idx.file)) return true
    if (idx.verdict && idx.verdict !== 'useful' && idx.verdict !== 'unknown') return true
  }
  return false
}
const tablesWithConcerns = chunkTables.filter(tableHasConcerns)
const tablesWithIndexConcerns = chunkTables.filter(tableHasIndexConcerns)
log(`Inventory filter: ${tablesWithConcerns.length}/${chunkTables.length} tables have concerns; ${tablesWithIndexConcerns.length} have index concerns. Clean tables are dropped from 2.4/2.5.`)
const compactTableForCols = t => ({
  name: t.name,
  file: t.file,
  rowShape: t.rowShape,
  columns: (t.columns || []).slice(0, 60).map(c => ({
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    isPk: c.isPk,
    isClustered: c.isClustered,
    isIdentity: c.isIdentity,
    isComputed: c.isComputed,
    fkTo: c.fkTo,
    notes: trim(c.notes, 80),
  })),
})
const compactTableForIdx = t => ({
  name: t.name,
  file: t.file,
  rowShape: t.rowShape,
  pkColumn: ((t.columns || []).find(c => c.isPk) || {}).name,
  clusteredColumns: (t.columns || []).filter(c => c.isClustered).map(c => c.name),
  indexes: (t.indexes || []).map(i => ({
    name: i.name,
    file: i.file,
    kind: i.kind,
    keyColumns: i.keyColumns,
    includeColumns: (i.includeColumns || []).slice(0, 12),
    filter: i.filter,
    isUnique: i.isUnique,
    fillFactor: i.fillFactor,
    callers: (i.callers || []).slice(0, 4),
    verdict: i.verdict,
    verdictReason: trim(i.verdictReason, 200),
  })),
})

const columnDictionaryBlob = JSON.stringify(tablesWithConcerns.map(compactTableForCols), null, 2).slice(0, 70000)
const columnDictionaryPrompt = `You are writing subsection 2.4 COLUMN DICTIONARY of a database review report. Output MARKDOWN only.

${WRITER_RUBRIC}

The column dictionary documents columns of tables WITH CONCERNS only — tables flagged in findings, or whose indexes are flagged. Clean tables are intentionally omitted; the reader doesn't need a catalogue, they need a fix-list.

Write:
#### 2.4 Column Dictionary (Tables with Concerns)

A 1-2 sentence intro: "Column-by-column documentation of tables referenced in findings. Clean tables are omitted — see the per-finding citations for everything not listed here."

Then ONE H5 subsection per table:
##### \`<schema_or_bare_name>\` — <one-line role/shape>
\`<table_file>:<line>\`

Followed by a markdown table:
| Column | Type | Null | PK | Identity / Computed | FK | Notes |

Where:
- "PK" is "✓" if the column is part of the primary key, blank otherwise.
- "Identity / Computed" combines: "IDENTITY" if isIdentity, "COMPUTED" if isComputed, blank otherwise.
- "FK" cites the target if fkTo is set, blank otherwise.
- "Notes" is short — divergence from siblings, reused logical concept, "deprecated", etc. Drop empty notes.

Rules:
- Group tables sensibly: by entity-family prefix (Lot*, PositionEvent*, FinalizedAllocation*, AccountEntry*, AccountBalance*, etc.).
- If a table has >40 columns, list only the columns that are interesting (PK, FK, computed, NOT NULL with default, anything called out in the table's notes). Add a one-line "<N> additional columns omitted for brevity" after the table.
- DROP a table from the dictionary if its inventory entry is missing columns or only contains the PK — note "(no column inventory available)" briefly under the heading instead.
- DROP a table entirely if its only "concern" is that it appears in a finding but no specific column-level detail is interesting — every retained table must have at least one row that informs a finding (datatype, nullability, FK gap, identity overflow risk, computed-column choice, etc.). When in doubt, drop.
- DO NOT invent column data. Use ONLY what's in the input.

INPUT (only tables that have at least one concern — clean tables already filtered out):
${columnDictionaryBlob}

If the input is empty, write: "No tables with column-level concerns — see Section 3 for finding-level table citations."

Start your output with: #### 2.4 Column Dictionary (Tables with Concerns)
`

const indexPortfolioBlob = JSON.stringify(tablesWithIndexConcerns.map(compactTableForIdx), null, 2).slice(0, 70000)
const indexPortfolioPrompt = `You are writing subsection 2.5 INDEX PORTFOLIO of a database review report. Output MARKDOWN only.

${WRITER_RUBRIC}

The index portfolio lists every index for tables that have at least one INDEX CONCERN — a flagged index, a non-useful verdict, or a table cited by an index finding. Clean tables (every index marked useful) are dropped to keep the report a fix-list, not a catalogue.

Write:
#### 2.5 Index Portfolio (Tables with Index Concerns)

A 1-2 sentence intro: "Indexes for tables flagged with at least one design-defect, redundancy, or coverage gap. Clean tables are omitted. Verdicts marked 'unknown' or 'useless' need DMV confirmation (\`sys.dm_db_index_usage_stats\`) before acting."

Then ONE H5 subsection per table:
##### \`<table>\` — <one-line role>
- **Clustered key:** \`<clustered columns>\` (PK column: \`<pkColumn>\`)
- **Indexes:** <count>

Followed by a markdown table:
| Index | KEY columns | INCLUDE | Filter | Unique | Sample Callers | Verdict | Reason |

Rules:
- "KEY columns" — comma-separated, with ASC/DESC if the input has it.
- "INCLUDE" — comma-separated, truncate to 60 chars per cell. If 0 INCLUDEs, leave blank.
- "Filter" — the WHERE clause if filtered, blank otherwise.
- "Sample Callers" — 1-3 procs from the input. If empty, write "—".
- "Verdict" — useful / marginal / useless / redundant / design-defect / unknown (from input).
- "Reason" — the input's verdictReason; truncate to 80 chars.
- For verdicts of "useless" or "redundant", append a "❓" icon to the verdict cell and add a Discrepancy line below the table noting that DMV verification is required.
- If a per-table block would contain ONLY 'useful' rows (no concerns surfaced at row level after all), drop the entire block — that table doesn't belong in this section.
- If the table has 0 indexes, list it with the heading and a one-line "(no indexes inventoried)" note instead of a table.

After ALL the tables, add a short "Cross-table notes" subsection:
- Indexes that look redundant ACROSS tables (same key shape on multiple tables, all unused).
- Indexes with oversized INCLUDEs (>10 columns).
- Indexes leading with a low-cardinality column (BIT, status enum, IsDeleted, IsActioned).
- Tables clustered on IDENTITY when reads are by natural key — a common codebase-wide pattern (cite specific cases).

INPUT (only tables with index concerns — clean tables already filtered out):
${indexPortfolioBlob}

If the input is empty, write: "No tables with index-level concerns — see the cross-cutting Index Audit (3.3) for index findings."

Start your output with: #### 2.5 Index Portfolio (Tables with Index Concerns)
`

const [execSummaryMd, overviewMd, hotPathMd, procInventoryMd, functionInventoryMd, columnDictionaryMd, indexPortfolioMd] = await parallel([
  () => agent(execSummaryPrompt, { label: 'synthesize:exec-summary', phase: 'Synthesize' }),
  () => agent(overviewPrompt, { label: 'synthesize:overview', phase: 'Synthesize' }),
  () => agent(hotPathPrompt, { label: 'synthesize:hot-path', phase: 'Synthesize' }),
  () => agent(procInventoryPrompt, { label: 'synthesize:proc-inventory', phase: 'Synthesize' }),
  () => agent(functionInventoryPrompt, { label: 'synthesize:function-inventory', phase: 'Synthesize' }),
  () => agent(columnDictionaryPrompt, { label: 'synthesize:column-dictionary', phase: 'Synthesize' }),
  () => agent(indexPortfolioPrompt, { label: 'synthesize:index-portfolio', phase: 'Synthesize' }),
])

// SECTION 3: Findings — one agent per dimension (3.1 .. 3.6). Aligned 1:1
// with CROSS_CUTTING above. Findings raised by domain fan-out agents are
// routed into the matching dimension by category (NOT displayed per-domain
// — the database is a single artifact, not a set of subsystems).
//
// Routing: each finding gets a `_routeKey` based on its category so domain
// findings join the appropriate dimension's input.
function routeKeyFromCategory(category) {
  switch (category) {
    case 'schema': return 'cross:schema-design'
    case 'concurrency': return 'cross:concurrency-safety'
    case 'index': return 'cross:index-audit'
    case 'performance': return 'cross:proc-cost-smells'
    case 'anti-pattern': return 'cross:antipatterns-sweep'
    case 'correctness': return 'cross:antipatterns-sweep'
    case 'maintainability': return 'cross:antipatterns-sweep'
    case 'security': return 'cross:antipatterns-sweep'
    default: return null
  }
}
// Datatype findings are a subset of schema findings flagged by keyword in title/evidence.
function isDatatypeFinding(f) {
  const blob = ((f.title || '') + ' ' + (f.evidence || '') + ' ' + (f.recommendation || '')).toLowerCase()
  return /\b(decimal|float|real|nvarchar|varchar|datetime|datetime2|guid|uniqueidentifier|datatype|data type|implicit conversion|precision|scale|tinyint|bigint)\b/.test(blob)
}
// Concurrency findings frequently arrive tagged as `anti-pattern` or `correctness`
// because the agents see HOLDLOCK/MERGE-race issues as anti-patterns first. Route
// them to 3.6 by content keywords so the concurrency dimension isn't empty.
function isConcurrencyFinding(f) {
  const blob = ((f.title || '') + ' ' + (f.evidence || '') + ' ' + (f.impact || '') + ' ' + (f.recommendation || '')).toLowerCase()
  return /\b(holdlock|updlock|rowlock|tablock|xlock|nolock|read uncommitted|isolation level|snapshot isolation|merge.{0,40}(without|missing|race|concurrent)|concurrent (insert|merge|upsert|race)|upsert race|race condition|deadlock|lock escalation|if exists.{0,30}(insert|update)|check.then.insert|read.then.write|atomicity|partial commit|xact_abort|sod hot path)\b/.test(blob)
}
const FINDINGS_SUBSECTIONS = [
  {
    id: '3.1',
    title: 'Schema Design & Integrity',
    sourceKeys: ['cross:schema-design'],
    headerRow: '| Table | PK Choice | Clustered Key | CHECK Constraints | Computed Cols | FK Coverage | FK Indexed? | Notes |',
    questions: [
      'Tables with PRIMARY KEY defaulting to NONCLUSTERED when no clustered index exists?',
      'Tables with random GUID or wide composite as the clustered key?',
      'Referential columns missing FK constraints, or FK columns lacking a supporting index?',
      'CHECK constraints absent for invariants the proc layer assumes?',
      'IDENTITY hot spots on high-throughput tables (single insertion bottleneck)?',
      'Computed columns used in indexes — PERSISTED?',
      'Nullability that contradicts proc-layer assumptions?',
      'Unique constraints on natural keys silently allowing duplicates because NULLable columns are members (NULL != NULL)?',
    ],
  },
  {
    id: '3.2',
    title: 'Data Type Choices & Consistency',
    sourceKeys: ['cross:datatypes'],
    headerRow: '| Logical Concept | Tables | Datatypes Seen | Nullability | Recommended Type | Source | Recommendation |',
    questions: [
      'Same logical id used with different datatypes across tables (implicit conversion disables seeks)?',
      'Monetary or quantity columns using FLOAT/REAL?',
      'Inconsistent DECIMAL(p,s) precision/scale for the same logical concept?',
      'NVARCHAR(MAX) / VARCHAR(MAX) where a bounded length would do?',
      'GUIDs as the clustered key (page splits, fragmentation)?',
      'DATETIME where DATETIME2 would be more precise and smaller?',
      'BIT columns being treated as TINYINT in callers (or vice versa)?',
      'PK / FK type mismatches?',
    ],
  },
  {
    id: '3.3',
    title: 'Index Audit (Forward + Reverse + Design)',
    sourceKeys: ['cross:index-audit'],
    headerRow: '| Lens | Table / Index | Hot Predicate / Caller / Defect | Match Quality | Status | Source | Recommendation |',
    questions: [
      'FORWARD: Hot predicates with no supporting index (forced scans)?',
      'FORWARD: Indexes whose leading key column does not match the dominant predicate?',
      'FORWARD: Sparse predicates that would benefit from a filtered index?',
      'REVERSE: Indexes with no caller / fully prefix-redundant with another index? (mark needs-verification — DMV required)',
      'DESIGN: Indexes led by low-cardinality columns (BIT, status enum, IsDeleted) when a more selective column exists?',
      'DESIGN: Columns in KEY that are never filtered/sorted, or columns in INCLUDE that are filtered/sorted?',
      'DESIGN: Composite key order wrong for range queries (range column ahead of equality column)?',
      'DESIGN: Oversized INCLUDE lists doubling the table size?',
      'DESIGN: Missing FILTER predicate on indexes targeting sparse columns?',
      'DESIGN: Sort direction mismatch with dominant ORDER BY?',
      'DESIGN: Uniqueness mis-declared (non-unique natural key, or UNIQUE allowing duplicate NULLs)?',
      'DESIGN: FILLFACTOR / DATA_COMPRESSION inconsistency or wrong for the workload?',
      'DESIGN: Clustered key choice — random GUID, wide composite, low-selectivity, or heavily-updated columns?',
    ],
  },
  {
    id: '3.4',
    title: 'Stored Proc / Function Cost Smells (I/O, CPU)',
    sourceKeys: ['cross:proc-cost-smells'],
    headerRow: '| Proc / Function | Smell | Bound (I/O / CPU / Plan) | Hot Path? | Files | Source | Recommendation |',
    questions: [
      'Scalar UDF invoked in WHERE / JOIN / SELECT (per-row CPU, single-threaded plan pre-2019)?',
      'Multi-statement TVF joined in a query (cardinality estimate fixed at 100 then 1)?',
      'Sort or aggregation with no supporting index (sort operator + spill risk)?',
      'Wide UPDATE — updates columns whose values did not change (extra log + index maintenance)?',
      'Implicit datatype conversion on indexed column?',
      'Leading-wildcard LIKE / function-on-indexed-column / ISNULL on indexed column?',
      '(@p IS NULL OR col = @p) "kitchen sink" filter without OPTION(RECOMPILE) or dynamic SQL?',
      'Cursors / WHILE @@FETCH_STATUS = 0 doing per-row work that should be set-based?',
      'Table variable holding >100 rows (no stats)?',
      'MERGE source TVF read outside the MERGE\'s lock scope (breaks atomicity)?',
      'DML that fires triggers / cascades — write amplification not visible at the call site?',
    ],
  },
  {
    id: '3.5',
    title: 'Anti-Pattern Sweep (Full)',
    sourceKeys: ['cross:antipatterns-sweep'],
    headerRow: '| Anti-Pattern | Severity | Occurrences | Sample Files | Discrepancy? | Source | Recommendation |',
    questions: [
      'Swallowed BEGIN CATCH blocks (data-loss candidates)?',
      'RAISERROR re-raise after CATCH instead of THROW (loses error number/severity)?',
      'Multi-statement DML procs missing SET XACT_ABORT ON?',
      'IF EXISTS-then-INSERT/UPDATE upsert race?',
      'MERGE used as a concurrent upsert without HOLDLOCK on target?',
      'Per-batch transaction inside a WHILE loop in a proc that LOOKS atomic?',
      'TOP without ORDER BY where ordering matters?',
      '@@IDENTITY instead of SCOPE_IDENTITY?',
      'Hardcoded WITH (INDEX(...)) plan-pinning hints?',
      'NOLOCK / READ UNCOMMITTED outside reporting/staging?',
      'SET ROWCOUNT for DML, DELETE/UPDATE missing WHERE in non-truncate context?',
      'Anti-pattern repeated across many similarly-shaped procs (fleet-wide, e.g. every *_FindLatest)?',
    ],
  },
  {
    id: '3.6',
    title: 'Concurrency, Locking, MERGE/Upsert Races, SOD Hot Path',
    sourceKeys: ['cross:concurrency-safety'],
    headerRow: '| Proc / Pattern | Risk | Lock Hints | XACT_ABORT? | Batched? | Atomic? | Source | Recommendation |',
    questions: [
      'Read-then-write upsert patterns missing UPDLOCK, HOLDLOCK on the existence check?',
      'MERGE statements used as concurrent upserts without HOLDLOCK on the target?',
      'TVF / source read outside MERGE\'s lock scope, breaking atomicity?',
      'Large DELETEs/UPDATEs without batching that will trigger lock escalation past 5,000-lock threshold?',
      'Per-batch transactions in WHILE loops in a proc whose name implies atomicity?',
      'Long-running transactions blocking concurrent readers?',
      'Deadlock-prone access orderings — two procs touching tables in different orders?',
      'SOD-path predicates not aligned with an existing index?',
      'Batched deletes resumable after mid-loop failure?',
      'Missing unique index that would have serialized a race the merge logic is racing on?',
    ],
  },
]

// Route every confirmed finding to a dimension. Cross-cutting agents target
// their dimension directly (sourceKeys match). Domain agents' findings get
// routed by the finding's `category` field — a `concurrency` finding from the
// "Lot subsystem" agent ends up in 3.6 alongside the cross-cutting concurrency
// findings, not in a separate Lot section.
function routeFinding(f) {
  // Concurrency-keyword override beats source/category alike — anti-pattern and
  // correctness agents routinely surface HOLDLOCK/MERGE-race issues that belong
  // in 3.6 even when they tagged the finding `anti-pattern`.
  if (isConcurrencyFinding(f)) return 'cross:concurrency-safety'
  if (f._source && f._source.startsWith('cross:')) return f._source
  // Domain finding: route by category, with datatype keyword bumping into 3.2.
  const fromCategory = routeKeyFromCategory(f.category)
  if (f.category === 'schema' && isDatatypeFinding(f)) return 'cross:datatypes'
  return fromCategory || 'cross:antipatterns-sweep'
}
const findingsAgents = FINDINGS_SUBSECTIONS.map(s => () => {
  const findingsBlob = allConfirmed
    .filter(f => s.sourceKeys.includes(routeFinding(f)))
    .map(compact)
  const prompt = [
    `You are writing subsection ${s.id} of the Findings section. Output MARKDOWN only.`,
    ``,
    WRITER_RUBRIC,
    ``,
    `#### ${s.id} ${s.title}`,
    ``,
    `Write:`,
    `1. A 1-2 sentence intro framing what this subsection covers.`,
    `2. The findings table:`,
    s.headerRow,
    `3. After the table, a "Discrepancies" subsection listing each [DISCREPANCY] inline. Format each as:`,
    `   - [DISCREPANCY] Brief description. Files: code-span paths. Question: Is this intentional? If so, document the justification.`,
    ``,
    `Questions this subsection should attempt to answer (only include those answered by the findings — do not pad):`,
    ...s.questions.map(q => `- ${q}`),
    ``,
    `Rules:`,
    `- Cite files in code spans with line numbers when available.`,
    `- DEDUPE — multiple agents may have flagged the same issue from different angles. Merge before writing.`,
    `- DROP findings without specific file citations.`,
    `- RANK rows: critical → high → medium → low.`,
    `- DO NOT invent findings. If no findings answer a question, omit it.`,
    `- If the input is empty, write a one-line "No findings in this dimension." note instead of a table.`,
    `- If >20 findings, keep the top 20 by severity × blast radius.`,
    `- FLEET-WIDE findings (\`patternScope: "fleet-wide"\`): in the row's "Sample Files" / "Files" cell, write the FIRST 3 files inline as code spans, then add an indented bullet-list directly underneath the table row enumerating EVERY entry in \`affectedFiles\` (one file per bullet, with line numbers when given). Never write "53+" or "8+" — use the actual list. If \`affectedFiles\` is missing or empty for a fleet-wide finding, downgrade it to a single-file finding for the cited file and add a Discrepancy noting the enumeration gap.`,
    ``,
    `INPUT FINDINGS (already verified — these are the findings routed to this dimension):`,
    JSON.stringify(findingsBlob, null, 2).slice(0, 60000),
    ``,
    `Start your output with: #### ${s.id} ${s.title}`,
  ].join('\n')
  return agent(prompt, { label: `synthesize:${s.id}`, phase: 'Synthesize' })
})

const findingsSections = await parallel(findingsAgents)

// SECTION 5: Refuted findings
const refutedPrompt = [
  `You are writing the REFUTED FINDINGS section of a database review report. Output MARKDOWN only.`,
  ``,
  WRITER_RUBRIC,
  ``,
  `Write:`,
  `### 4. Refuted Findings`,
  ``,
  `A 1-2 sentence intro: "The following findings were raised by review agents but refuted by adversarial verification. They are listed for transparency — future reviewers may want to revisit if context changes."`,
  ``,
  `Then a markdown table:`,
  `| Finding | Files | Reason Refuted | Reviewer Severity |`,
  ``,
  `Rules:`,
  `- One row per refuted finding.`,
  `- Truncate "Reason Refuted" to ~200 chars; readers can dig into the source if needed.`,
  `- Files in code spans, comma-separated.`,
  `- "Reviewer Severity" = the original severity claimed by the review agent.`,
  `- Group by category if there are more than 15 entries.`,
  ``,
  `If there are zero refuted findings, write: "No findings were refuted by the verification pass."`,
  ``,
  `REFUTED FINDINGS:`,
  JSON.stringify(refuted.map(r => ({
    title: r.title,
    files: (r.files || []).slice(0, 4),
    category: r.category,
    originalSeverity: r.originalSeverity,
    reasonRefuted: trim(r.reasonRefuted, 400),
  })), null, 2).slice(0, 25000),
  ``,
  `Start your output with: ### 4. Refuted Findings`,
].join('\n')

// SECTION 6: Unknowns / Requires Verification
const needsVerification = allConfirmed.filter(f => f.confidence === 'needs-verification' || f.confidence === 'inferred').map(compact)
const unknownsPrompt = [
  `You are writing the UNKNOWNS / REQUIRES VERIFICATION section of a database review report. Output MARKDOWN only.`,
  ``,
  WRITER_RUBRIC,
  ``,
  `### 5. Unknowns / Requires Verification`,
  ``,
  `Write a 1-2 sentence intro framing what this section is for: items that cannot be determined from code alone and need DMV data, runtime traces, actual data volume, or team input to confirm.`,
  ``,
  `Then a markdown checklist organized by what is needed to resolve:`,
  ``,
  `**DMV / Query Store data required:**`,
  `- [ ] Item with file reference`,
  ``,
  `**Production trace / Extended Events required:**`,
  `- [ ] Item`,
  ``,
  `**Actual data volume / distribution required:**`,
  `- [ ] Item`,
  ``,
  `**Team input required:**`,
  `- [ ] Item`,
  ``,
  `Rules:`,
  `- Each item is a one-line description with the file reference in a code span.`,
  `- Pull from confidence=needs-verification and confidence=inferred findings.`,
  `- Skip categories that have no items.`,
  `- If there are zero items, write: "All findings in this report are verified from code. No outstanding verification items."`,
  ``,
  `INPUT FINDINGS (those marked needs-verification or inferred):`,
  JSON.stringify(needsVerification, null, 2).slice(0, 25000),
  ``,
  `Start your output with: ### 5. Unknowns / Requires Verification`,
].join('\n')

const [refutedMd, unknownsMd] = await parallel([
  () => agent(refutedPrompt, { label: 'synthesize:refuted', phase: 'Synthesize' }),
  () => agent(unknownsPrompt, { label: 'synthesize:unknowns', phase: 'Synthesize' }),
])

// Assemble final report
const fullReport = [
  '# Database Review',
  '',
  `**Repo:** \`${repoRoot}\``,
  `**Generated by:** db-review skill`,
  '',
  '---',
  '',
  execSummaryMd,
  '',
  '---',
  '',
  overviewMd,
  '',
  hotPathMd,
  '',
  procInventoryMd,
  '',
  functionInventoryMd,
  '',
  columnDictionaryMd,
  '',
  indexPortfolioMd,
  '',
  '---',
  '',
  '### 3. Findings',
  '',
  ...findingsSections.filter(Boolean),
  '',
  '---',
  '',
  refutedMd,
  '',
  '---',
  '',
  unknownsMd,
].join('\n\n')

phase('Persist')
// Split the report at section dividers and write in chunks. The prior
// single-agent persist hit the 16384-token output cap when echoing large
// reports. Each chunk-write agent only emits "ok" so its output is tiny;
// the chunk content lives in the prompt (input tokens, much higher cap).
//
// We write each chunk to a numbered part-file via the Write tool (100%
// deterministic — no shell escaping), then a final stitcher agent concatenates
// the parts in order and removes them. This avoids heredoc escaping bugs that
// plagued earlier attempts to APPEND chunks via Bash.
// Each chunk's content is passed to the Write tool's `content` parameter,
// which counts toward the agent's output token budget (~16384 tokens / ~64KB).
// Keep chunks well under that ceiling — 10KB ≈ ~2500-3000 output tokens for
// typical English/markdown, leaving plenty of headroom for the Write tool_use
// envelope and the trailing "ok" reply.
const CHUNK_TARGET = 10000
// Split at section dividers AND at any heading (### / ####), in that order of
// preference. Section 3 (per-subsystem findings) is one big block bounded by
// `---` on the outside, so dividing only on `---` produces a single >60KB chunk
// that overruns the agent's 16K output-token cap when passed to Write.
function splitReport(md, target) {
  // Split on (in priority order): horizontal rules, then any H2-H5 heading.
  // The Column Dictionary and Index Portfolio sections (2.4 / 2.5) emit one
  // H5 per table and can grow to many tables — so H5 is a valid split point.
  const parts = md.split(/\n(?=---\n|#{2,5} )/)
  const chunks = []
  let buf = ''
  for (const p of parts) {
    if (buf && (buf.length + p.length + 1) > target) {
      chunks.push(buf)
      buf = p
    } else {
      buf = buf ? buf + '\n' + p : p
    }
  }
  if (buf) chunks.push(buf)
  // Hard guard: every chunk must fit in the agent output budget. If a single
  // section is still over the cap, fail loudly rather than silently truncate.
  const HARD_CAP = 50000
  for (const [i, c] of chunks.entries()) {
    if (c.length > HARD_CAP) {
      throw new Error(`Persist chunk ${i + 1} is ${c.length} bytes — exceeds ${HARD_CAP}-byte cap. Split the report further or raise the chunk count.`)
    }
  }
  return chunks
}
const chunks = splitReport(fullReport, CHUNK_TARGET)
const partPaths = chunks.map((_, i) => `${reportPath}.part-${String(i + 1).padStart(3, '0')}`)
log(`Persist: writing ${chunks.length} part files (max chunk: ${Math.max(...chunks.map(c => c.length))} bytes)`)

for (let i = 0; i < chunks.length; i++) {
  const result = await agent(
    [
      `Persist chunk ${i + 1}/${chunks.length} of a database review report.`,
      ``,
      `Use the Write tool to create a file at exactly this path:`,
      partPaths[i],
      ``,
      `Write the CONTENT below verbatim as the entire file body. Do not add a wrapper. Do not modify the content. Do not echo anything else.`,
      `After Write succeeds, return ONLY the string "ok".`,
      ``,
      `CONTENT:`,
      chunks[i],
    ].join('\n'),
    { label: `persist:chunk-${i + 1}` }
  )
  // Validate: agent errors are returned as the apiError text (workflow framework
  // does not throw on agent.apiError). If the result isn't a clean "ok",
  // something went wrong — stop the workflow rather than producing a corrupt file.
  const trimmed = (result || '').trim().toLowerCase()
  if (trimmed !== 'ok' && trimmed !== '"ok"') {
    throw new Error(
      `Persist chunk ${i + 1}/${chunks.length} failed. Expected "ok", got: ${JSON.stringify((result || '').slice(0, 300))}. ` +
      `Most likely cause: chunk content (${chunks[i].length} bytes) exceeded the agent's output-token budget when passed to the Write tool. Lower CHUNK_TARGET or split further.`
    )
  }
}

// Final stitcher: deterministic shell — no content templating, no escaping.
// Verify every part file exists and the final file is non-empty before declaring success.
const stitchResult = await agent(
  [
    `Stitch ${chunks.length} part files into the final report.`,
    ``,
    `Use the Bash tool to run EXACTLY these commands in order. Do not modify them.`,
    ``,
    `Step 1 — verify all ${chunks.length} part files exist (fail fast if any missing):`,
    `ls ${partPaths.map(p => `"${p}"`).join(' ')}`,
    ``,
    `Step 2 — concatenate parts in order:`,
    `cat ${partPaths.map(p => `"${p}"`).join(' ')} > "${reportPath}"`,
    ``,
    `Step 3 — verify the final file is non-empty:`,
    `wc -c "${reportPath}"`,
    ``,
    `Step 4 — remove the part files:`,
    `rm ${partPaths.map(p => `"${p}"`).join(' ')}`,
    ``,
    `Return ONLY the byte count from step 3 (a number followed by the path). No other text.`,
  ].join('\n'),
  { label: 'persist:stitch' }
)
const byteMatch = (stitchResult || '').match(/(\d+)/)
if (!byteMatch || parseInt(byteMatch[1], 10) < 1000) {
  throw new Error(
    `Persist stitch failed. Final report missing or too small. Stitcher returned: ${JSON.stringify((stitchResult || '').slice(0, 300))}`
  )
}

return {
  reportPath,
  stats: {
    rawFindings: allFindings.length,
    verifiedHighCritical: confirmedHighCrit.length,
    refuted: refuted.length,
    mediumLow: mediumLow.length,
    needsVerification: needsVerification.length,
  },
  refutedSample: refuted.slice(0, 20),
}
