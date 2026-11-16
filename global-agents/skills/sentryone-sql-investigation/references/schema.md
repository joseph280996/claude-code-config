# SentryOne GraphQL Schema Quick Reference

Read this file when you need field names or input shapes that aren't in the
proven query examples in SKILL.md. For anything else, prefer the introspection
recipe in `introspection.md`.

## Target type fields (Target interface)

`name`, `moRef` (scalar), `objectId`, `itemId`, `isWatched`,
`healthOverview { healthScore }`, `metric`, `metrics`, `parent`, `children`,
`features`, `storage`

## EventSourceConnection type fields (extends Target)

`name`, `moRef`, `objectId`, `itemId`, `isWatched`, `eventSourceConnectionType`,
`friendlyName`, `versionName`, `versionNumber`, `isClustered`, `accessLevel`,
`metric(key: ID!)`, `metrics`, `features`, `settings`, `storage`, `topsql`,
`healthOverview`, `parent` (Device), `children`

Access via:

```graphql
target(moRef: "connection-545") { ... on EventSourceConnection { ... } }
```

## BlockChainGroup fields

`id`, `databaseName`, `hostName`, `lastBatch`, `loginName`, `programName`,
`spid` (lowercase), `versions`

## DeadlockProcess fields

`processId`, `sPID` (capital PID — note the case difference from BlockChainGroup),
`sBID`, `eCID`, `clientApplication`, `hostName`, `loginName`, `databaseName`,
`databaseId`, `waitResource`, `waitTime`, `lockMode`, `transactionName`,
`lastBatchStartDateTime`, `lastBatchCompletedDateTime`,
`lastTransactionStartDateTime`, `isolationLevel`, `transactionCount`,
`deadlockPriority`, `taskPriority`, `logUsed`, `ownerId`, `transactionId`,
`lockTimeout`, `status`, `schedulerId`, `hostProcessId`, `inputBufferText`,
`executionStack`

## AlertLogResponse fields

`alertID`, `objectId`, `targetName`, `objectName`, `objectType`, `conditionId`,
`conditionName`, `alertConditionId`, `tags`, `severity` (enum: HIGH/MEDIUM/LOW),
`isResolved`, `conditionType`, `conditionDescription`, `duration`,
`durationInMilliseconds`, `status` (enum: COMPLETED/ACTIVE), `startDateTimeUtc`,
`endDateTimeUtc`, `objectTypeDisplayName`, `message`, `actionTypeName`,
`actionTypeID`, `contactName`, `contactId`

The `message` field is the most informative — it contains full details
including SQL text, job names, blocking chain SPIDs, durations, and machine
names.

## Metric/Top SQL types

- `DateTimeRangeInput`: `{ from: DateTime!, to: DateTime! }` (NOT
  `startDateTime`/`endDateTime` — that shape is used by `HealthDateTimeRangeInput`)
- `MetricData`: `{ instance: String, interval: Duration!, points: [MetricPoint!]! }`
- `MetricPoint`: `{ timestamp: DateTime!, value: Float! }`
- `AggregatedMetricData`: `{ instanceName: String, value: Decimal! }`

## Input type shapes

```text
BlockChainRequest: eventSourceConnectionId (Int!), startDate (DateTime!),
                   endDate (DateTime!), limit (Int!), offset (Int!),
                   filters (BlockChainRequestFilterInput),
                   orderBy (BlockingOrder)

DeadlockRequest: eventSourceConnectionId (Int!), startDate (DateTime!),
                 endDate (DateTime!), limit (Int!), offset (Int!)

AlertlogFilterRequest: startDateTimeUtc (DateTime!), endDateTimeUtc (DateTime!),
                       limit (Int!), offset (Int!), sortProperty (String!),
                       sortIsDescending (Boolean),
                       alertLogFilterOptions (AlertLogFilterOption)

AlertLogFilterOption: searchKey (String), severityFilter (Int),
                      serverFilter (ID), conditionTypeFilter (ID),
                      conditionFilter (ID), closeFilter (Int),
                      tagsFilter (String), targetFilter (String),
                      actionFilter (ID)

healthScoreHistoryRequest: objectId (Guid!),
                           dateTimeRangeUtc (HealthDateTimeRangeInput!)

HealthDateTimeRangeInput: startDateTime (DateTime!), endDateTime (DateTime!)
```

## Common alert condition names

- `SQL Server: Blocking SQL` (HIGH)
- `SQL Server: Blocking SQL: Duration Threshold Max` (MEDIUM)
- `SQL Server: Top SQL: Duration Threshold Max` (MEDIUM) — contains the SQL text
- `SQL Server Agent Job: Runtime Threshold Max` (MEDIUM) — contains job name and duration
- `[RealTick] High CPU` (LOW)
- `15% Free Space - Disk` (LOW)
- `Data File Growth_w_TempDB` (LOW)
