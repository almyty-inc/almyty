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
| `explore_extract_patch` (experimental) | Explore in parallel, compress to a brief, act on the brief | `explorer`, `summariser`, `principal`, `verifier` |

## Compiling

A strategy plus role bindings compiles to the pipeline the engine already
runs: `input`, `parallel`, `llm_call`, `extract_context`, `verify`,
`condition`, `merge`, `output`.

**The engine does not change shape for strategies.** If a strategy needs
an executor change, the compiler is wrong. That constraint is what keeps
this layer from becoming a second execution model.

Compiled nodes carry `roleKey`, never a model, so a compiled graph is
exactly as portable as the strategy that produced it.

### A check is a branch

A `verify` step's `next` is its **failure** path, and the compiler emits
it as one: the check feeds a `condition` node reading its verdict, whose
false handle goes to the escalation and whose true handle goes straight to
the output. The engine already skips whatever hangs off the untaken
handle, so a passing check costs nothing past the check.

That branch is the whole of cascade. Compiled as an ordinary edge, the
escalation ran on every request — the expensive role was paid for each
time, and being the only leaf, its answer was the result even when the
draft had been fine.

An unreadable verdict takes the false handle, so "we could not tell"
escalates rather than passing an unchecked draft.

Because a condition branches exactly two ways, a verify step with a
failure path needs exactly one step to escalate to, and cannot itself be
replicated by a fan-out. Both are refused at compile time rather than
compiled into a graph the validator would reject later.

### What a check checks with

A `verify` node runs a panel of refute-only checkers, and a checker needs
a model. The strategy names a slot, so the compiled checker names the role
bound to that slot — the same answer `llm_call` and a judged `merge` give.
A checker list written into the step's params wins, for a shape that wants
to pin its own panel.

### Fan-out happens at compile time

A `parallel` step with `n` means "run what comes next n times over", and
the compiler makes that real by emitting n copies of each of the step's
**immediate** targets. Everything past those targets converges.

That rule is deliberately one step wide, because it is what both fan-out
shapes want: `best_of_n` becomes three candidates into one judge, and
`explore_extract_patch` becomes three rollouts into one extraction. If the
extraction replicated too, the strategy would defeat itself — its whole
point is one compression read by the expensive role instead of three
transcripts.

The copies are `<step>#1`, `<step>#2`, … and each carries
`strategyBranch`. They all name the same role: fan-out is n attempts on
one slot, not n different models.

Two shapes are refused rather than compiled into something surprising: a
replicated target that is also reached from another step (there would be
no telling which copy the other step feeds), and a `parallel` step whose
target is itself `parallel` — nested fan-out is not compiled, so give the
inner step its own `n`.

The engine's `parallel` node is a pass-through by design. It is the join
marker and the place a hand-drawn graph forks; it does not multiply
anything, which is exactly why the multiplication has to be compiled.

### The judged merges

`merge` with `best_of_n` or `consensus` needs a model to judge with, and
it takes one the same way an `llm_call` node does: the node's `roleKey`,
then a pinned `providerId`, then a routing policy, then the
organization's default. `judgeConfig` still pins a provider for a
hand-drawn graph.

`best_of_n` with one incoming branch returns it without paying for a
judging call — there is nothing to choose between.

`consensus` asks the judge for two things: how many branches agree on the
substance, and what that group says. It outputs

```json
{ "answer": "...", "agreement": 0.67, "consensusReached": true, "threshold": 0.5, "responses": 3 }
```

so a downstream `condition` node can branch on disagreement. That is what
`consensusThreshold` applies to. When the judge does not answer in the
asked-for shape, the answer is kept and `agreement` is `undefined` —
`consensusReached` is then false, because "we could not tell" must not
read as "they agreed".

## Eject

Ejecting turns a strategy into an ordinary editable graph. It is
"compile, then save the result", and compilation is deterministic, which
is what makes it safe: an ejected graph cannot behave differently from the
strategy it came from, because it *is* what the strategy would have run.

