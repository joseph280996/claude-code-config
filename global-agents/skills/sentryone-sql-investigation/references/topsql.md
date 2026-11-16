# Top SQL Reference

Top SQL in SentryOne lives in two distinct places that answer different questions:

| Source | Endpoint | What it gives you | Coverage |
|---|---|---|---|
| Metrics system | GraphQL `target.metric(key: "sqlserver.topsql.*")` | Aggregates and time-series grouped by database / application / host / login | **Complete** — every query that ran, counted into per-minute buckets |
| Trace events | REST `POST /api/topSql/queryTraceEvents` | Per-execution rows with the actual SQL text | **Sampled** — only batches that breached the configured duration/CPU/reads threshold (~3s on Eclipse prod) |

Don't try to reconcile the totals between them — the metric counter is wall-clock-bucketed and the trace event's `cpu` is batch-cumulative. They will disagree.

## GraphQL Top SQL metrics

**Available metric keys.** All are accessed as `target.metric(key: "...")` on an `EventSourceConnection`.

| Dimension prefix | Has `instances` | Notes |
|---|---|---|
| `sqlserver.topsql.databases.*` | yes | Per database name |
| `sqlserver.topsql.applications.*` | yes | Per `ApplicationName` (pod name for k8s apps, `SQLAgent - TSQL JobStep …` for jobs) |
| `sqlserver.topsql.hosts.*` | yes | Per client hostname |
| `sqlserver.topsql.logins.*` | yes | Per SQL login |
| `sqlserver.topsql.resources.*` | no (overall) | `avgDuration, cpu, executions, logicalReads, logicalWrites, physicalReads` |
| `sqlserver.topsql.queries.*` | sometimes empty | `duration, cpu, executions, logicalReads, logicalWrites, physicalReads`. Defined in schema but instances are typically empty on the Eclipse deployment — use the REST endpoint for per-statement data instead |

**Measures (suffixes for the four instance-bearing dimensions):** `duration` (ms), `cpu` (ms), `executions` (count), `logicalReads` (pages), `physicalWrites` (pages), `waits` (ms).

### Aggregate (top-N over a window)

```graphql
target(moRef: "connection-545") { ... on EventSourceConnection {
  metric(key: "sqlserver.topsql.databases.duration") {
    aggregate(dateRange: { from: "2026-05-11T18:00:00Z", to: "2026-05-11T20:00:00Z" }) {
      instanceName value
    }
  }
} }
```

Returns `[{instanceName, value}, ...]` sorted by `value` desc. Default cardinality is top-10.

**Multi-measure in one round trip** — use GraphQL aliases:

```graphql
target(moRef: "connection-545") { ... on EventSourceConnection {
  dbDur:   metric(key: "sqlserver.topsql.databases.duration")     { aggregate(dateRange: $r) { instanceName value } }
  dbCpu:   metric(key: "sqlserver.topsql.databases.cpu")          { aggregate(dateRange: $r) { instanceName value } }
  dbReads: metric(key: "sqlserver.topsql.databases.logicalReads") { aggregate(dateRange: $r) { instanceName value } }
  appDur:  metric(key: "sqlserver.topsql.applications.duration")  { aggregate(dateRange: $r) { instanceName value } }
} }
```

### Time-series (stacked chart data)

```graphql
metric(key: "sqlserver.topsql.applications.cpu") {
  data(dateRange: $r, instances: ["Ibor-PublisherSvc-..."]) {
    instance interval
    points { timestamp value detail { category name value } }
  }
}
```

Omit `instances` to get the top-10 series.

This is exactly what backs the portal's **"CPU by Application over time"** stacked-area chart (and analogous charts for Database / Host / Login dimensions). The `detail { category name value }` array per point is the secondary breakdown the SPA renders in tooltips — for a `databases.cpu` point, `detail` lists the top apps inside that database at that minute. Observed: `detail` is typically empty for the `applications.*` dimension (the app *is* the leaf) and populated for `databases.* / hosts.* / logins.*`.

### Listing instances actually seen in a window

Useful for fan-out — you can pull "every app that consumed CPU in the last hour" without scanning the whole catalog:

```graphql
metric(key: "sqlserver.topsql.applications.cpu") {
  instances(dateRange: $r)
}
```

This is complete (metric-based, not sampled), so a quiet service that only ran sub-second queries still appears.

### Pod-name normalization

Kubernetes app names show up as `<service>-<replicaset-hash>-<pod-id>`. SentryOne treats each pod as a distinct app, so a service with many replicas is split across many `instanceName` values. Normalize by stripping the trailing `-<6-12 hex>-<4-6 alnum>` (pod-id then replicaset-hash) and the trailing `-<8+ hex>` single hash, then sum/group client-side.

