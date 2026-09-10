# Orchestrator

**Status: BUILT** (2026-09-10). Layer 6 of `docs/design/layers.md`.
Depends on Strategies and Routing. **Off by default.**

Something has to choose which strategy runs. Usually that is a person, in
configuration. The orchestrator is what chooses when you would rather it
were decided per request.

## Off by default, and the product is complete without it

`ORCHESTRATOR_ENABLED` defaults to false. Disabled, it returns the
configured static strategy without calling anything. Every other layer
works unchanged, which is the point: a feature that decides things for you
should be something you switch on, not something you have to work around.

## How it decides

A small model on an `orchestrator` role receives the request, the
strategies as `describe()` gives them, and the roles available. It answers
with JSON:

```json
{ "strategy": "cascade", "roleBindings": { "drafter": "cheap", "verifier": "checker", "principal": "big" }, "reasoning": "small edit, verify before escalating" }
```

Strategies are **described, not dumped**. It picks a shape, so it gets
slots and cost bands. It has no business seeing the step graph.

## It cannot break a run

Every way it can misbehave ends in the same place: the configured fallback
strategy, carrying the reason.

| What happened | Result |
|---------------|--------|
| Did not answer within the timeout (2s default) | fallback |
| Answered unparseable text | fallback |
| Chose a strategy that does not exist | fallback |
| Chose one outside the allowed list | fallback |
| Left slots unbound | fallback |
| The provider threw | fallback |

A test asserts a run is never left without a strategy whatever the model
returns. An orchestrator that can break the product when it misbehaves is
worse than no orchestrator.

The reason is recorded, so a fallback is diagnosable rather than
mysterious.

## Depth is capped at one

No orchestrator choosing an orchestrator. Enforced in code, not in this
document, because the failure mode is unbounded cost rather than mild
confusion.

## It is budget-accounted

The decision costs a call. A cost that does not appear in the budget is a
cost nobody can see, so it is consulted like any other stage.

## Configuration

| Setting | Default |
|---------|---------|
| `enabled` | `false` |
| `roleKey` | `orchestrator` |
| `timeoutMs` | `2000` |
| `fallbackStrategyKey` | `single` |
| `allowedStrategyKeys` | empty, meaning every strategy the organization can see |
