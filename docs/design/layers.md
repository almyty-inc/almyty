# The six layers

Twenty-nine comments across `backend/src` cite this file — `L1` through
`L6`, and "cross-cutting" for the things that are not a layer. Each
citation is load-bearing: it is the short answer to "why is this check
*here* and not one level up". This file is the long answer.

Read it as a map of where a decision belongs, not as a call graph. The
layers are not modules and nothing enforces them at compile time; they
are the shape the module boundaries were drawn to follow.

## The stack, bottom up

| | | The question it answers |
|---|---|---|
| **L1** | Transport and egress | May this request leave, and to where? |
| **L2** | Vendors as data | What does this vendor's wire protocol look like? |
| **L3** | The catalog and the router | Given a policy, which models could serve this, in what order? |
| **L4** | Roles | Which concrete model fills each job, for this run? |
| **L5** | Strategies | How is the work done — how many calls, in what shape? |
| **L6** | The orchestrator | Which shape should this particular request use? |

Each layer may use the one below it and must not reach up. The two rules
that follow from that are the ones the comments keep invoking:

- **A pinned choice never routes.** If L4 resolved a role to a concrete
  model, L3 does not get a second opinion. Asking a router to "choose"
  between one candidate is still routing.
- **A strategy never changes the engine.** L5 compiles to nodes and edges
  the executor already runs. If a strategy needs an executor change, the
  compiler is wrong.

## L1 — Transport and egress

Where a request is allowed to go, and how it gets there safely.

This layer exists because every generic provider takes a user-supplied
base URL, so the gate has to sit *under* all of them rather than being
re-argued per consumer. `connections/egress-policy.ts` is the static
half: a per-organization allowlist, judging what a string can be known
by. A hostname is not known to be private until it resolves, so the
dynamic half is DNS pinning at request time in
`common/security/ssrf-safe-agent.ts`. Neither replaces the other.

The per-organization allowlist is also why the two install-wide
environment flags (`OLLAMA_ALLOW_PRIVATE_URLS`, `LLM_ALLOW_PRIVATE_URLS`)
are the blunt instrument and not the mechanism: switching one on to let
one team reach one internal endpoint opens every private range to every
organization on the install.

## L2 — Vendors as data

A vendor is a base URL, an auth header, a path, a listing shape and a
pricing source. That is a row, not a branch.

`llm-providers/provider-profile.ts` holds the profiles and
`agents/protocols/anthropic-messages.ts` the wire shapes. The reason this
is a layer rather than a switch statement is written in
`provider-profile.ts`: when vendor behaviour lived in enum switches,
vendors got added where it was cheapest to wire rather than by who
mattered, three enum-derived guards had to be invented to catch the
half-finished ones, and the question of which vendors we carry kept being
reopened.

## L3 — The catalog and the router

Given a policy, which model cards could serve this request, and in what
order.

`model-catalog/` holds the cards; `model-catalog/routing/` decides. The
thing to understand about L3 is what it is *not* allowed to decide.
Connection preference is ordered first, before anything else looks at the
pool (`routing/model-router.ts`): which account runs a model is a
commercial decision — committed cloud spend, a negotiated contract, a
direct vendor relationship — usually already made before the request
arrives, and not something cost ranking gets to overturn. Cost then ranks
*inside* each preference band rather than across them. A card whose
provider is not named keeps its place after those that are, because a
preference says which account to prefer, not which to forbid.

A routing policy describes what the caller *wants*, never who is asking
(`model-catalog/dto/model-catalog-controller.dto.ts`). Support is
registry data, never a code list, and a card is usable only through
`Model.isSelectable()` — see `docs/models.md`, which is the detailed
treatment of this layer.

## L4 — Roles

Which concrete model fills each named job, for the duration of one run.

A role is a job (`drafter`, `verifier`, `principal`), not a model.
`agents/agent-roles.service.ts` resolves every role once per run and
records what it resolved to, so a run always names its models afterwards.