### Input/output types

- `DateTimeRangeInput`: `{ from: DateTime!, to: DateTime! }` (NOT `startDateTime/endDateTime` — that shape is `HealthDateTimeRangeInput`)
- `MetricData`: `{ instance: String, interval: Duration!, points: [MetricPoint!]! }`
- `MetricPoint`: `{ timestamp: DateTime!, value: Float!, detail: [...] }`
- `AggregatedMetricData`: `{ instanceName: String, value: Decimal! }`

## Filter catalog (for both metrics and REST)

`topSqlFilterDataList` returns every database/app/host/login/SPID/error/eventClass SentryOne has recorded for a connection. Use it to:
- Build exclusion filters for the REST endpoint (which has no negative-filter semantics — see below)
- Discover all pod variants of a service before filtering by app

```graphql
topSqlFilterDataList {
  databaseNames(eventSourceConnectionID: 545)
  applicationNames(eventSourceConnectionID: 545)
  hostNames(eventSourceConnectionID: 545)
  loginNames(eventSourceConnectionID: 545)
  sPIDs(eventSourceConnectionID: 545)
}
```

## Per-statement Top SQL (REST endpoint)

The GraphQL metrics return aggregates only. The actual SQL text per execution comes from a REST endpoint that is **not part of the GraphQL schema and is undocumented** — discovered by reverse-engineering the SPA's network calls.

**Endpoint:** `POST /api/topSql/queryTraceEvents` (case-insensitive path), same headers as GraphQL.

### Body

```json
{
  "EventSourceConnectionId": 545,
  "StartDate": "2026-06-25T19:55:00.000Z",
  "EndDate":   "2026-06-25T20:10:00.000Z",
  "Limit": 50,
  "Offset": 0,
  "SortProperty": "duration",
  "SortIsDescending": true,
  "EventClasses": [], "HostNames": [], "ApplicationNames": [],
  "DatabaseNames": [], "LoginNames": [], "SPIDs": [], "Errors": [],
  "ParentTextMd5": "", "IsTraceStatement": false, "SearchKey": ""
}
```

### Sorting and filtering

- **`SortProperty`** accepts: `duration | cpu | reads | writes | startTime | endTime` (case-insensitive). Combine with `SortIsDescending`. Server applies the sort *before* `Limit`, so top-N is real top-N.
- **Empty filter arrays mean "no filter"** for that dimension. The endpoint has **no negative/exclusion semantics** — when the SPA user excludes a database in the UI, the SPA enumerates every other database via `topSqlFilterDataList.databaseNames` and sends that long positive list. Do the same.
- **Filter values are exact strings.** To filter by "SecurityMaster-Core" you must include every pod-suffixed variant. Discover them via `topSqlFilterDataList.applicationNames` first.

### Sampling threshold (important)

The trace-events endpoint only captures batches that **breached the SentryOne agent's configured duration / CPU / reads / writes threshold** on that server. On Eclipse prod this is effectively a ~3-second duration floor — nothing faster shows up, even at high aggregate cost. This means:

- *"High-CPU app with no Top SQL entries"* is a real, common pattern. It means death-by-a-thousand-fast-queries; use the metric chart, not this endpoint.
- The threshold is NOT readable through the API — it's only visible in the SentryOne desktop client's connection settings.

### Response shape

`{ "items": [...], "rowCount": N }`. Each item has 31 fields:

**Most useful:**
- `textData` — full SQL text. **Capped at 50,000 chars** by the server. Large batches (e.g. TVPs with thousands of values followed by `EXEC proc @p=...`) get truncated *before* the EXEC, so the proc name disappears. `IsTraceStatement: true` doesn't help — it returns the same batch text. No portal endpoint exposes the full text; the desktop SentryOne client is the only place to see it.
- `normalizedTextMd5` — stable hash for grouping repeated executions of the same parameterized statement; also the key for `topsql.totalsWaits` / `topsql.waitsByTrace`.
- `duration` — string `"HH:MM:SS.fff"` (NOT milliseconds — parse it).
- `cpu` (int ms), `reads`, `writes` (pages).
- `databaseName`, `applicationName`, `hostName`, `login`, `spid`.
- `startTime`, `endTime`.
- `hasPlan`, `hasStatements` — booleans hinting at drill-down data that exists in the desktop client but is NOT exposed by this Kestrel host (all `/api/topSql/getPlan`, `/api/topSql/getStatements/*` variants return 404).
- `grantedMemoryKB`, `requestedMemoryKB`, `tempdbInternalKB`, `tempdbUserKB`, `waitMS`.
