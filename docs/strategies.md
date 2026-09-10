# Strategies

**Status: BUILT** (2026-09-10). Layer 5 of `docs/design/layers.md`.
Depends on Roles.

A strategy is an execution shape over role slots.

## What a strategy is, and what it is not

It says **how** work is done: one call, a cascade from cheap to dear,
several candidates and a judge, explore then extract then patch.

It says nothing about **who** does it. A strategy that names a model is
broken, because every agent using it silently becomes tied to that vendor,
which is the thing roles exist to prevent.

That is enforced three times over, because the failure is silent:

1. `strategyModelViolations()` rejects a model key, a provider id, or a
   model-shaped value anywhere in the shape, and a role slot that is
   really a model name.
2. Tests assert every built-in is clean and that each disguise is caught.
3. The `strategies` table carries a CHECK constraint, so a direct write
   cannot smuggle one in either.

## The built-ins

| Key | Shape | Slots |
|-----|-------|-------|
| `single` | One call | `principal` |
| `cascade` | Cheap drafts, verifier checks, only a failure escalates | `drafter`, `verifier`, `principal` |
| `best_of_n` | N attempts, a judge picks | `principal`, `verifier` |
| `panel` | Three roles answer, consensus over the disagreement | three panelists |
| `explore_extract_patch` | Explore in parallel, compress to a brief, act on the brief | `explorer`, `summariser`, `principal`, `verifier` |

## Compiling

A strategy plus role bindings compiles to the pipeline the engine already
runs: `input`, `parallel`, `llm_call`, `extract_context`, `verify`,
`merge`, `output`.

**The engine does not change shape for strategies.** If a strategy needs
an executor change, the compiler is wrong. That constraint is what keeps
this layer from becoming a second execution model.

Compiled nodes carry `roleKey`, never a model, so a compiled graph is
exactly as portable as the strategy that produced it.

## Eject

Ejecting turns a strategy into an ordinary editable graph. It is
"compile, then save the result", and compilation is deterministic, which
is what makes it safe: an ejected graph cannot behave differently from the
strategy it came from, because it *is* what the strategy would have run.

## extract_context

Its own step, with its own cost, on purpose.

It reads prior rollout transcripts plus the task, makes one call on a role
slot, and puts a small structured brief into run context:

```json
{ "relevantFiles": [], "symbols": [], "callers": [], "tests": [], "notes": "" }
```

The saving in explore-extract-patch comes from the expensive role reading
a brief instead of every transcript. Folding the extraction into a
neighbouring step would hide what that compression cost, and then nobody
could tell whether the strategy was worth running.

The brief is schema-validated. A missing key is an error, **not** an empty
array: an empty brief reads as "nothing relevant was found" and would send
the expensive role in blind. Fences and surrounding prose are tolerated,
because models produce them and failing on that would be flaky for a
reason unrelated to the work.

## Cost and latency bands

`describe()` gives a picker what it needs: the slots a shape requires and
coarse cost and latency bands. The bands are coarse deliberately. A
precise number would be a lie, because the cost depends on which models
fill the slots and this layer does not know that.