`POST /agents/:agentId/execution/eject` compiles the agent's **standing**
strategy — the one on its execution settings, not whatever an orchestrator
might pick for a particular request — writes the result to the agent's
pipeline, and clears `strategyKey`. Compiled nodes carry a `roleKey` and
never a model, so ejecting pins nothing: routing still fills each role at
run time.

Two refusals, both 4xx with a code:

- `PIPELINE_NOT_EMPTY` (409) when the agent already has a graph.
  Overwriting one somebody drew by hand is not recoverable from that
  screen, so it is refused rather than done quietly.
- `STRATEGY_NOT_COMPILABLE` (400) when the agent runs no strategy, when
  the strategy named on it no longer exists, or when a role slot the
  shape needs is unbound — the message names the missing slots.

The UI offers this as "Eject to an editable graph" on the Execution tab,
and lands you in the builder afterwards, because the agent you now have
is not the one the tab was describing.

## extract_context

Its own step, with its own cost, on purpose.

It reads prior rollout transcripts plus the task, makes one call on a role
slot, and puts a small structured brief into run context:

```json
{ "relevantFiles": [], "symbols": [], "callers": [], "tests": [], "notes": "" }
```

Explore-extract-patch exists so that the expensive role can read a brief
instead of every transcript. Whether that is *cheaper* is a separate
question, and the answer depends on your workload — see "Experimental"
below. Keeping extraction as its own step is what makes the question
answerable at all: fold it into a neighbouring step and the compression
cost disappears into someone else's line item, and then nobody can tell
whether the strategy was worth running.

The brief is schema-validated. A missing key is an error, **not** an empty
array: an empty brief reads as "nothing relevant was found" and would send
the expensive role in blind. Fences and surrounding prose are tolerated,
because models produce them and failing on that would be flaky for a
reason unrelated to the work.

A brief that does not validate fails the node, with the code
`EXTRACTED_CONTEXT_INVALID` and the model's raw answer attached. Falling
back to passing the transcripts through instead would look like a cheap
extraction on the cost line while handing the expensive role exactly the
context the step existed to spare it.

As a node in a hand-drawn graph, `extract_context` takes the same
provider, role and routing fields as `llm_call` — it goes through the same
call path, so a role is filled once for the run and a routed call is
attributed the same way — plus:

| field | default |
|---|---|
| `task` | the run input |
| `sources` | the outputs of the nodes with edges into this one |
| `instruction` | the built-in extraction instruction |

`task` and `sources` are template-resolved when given as strings. With no
`sources` and nothing upstream, the node fails rather than calling a model
with nothing to compress.

## Cost and latency bands

`describe()` gives a picker what it needs: the slots a shape requires and
coarse cost and latency bands. The bands are coarse deliberately. A
precise number would be a lie, because the cost depends on which models
fill the slots and this layer does not know that.

## Experimental: explore-extract-patch

`explore_extract_patch` is offered, and it is **not** claimed to save
money. The picker badges it experimental for that reason.

The arithmetic only works when two things hold at once:

1. the exploring model is roughly an order of magnitude cheaper than the
   principal, and
2. the principal call stays a single generation over a prepared brief,
   rather than running its own loop anyway.

Break either and it costs more than a single call. A small price ratio
means the rollouts are not free relative to what they save. A brief that
balloons the input hands the expensive model more tokens, not fewer. And
a principal that re-explores on its own has been paid for twice.

The published evidence does not settle it either. SWE-Bench Pro, the
benchmark this shape is usually argued from, is roughly 30% broken, and
its verifier runs about 8% false positives and 24% false negatives, so a
reported delta of a few points is inside the noise. Separately, models
that fail together fail on the same items: the co-failure floor caps how
much any multi-model shape can add, and `docs/routing.md` describes how
we measure that rather than assuming it away.

So what almyty ships here is the machinery and the measurement, not a
promise. Run it against your own traffic, read the all-model failure rate, and
keep it only if your numbers say so.
