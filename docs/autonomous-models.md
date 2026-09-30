# Autonomous agents: models and how they work together

An autonomous agent runs the ReAct loop: one model call per step, tool
calls in between, until a step answers without calling a tool. Its
**models** say which models take part in that loop and how. They live on
the agent row (`agents.models`, `modules/agents/autonomous-models.ts`) and
the loop reads them on every step, so an edit takes effect on the next
step of a running run, like an edit to the instructions.

A workflow agent gets the same kind of shape from a strategy compiled to
its graph (`docs/strategies.md`). The two are separate on purpose: the
workflow compiler turns a strategy into nodes; the autonomous loop applies
a strategy to each of its own steps. Neither is a second execution model
for the other.

## Roles

A role is one model (or, for panelists and teammates, another agent) with
a job:

| Purpose | What it does | Can be another agent |
|---|---|---|
| `main` | Runs the loop. Exactly one. | no |
| `drafter` | Cascade: takes each step first. | no |
| `checker` | Refute-only review (cascade, explore-extract-patch); picks the best answer (best of N). | no |
| `panelist` | Panel: answers the same question. | yes |
| `judge` | Panel: writes the answer the panelists agree on. Optional; the main role judges without one. | no |
| `explorer` | Explore-extract-patch: gathers with the tools. | no |
| `summariser` | Explore-extract-patch: compresses what the explorers found. | no |
| `teammate` | Offered to the loop's model as a tool, `ask_<key>`, in every strategy. | yes |

A model role carries `providerId` + `model`, or a `routing` policy, plus
optional `temperature`, `maxTokens` and `instructions`. The main role is
mirrored into `modelConfig` on every write (`syncMainRole`): the page
writes `models` and `modelConfig` follows; an API or MCP client that still
writes only `modelConfig` moves the main role. Everything that reads the
agent's model (readiness, the model-issue banner, compaction, a compat
request's sampling override) therefore reads the model the loop uses, and
the loop reads the main role's call settings from `modelConfig`.

The page does not edit an agent's `collaboration` field: it shows any participants and judge still stored there as teammate roles, and a save writes them as roles and clears `collaboration`. The page offers model
teammates under the work mode's Advanced; other agents the agent may call
are picked once, under Capabilities (`agentConfig.callableAgentIds`, offered
as `call_agent_*` tools, see `agent-capabilities.ts`). An agent teammate
role saved through the API still runs as `ask_<key>`; the page moves it
into the Capabilities list when it opens the agent.

## Strategies

The keys are `AUTONOMOUS_STRATEGY_KEYS`. The page calls the strategy the
**work mode**: one dropdown offering exactly these, with the slots each needs
under it (`WORK_MODE_SLOTS`), and a frontend source guard fails if it offers
one the engine does not run or misses one it does. A strategy whose slots are not filled is
refused at save time (`Invalid models: Cascade needs a drafter role`) and,
should one reach a run anyway, fails the run with the same sentence rather
than running as something else.

### Single — needs `main`

Today's loop, on the main role.

### Cascade — needs `drafter`, `checker`, `main`

- The drafter makes each step's call, tools and all.
- When the drafter answers without a tool call, the checker reviews that
  answer through the shared refute-only verifier (`AgentVerifierHelper`,
  policy `any_fail_blocks`, the agent's verify `spec` if it has one, the
  checker role's instructions as its focus). An error or unreadable
  verdict counts as a fail.
- Pass: the drafter's answer is the answer. The main role is never paid
  for.
- Fail: the drafter's answer is dropped (never shown, never written to
  the conversation), the step is recorded as `escalated` with a failed
  `verify` step, and the next step is the main role redoing it from the
  same state (same conversation and tools, without the rejected draft).
  The main role's answer is final; if it calls tools instead, the step
  after goes back to the drafter.
- Tool-call plans are not checked, only answers.

### Best of N — needs `main`, `checker`; `candidates` 2–5, default 3

The main role runs the loop. When it answers, it writes N−1 more
candidate answers over the same context with no tools (the tool turns
written out as text, as `final-answer.ts` does), and the checker picks one
with the same judge prompt the workflow `merge` node uses
(`strategies/judging.ts`). A candidate is not started once the run is at a
ceiling (`checkRunLimits`), a failed or empty one is dropped, and with one
candidate left no judge is paid for. An unreadable pick keeps candidate 1
and says so on the step.

### Panel — needs `main` and at least two `panelist`s; optional `judge`

The main role runs the loop. When it answers, each panelist answers too:
a model panelist over the same conversation with no tools, an agent
panelist as its own run of that agent on the user's latest message. The
judge, or the main role when there is none, then writes the answer they
agree on (the workflow consensus prompt): the step records `agreement`
and `consensusReached` (threshold 0.5) and which model judged. A judge
that fails leaves the main role's answer. The judge is a model, never
another agent; the page shows it as an optional Judge slot under Panel,
added with **Add a judge**.

### Explore, extract, patch — needs `explorer`s, `summariser`, `main`, `checker`

Experimental, and not claimed to save money (see `docs/strategies.md`).

- The run's first step is the exploration: every explorer is its own run
  of this agent (`metadata.actAs`), on the explorer's model, with the
  agent's tools, told to gather rather than answer, in parallel. Each
  child run gets an equal share of the parent's remaining budget and at
  most five minutes, and is driven step by step by the worker running its
  parent (`startRun(..., { inline: true })`) rather than queued, so a
  parent never holds the only worker while its child waits behind it. The
  same goes for an agent panelist's or teammate's run.
