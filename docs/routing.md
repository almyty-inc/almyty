# Routing

**Status: BUILT** (2026-09-10). Layer 3 of `docs/design/layers.md`.
Depends on Models. Usable with no agent.

Given a requirement, choose a model. That is the whole job.

## Usable on its own

Routing does not need an agent, a role or a strategy. Post a policy and
get back what it would choose and what it would not:

```
POST /models/route-preview
{ "objective": "cheapest", "privacyTier": "private_cloud", "regions": ["eu-central"] }
```

```json
{
  "success": true,
  "data": {
    "candidates": [
      { "modelId": "...", "name": "Kimi K3", "vendorModelId": "kimi-k3",
        "providerType": "moonshot", "rationale": "cheapest ($1.80/M blended), rank 1",
        "blendedPricePerMTok": 1.8, "privacyTier": "private_cloud", "region": "eu-central" }
    ],
    "rejected": [ { "modelId": "...", "reason": "privacy tier too public" } ]
  }
}
```

The preview deliberately returns less than the router uses internally.
Planning resolves provider rows so a call can be made, and those rows
carry credentials, so the preview returns only what a person needs to read
the decision.

## The policy

| Field | Meaning |
|-------|---------|
| `objective` | `cheapest`, `fastest` or `pinned` |
| `privacyTier` | The most public tier this request may use |
| `regions` | Allowed regions; empty means any |
| `capabilities` | Each true flag must be present on the model |
| `fallbackChain` | An explicit order, which wins over the objective |
| `pinnedModel` | For `objective: pinned` |
| `budgetHeadroomCents` | Models priced above this per million are skipped |
| `connectionPreference` | Accounts or vendors to prefer, best first |

## Connection preference comes before cost

Which account runs a model is a commercial decision: committed cloud
spend, a negotiated contract, a direct vendor relationship. It is usually
made before anyone asks us to route anything, so cost ranking does not get
to overturn it.

Preference sorts the eligible pool into bands, and the objective ranks
**inside** a band rather than across bands. A dearer model on the account
you committed spend to beats a cheaper one somewhere else.

A provider the preference does not name is ranked after the ones it does,
**not excluded**. A preference says which account to prefer. The fallback
chain is where you say which to forbid.

## Every rejection carries a reason

`rejected` is not a count. Each entry names the model and why it did not
qualify, which is the answer to "why did it not pick that one" without
having to run anything.

## Honest limits

Three, stated because they bound what routing can be worth.

**The co-failure ceiling.** When every eligible model fails the same
request, no routing policy helps. That rate is the mathematical ceiling on
any routing gain, and it is measured rather than assumed: the nightly
co-failure job reports it as routing headroom. Without that number, work
on routing is unfalsifiable.

**Cascade overhead inside agent loops.** Trying a cheaper model first
saves money on the requests it handles and costs latency plus a wasted
call on the ones it does not. Inside a loop that runs many times, the
overhead compounds faster than the saving on a hard task. A cascade is
worth it when most attempts succeed cheaply, and not otherwise.

**Latency stacking.** Composing our routing with a provider-side router
means two routing decisions per request. Ours is deterministic and fast;
theirs is not ours to see. The route trace records their hop and marks its
cost opaque rather than reporting a number we cannot know.

## What routing does not do

It does not learn. Selection is deterministic and reads the same inputs
every time, which is what makes a rejection explainable. A learned router
is an explicit non-goal.
