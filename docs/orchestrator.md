# Orchestrator

**Status: BUILT** (2026-09-10). Layer 6 of `docs/design/layers.md`.
Depends on Strategies and Routing. **Off by default.**

Something has to choose which strategy runs. Usually that is a person, in
configuration. The orchestrator is what chooses when you would rather it
were decided per request.

## Off by default, per agent, and the product is complete without it

There is no global switch and no environment variable. Orchestration is a
per-agent setting, stored on the agent itself at
`settings.execution.orchestrator` and merged over `ORCHESTRATOR_DEFAULTS`
(`enabled: false`). An agent that has never been given the setting has no
stored config at all, and `choose()` returns null for both cases — no
stored config, and a stored config with `enabled: false`. Null means the
run uses the configured static strategy without calling anything.

Set it under Agents → the agent → the **Execution** tab, in the
Orchestrator panel: an Enabled switch, and once it is on, the role that
decides, the timeout, the fallback strategy and the allowed strategy list.
The panel reads and writes `GET`/`PUT /agents/:agentId/execution`, whose
body carries `orchestrator` as the block above.

Every other layer works unchanged when it is off, which is the point: a
feature that decides things for you should be something you switch on, not
something you have to work around.

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

Every field below lives under `settings.execution.orchestrator` on the
agent. Anything left out falls back to the default in the second column.

| Setting | Default |
|---------|---------|
| `enabled` | `false` |
| `roleKey` | `orchestrator` |
| `timeoutMs` | `2000` |
| `fallbackStrategyKey` | `single` |
| `allowedStrategyKeys` | empty, meaning every strategy the organization can see |