- The summariser compresses their findings into the `extract_context`
  brief (same instruction, same strict parse). A brief that does not
  validate fails the run with `EXTRACTED_CONTEXT_INVALID` rather than
  passing the transcripts through.
- The brief goes into the run's working memory and the main role's system
  prompt on every later step; the main role then works the task from it,
  with tools.
- The checker verifies the main role's answer. A failure goes back to the
  main role as a revision, within the verify gate's `maxReviseLoops`
  (default 2); an exhausted budget completes with the last answer and
  says so.

### What every strategy keeps

- Run limits (`maxSteps`, `maxCostCents`, tokens, time, tool calls,
  recursion depth), checked at every step as before. Every call a strategy
  makes is added to `totalCost` and `totalTokens`; a child run's cost and
  tokens are added to its parent's.
- Scope: every step re-checks the run's principal; child runs (explorers,
  agent panelists and teammates) inherit it and `startRun` refuses an
  agent that scope cannot run; an agent teammate is only offered when the
  run could start it.
- The agent's own verify gate (`agentConfig.verify`) still reviews the
  final answer, after the strategy has chosen it.
- Hosted chat: a Single run composes its answer with a no-tools call and
  streams it (`final-answer.ts`). Every other strategy checks or chooses
  among candidate answers, so, like a verify gate, it holds everything
  back until the answer is final (`withholdsCandidateAnswers`), and the
  page reconciles from the transcript.

## What a run records

Every model call a role makes is a step stamped with `role: { key, name,
purpose, kind }`, its `cost`, `tokens`, and `output.model`,
`output.providerId` and, for a routed call, `output.routing`. Step types:
`llm_call` (`status`: `completed`, `drafted`, `revising`, `escalated`,
`candidate`, `panel_answer`, `sleeping`, `waiting_input`), `verify`,
`judge`, `explore`, `extract_context`, `teammate_call`. A `verify` step is
stamped the same way: the checker's verdict says which model gave it (and
the verifier panel's `checkers` carry it per checker).
`src/modules/agents/__tests__/autonomous-strategies-end-to-end.spec.ts`
runs every strategy through the hosted chat with a different model per
role and checks each step's model and the visitor's answer.
`run.metadata.roleCosts` totals each role (`cost`, `tokens`, `calls`) and
`run.metadata.strategy` names the strategy. The run detail shows both.

## Cost

The strategy decides how many calls a request costs, the roles decide
what each costs:

- Single: the loop's calls.
- Cascade: the drafter's calls plus one checker call per drafted answer;
  the main role's calls only for a step whose check failed.
- Best of N: the loop's calls plus N−1 answer calls on the main role plus
  one judge call.
- Panel: the loop's calls plus one call (or one child run) per panelist
  plus one judge call.
- Explore, extract, patch: one child run per explorer plus one summariser
  call, then the main role's calls plus one checker call per answer.

## Memory and capabilities

The agent's other two sections are read by the same loop, on every step.

**Memory** (`agents.memoryConfig`, `agent-memory-settings.ts`,
`AgentMemoryKeeper` in `agent-memory.keeper.ts`):

- `whose` picks the scope a run reads and writes (`memoryScopeFor`):
  `shared` the workspace, `agent` the agent's own (`<org>:agent:<id>`,
  scope type `agent`), `person` the run's member (`user` scope) or visitor
  (`<org>:user:visitor:<endUserId>`); a run for nobody has no memory.
  Writes follow `runMayWriteSharedMemory`: a visitor's only when the
  surface carried `visitorMemory: true`.
- `account` is almyty's own store or an outside backend the organization
  has a credential for (`MemoryAccountsService.accounts`); reads and writes
  go through it (`MemoryRouter.putOn` / `searchOn`), signed in with the
  workspace's credential. Unknown accounts are refused at save. With
  `credentialId` the agent has an account of its own (connected from its
  page by anyone who can edit it): resolved as the run's principal, checked
  at save with `CredentialRefResolver.assertAttachable` against the
  agent's scope and the saver, again when the agent's scope changes, and
  used by the sweep as the system acting for the agent. An `agent` scope
  is readable through the Memory API only by those who can see the agent
  (`CanonicalMemoryController.scopeFor`).
- `save`: `facts` makes one call on the main role after a completed run
  and saves each fact (tier `long`); `conversations` saves the exchange
  (tier `project`); `asked` saves nothing on its own, and `store_memory`
  says so to the model. The after-run save is a `memory_save` step, and its
  calls are the run's cost.
- `neverSave` rules screen every write with a main-role call first (the
  facts call carries them in its own prompt); `NOTHING` or a failed check
  means nothing is written.
- `retentionDays` is `ttl_seconds` in almyty's own store; outside, a
  `memory_expiries` row per write that the hourly `expire-outside` job
  deletes through the backend (`MemoryBackend.nativeId`). A backend without
  `nativeId` refuses a time limit. A change applies to what the agent
  already saved (`setAgentRetention`).

**Capabilities** (`agents.agentConfig`, `agent-capabilities.ts`):
`toolIds` plus `apiIds` (every active tool of the API, resolved per step,
so later tools are included) are the only tools offered, and a call to any
other name is "not found". `callableAgentIds` are the only `call_agent_*`
tools offered and the only agents `invoke_agent` starts (an API client
that sets only `canCallAgents` still means every agent). `runnerLabels` go
with every tool call. `create_agent` refuses past `maxTemporaryAgents` in
the run or `maxTemporaryAgentsAlive` across the agent's runs.
