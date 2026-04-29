---
name: countries-query-continent
description: POST /graphql operation
metadata:
  author: almyty
  generated: "true"
  toolId: "95d453b2-b671-452a-9790-2bd7e4276a24"
  version: "1.0.0"
---

# countries_query_continent

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
query continent($code: ID!) {
  continent(code: $code) {
    code
    countries {
      __typename
    }
    name
  }
}
```

## Parameters

- `code` (string): 

## Example

```bash
curl -X POST "https://countries.trevorblades.com/graphql/graphql" \
  -H "Content-Type: application/json" \
  -d '{"code":"string"}'
```

## Invocation

Recommended (fastest, ~50 ms startup): install the CLI once globally, then call directly.

```bash
npm i -g @almyty/skills   # one-time, skip if already installed
almyty-skills run fb-1776091040/countries/countries-query-continent
```

Or invoke with `npx` if a global install isn't available — slower (~1 s overhead per call, much more in sandboxes that scope per-session npm caches):

```bash
npx -y @almyty/skills run fb-1776091040/countries/countries-query-continent
```
