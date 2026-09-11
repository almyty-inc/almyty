# Stub adapter (`stub`)

An in-memory provider with no network calls and no account anywhere. It
exists so the conformance suite, the reconcile loop and the router can be
exercised end to end, and so a new adapter has a reference for what
`ready`, `stopped`, `missing` and `orphaned` are supposed to look like.
Implementation:
`backend/src/modules/model-deployments/adapters/stub.adapter.ts`.

**It is not selectable outside tests.** The module registers it only
when `NODE_ENV` is not production, or when `MODEL_STUB_ADAPTER=true` is
set deliberately, so it does not appear as a deployment target for a
customer.

## Verified

Nothing to verify: there is no external product, no API, no docs URL and
no bill. This file exists so the per-adapter documentation set has no
gaps, and so nobody mistakes the stub for a provider we support.

## What the adapter does

Everything the interface requires, deterministically and from a `Map`:

- `deploy` creates an endpoint and returns immediately.
- `readEndpoint` reports the state the endpoint is in.
- `scale(0)` moves it to `stopped`; `scale(n > 0)` back to `ready`.
- `teardown` removes it, so a later read is `missing` and the reconcile
  loop's orphan path can be driven.
- `costSnapshot` accrues from a configured cents-per-hour.

Behaviour is driven by the request rather than by chance, so a test can
ask for a specific failure:

| Input | Result |
|-------|--------|
| an architecture outside `architectures` | refused before anything is created |
| credential `token` not equal to `'valid'` | `ADAPTER_AUTH` |
| `providerConfig.simulate = 'quota_exceeded'` | `ADAPTER_QUOTA_EXCEEDED` |
| `providerConfig.simulate = 'fail_ready'` | reaches `failed` instead of `ready` |

## Deltas from the spec

- **`registrySources` is `['hub', 's3', 'local']`**, wider than any real
  adapter, because the suite uses the stub to exercise the source-matching
  rules themselves.
- **No real timing.** Readiness is immediate; anything
  testing a slow rollout uses the fixture mode of a real adapter's
  conformance spec instead.

## Live suite

None, and there never will be one. `CONFORMANCE_LIVE=stub` is not a
thing.
