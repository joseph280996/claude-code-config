# Introspecting the SentryOne GraphQL schema

Read this file when you hit a type, query, or input that isn't documented in
SKILL.md or `references/schema.md` — for example, when SentryOne adds a new
metric dimension or you need to understand a field that returns
`Unauthorized access!` (often a permission issue rather than a schema issue).

## Look up a single type

```graphql
{
  __type(name: "TypeName") {
    name
    kind
    fields {
      name
      type { name kind ofType { name kind ofType { name } } }
      args { name type { name kind ofType { name kind ofType { name } } } }
    }
    inputFields {
      name
      type { name kind ofType { name kind ofType { name } } }
    }
  }
}
```

The script wraps this:

```bash
python scripts/query_sentryone.py introspect --type Blocking
```

## List all root query fields

```graphql
{
  __schema {
    queryType {
      fields {
        name
        description
        args { name type { name kind ofType { name kind ofType { name } } } }
      }
    }
  }
}
```

Or via the script with no `--type` argument:

```bash
python scripts/query_sentryone.py introspect
```

## Why introspection is the right reflex

1. The on-prem build version drifts (currently `2026.1.1` running on Kestrel)
   and field availability changes between versions.
2. Some root queries (`blocking`, `deadlocks`, `alertLogFilter`) take no
   arguments themselves — their *sub-fields* take the request input. Without
   introspection it's hard to predict which sub-field accepts which request
   type.
3. Several inputs have non-obvious required fields (e.g. `offset` on
   `BlockChainRequest`/`DeadlockRequest`, `sortProperty` on
   `AlertlogFilterRequest`). Introspection makes "required" visible via
   `kind: NON_NULL`.

## When you get `Unauthorized access!`

Some fields exist in the schema but require elevated SentryOne permissions
(e.g. `queryAdvisory`, `queryOptimizationHistory`, `queriesCountInLast24Hrs`).
Introspection still shows them, but the query will fail at runtime. That's
not a bug — ask the SentryOne admin to grant your role the relevant feature.
