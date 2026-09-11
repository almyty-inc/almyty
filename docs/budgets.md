# Budgets

**Status: BUILT** (2026-09-10). Cross-cutting, not a layer. See
`docs/design/layers.md`.

When to stop spending on a task, and why that decision was made.

## The policy

```json
{
  "ceilingPerRun": 200,
  "ceilingPerTask": 1000,
  "stopWhen": { "verifierPasses": true, "confidenceAbove": 0.9, "marginalGainBelow": 0.05 },
  "onExceed": "stop"
}
```

`onExceed` is `stop`, `degrade` or `ask`.

## Every decision records its projection

A verdict carries the numbers it was made from: spent so far, what the
next stage is projected to cost, and whatever stop signal applied.

This is the rule that matters. "It went over budget" explains nothing
afterwards if the estimate at the time is not recorded, and a run that
stopped for a reason nobody can reconstruct is a support ticket.

## Finishing beats running out

Stop rules are checked **before** the ceiling, deliberately.

A run that has already got what it needs stopped because it was finished,
not because the money ran out. Both might be true at once, and the
recorded reason should say which, because they lead to different actions:
one is the system working, the other is a budget set too low.

## Stopping early is the point

The saving in a cascade or a best-of-N comes from the attempts that do not
happen. `stopWhen.verifierPasses` is what turns "N attempts" into "as many
attempts as it took", and without it a strategy with a budget is just a
strategy that spends the whole budget.

## What is not decided here

How much a stage will cost is estimated by whoever executes it. This
consults the estimate; it does not produce one. And a cost that cannot be
known is never invented: see the opaque-hop rule in the route trace.