The rule that shapes the file: **a pinned binding never touches L3.**
Roles are usable with routing switched off entirely, so the router is an
optional dependency there and a pinned role resolves without it being
present at all. The same rule is why
`ModelRouterService.providerForModelId` is a lookup and deliberately not
a plan: a filled role already names a concrete model.

See `docs/roles.md`.

## L5 — Strategies

How the work is done: how many calls, on which role slots, in what shape.

A strategy is a description that reduces to nodes and edges the engine
already executes (`agents/strategies/strategy-compiler.ts`). That
constraint is the whole value of the layer, and it buys eject-to-graph for
free: a strategy compiled and then saved as an ordinary pipeline is the
same graph the compiler would have produced anyway, so ejecting cannot
behave differently from running it.

Compiled nodes carry a `roleKey` and never a model, which is what keeps a
compiled graph as portable across vendors as the strategy that produced
it. `strategy-pipeline.resolver.ts` is the seam: which graph runs is L5's
answer, but which model fills each slot is still L4's decision at
execution time.

`extract-context.ts` is the clearest illustration of why steps stay
separate: the saving in explore-extract-patch is the expensive role
reading a brief instead of every transcript, and if the extraction were
folded into a neighbouring step the compression cost would disappear into
someone else's line item and nobody could tell whether the strategy was
worth running.

See `docs/strategies.md`.

## L6 — The orchestrator

Which strategy this particular request should use.

Off by default, per agent (`agent.settings.execution.orchestrator`), and
three rules shape `agents/strategies/orchestrator.ts`, all about failing
safely:

1. **Any failure falls back to the configured static strategy.** A
   timeout, a malformed answer, a strategy that does not exist: none of
   them may stop a run. An orchestrator that can break the product when
   it misbehaves is worse than no orchestrator.
2. **Depth is limited to one.** No orchestrator choosing an orchestrator.
   Enforced in code rather than documented, because the failure mode is
   unbounded cost.
3. **It is budget-accounted.** The choice costs a call, and a cost that
   does not appear in the budget is a cost nobody can see.

See `docs/orchestrator.md`.

## Cross-cutting — not a layer

Some concerns are consulted by whichever layer happens to be executing,
so they have no place in the stack. The comments cite them as
"cross-cutting" rather than a number.

- **Budgets** (`agents/strategies/budget-policy.ts`). Whichever layer is
  executing consults it between stages. Its shaping rule: **every
  decision records the projection that caused it.** "It went over budget"
  is not an explanation if nobody can see what the estimate was at the
  time. See `docs/budgets.md`.
- **Route tracing and attribution** (`agents/strategies/route-trace.ts`).
  A routed call stamps `routing` on the response, on the node result and
  on the audit log. A hop whose cost the provider did not report reads as
  opaque rather than as zero.
- **Co-failure** (`model-catalog/routing/co-failure.ts`). The rate at
  which every candidate fails together is the mathematical ceiling on any
  routing gain, so it is measured rather than assumed. See
  `docs/routing.md`.

## Where the docs sit

Each layer's detailed treatment lives elsewhere; this file is only the
map. `docs/models.md` spans two layers and labels each section, so it
appears twice.

| Layer | Doc |
|---|---|
| L1 | no dedicated doc — read `connections/egress-policy.ts` and `common/security/ssrf-safe-agent.ts` |
| L2 | `docs/models.md` § Provider profiles and protocols |
| L3 | `docs/models.md`, `docs/routing.md` |
| L4 | `docs/roles.md` |
| L5 | `docs/strategies.md` |
| L6 | `docs/orchestrator.md` |
| cross-cutting | `docs/budgets.md`, `docs/routing.md` § co-failure |

## Keeping this file honest

Every claim here is drawn from the code the citations point at. If you
change one of those files and the claim stops being true, this file is
the thing to fix — a design doc that describes a design the code
abandoned is worse than no design doc, because the comments still point
at it.
