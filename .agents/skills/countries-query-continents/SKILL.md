---
name: countries-query-continents
description: POST /graphql operation
metadata:
  author: almyty
  generated: "true"
  toolId: "a3008f3b-3d7c-48ac-9394-0f85b76e8f50"
  version: "1.0.0"
---

# countries_query_continents

POST /graphql operation

## When to use

- POST /graphql operation
- POST requests to /graphql

## HTTP endpoint

```
POST https://countries.trevorblades.com/graphql/graphql
```

## GraphQL operation

This skill wraps a GraphQL operation. You must pass a `query` argument with the GraphQL document, and one flag per variable (the gateway packages them into the `variables` object server-side). Starting query:

```graphql
query continents($filter: ContinentFilterInput) {
  continents(filter: $filter) {
    code
    countries {
      __typename
    }
    name
  }
}
```

## Parameters

- `filter` (object): 

## Example

```bash
curl -X POST "https://countries.trevorblades.com/graphql/graphql" \
  -H "Content-Type: application/json" \
  -d '{"filter":{}}'
```

## Invocation

Recommended (fastest, ~50 ms startup): install the CLI once globally, then call directly.

```bash
npm i -g @almyty/skills   # one-time, skip if already installed
almyty-skills run fb-1776091040/countries/countries-query-continents
```

Or invoke with `npx` if a global install isn't available — slower (~1 s overhead per call, much more in sandboxes that scope per-session npm caches):

```bash
npx -y @almyty/skills run fb-1776091040/countries/countries-query-continents
```
