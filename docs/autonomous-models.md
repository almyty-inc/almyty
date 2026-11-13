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
  (default 2), whether or not the final-answer check's `revise` is on:
  this is the strategy's own check. An exhausted budget completes with
  the last answer and says so. A check no checker could give a verdict on
  is not revised.

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

### The final-answer check reports; sending back is opt-in

The agent's own check (`agentConfig.verify`) gives a verdict and its
reasons, and by default that is all it does. The answer goes out as the
agent wrote it. When the check did not pass, the answer carries one line
above it, "Note: this answer's check didn't pass: <reasons>.", or
"Note: this answer could not be checked" when no checker gave a verdict.
The reasons are the verdict findings (below), strongest first: what the
platform found itself, then what a checker cited and the platform
confirmed. Each names the item and what is wrong with it; up to three
are given, then "and N more", each cut at 160 characters. An instruction
is never shown as a reason, and checker notes are never on the answer.
The verdict and reasons are on the run (`metadata.verify`, with
`reportOnly: true`) and on its `verify` step, in the same order, and
nothing is saved to memory from an answer whose check did not pass.

In 30 runs on staging the checker failed nine correct answers and passed
two wrong ones, and in eleven runs the revisions it asked for deleted
correct data. So sending the answer back is a setting of its own,
`agentConfig.verify.revise`, off unless the agent turns it on ("Let the
checker send the answer back for fixes"). With it on, a failed check
goes back to the agent with its verdict findings, up to `maxReviseLoops`
times (default 2), and every round is another model call; when the
rounds run out, the last answer goes out with the same note. An agent
saved before the setting existed has no `revise`, so it reports. A
check that only reports carries no "blocking" badge on the run view.

This is the final-answer check only. The checks inside a strategy
(cascade, best of N, explore-extract-patch) escalate, choose or revise
as each strategy describes above.

The agent's header and analytics show two numbers: **Completed**, the
share of runs that finished, and, for an agent with a check, **Checks
passed**, the share of checked runs whose check passed
(`agents.checkedExecutions`, `agents.passedCheckExecutions`; a run no
checker gave a verdict on is not counted). A check passes when it has
no verdict finding, whatever its checker notes say.

### What a checker sees

These rules hold for the verify gate and the strategy checks alike
(`agent-verifier.helper.ts`, `checker-evidence.ts`).

- A checker sees the agent's own instructions, the request, today's date
  and every tool result of the run. It reads the agent's rules as
  written, never stricter: where they allow alternatives ("labels or
  titles"), an item that meets any one of them meets the rule.
- The tool results are the ones the model that wrote the answer read:
  whole, from the run's conversation, not the copies on the stored steps
  (a run without a conversation falls back to the steps). The messages
  are in the database, so a step resumed on another worker reads the
  same. The amount is sized to the checker model's context window (half
  of it, from its model card), 120,000 characters when the window is
  unknown, and never more than 160,000 (about 50,000 tokens), since every
  check and every revision pays for it again.
- Only a result too large for that budget is shortened, and without
  losing items: a JSON result keeps every item with its identifying
  fields (id, name, title, tag, version, date, url, doi), and of a nested
  object (an author, a venue) its identifying leaves alone, such as
  `display_name`, `id` and `type`, for every item alike. Long text and
  large or deep structures go first. Only when that still does not fit
  are items left out. An empty list or an empty string on an item is
  never left out (`labels: []` says the issue has no labels). A
  shortened result always says so on its first line, and names every
  field left out by path, grouped under its list item:
  `[result shortened: every item is shown; fields left out: results[].{abstract (text), authorships[].raw_affiliation_strings (list)}; ...]`.
- A step payload over 32 KB is stored the same way (`persist-cap.ts`): a
  JSON result stays valid JSON as
  `{"_shortened": "[result shortened: ...]", "result": ...}` with every
  item's identifying fields, and text that is not JSON is cut and ends
  `… (truncated from N characters; only the first K are kept)`. Read from
  the steps, either is shown as shortened, never as the whole result.
  Storing is idempotent, so a step replayed from the run log is stored as
  the log holds it.
- When the request names a window ("look back 7 days", "since
  2026-11-01"), the checker is given its first and last day, and told to
  count the days between dates rather than estimate them.
- A checker call asks for 8,192 output tokens where its model card says
  the model may write that much (the card's most output comes from the
  price feed), the model's own most where that is less, and 4,096 when
  the card does not say, unless the checker sets its own. A reply cut
  off mid-way is read up to its last complete item.

### What decides the verdict

A final answer's check fails only on something that can be shown wrong
from the tool results. There are two kinds.

**What the platform checks itself.** These compare and count; they do
not judge (`window-check.ts`, `answer-checks.ts`):

- An item listed under a heading that says "new" whose date in the tool
  results is before the window the request names.
- A field the answer gives an item that the tool results give that same
  item differently: a publication or update date, a DOI (also "DOI:
  none" for an item that has one), labels, the latest version, a title,
  a venue, a first author. The item is found by its OpenAlex id, issue
  number, package name, title or DOI; a field the tool results do not
  hold is left alone.
- A package's update kind against its versions: "outdated-minor" for
  `^16.4.5` against 18.0.10 is wrong, because 16 to 18 is a major update.
- The answer's own counts: "the tool returned 10 works" against the
  tool's list, and "I skipped 10" against the entries it lists (it
  should list the returned count less the skipped count). A summary's
  counts ("5 packages have major updates") against its table.
- Items the tool returned that the answer leaves out while it says its
  list is complete ("No other works matched", "all ... are listed", or a
  returned count together with a skipped count).

Each finding names the item and the field and says what is wrong in
plain words: "dotenv: the answer says outdated-minor, but 16 to 18 is a
major update".

**What a checker cites and the platform confirms.** A checker model
reads the request, the agent's instructions, today's date, every tool
result and the answer. It puts a contradiction in `failures` with the
exact words of the answer (`claim`), the exact text of the tool results
that shows it wrong (`evidence`), and what is wrong (`rule`). It counts
only when the code confirms all of it (`checker-findings.ts`): the claim
is in the answer, the evidence is in the tool results and is data of the
item the claim is about, and where the field can be compared (a date,
version, DOI, id, title, name, venue, author or label) the two values
differ. A finding that states a false version order ("4.18.1 is not
newer than 4.17.21") or false day arithmetic is not confirmed. A
confirmed finding is written in the platform's words, naming the item
and the field.

**Checker notes.** Everything else a checker says is a checker note:
whether an item meets the agent's rules, which items it picked or left
out, relevance, wording, style, and every failure the code could not
confirm. Notes are shown on the run's `verify` step under "Checker
notes" and nowhere else: never on the answer, never in a visitor
channel. They never change the verdict and never count against "Checks
passed". In six rounds of runs on staging the platform's own checks were
right every time, and a checker's rule and selection judgements were
not; this is why only the first two kinds decide.

The reply format is `VERDICT_SCHEMA`: `failures`, `notes`, and in
`confirmed` only the ids, numbers, names or versions of what the checker
found right (sent as a JSON schema to OpenAI, Azure OpenAI and Gemini,
which take one, and said in the prompt to every other provider). An
item the checker itself marks as not failed is neither a finding nor a
note.

A workflow's `verify` step and a mid-run review have no tool results to
check against; there a checker's failure counts as it gives it, unless
it states a false version order or false day arithmetic.
- A checker call asks for 8,192 output tokens where its model card says
  the model may write that much (the card's most output comes from the
  price feed), the model's own most where that is less, and 4,096 when
  the card does not say, unless the checker sets its own. A reply cut
  off mid-way is read up to its last complete item.
- When no checker gives a verdict, the answer is not sent back for
  revision, even with revising on. The run completes, the `verify` step
  says why each checker gave none, and the answer is marked "Note: this
  answer could not be checked".
- Where an answer is sent back (revising on, or a strategy's own check),
  the revision is told to change only what a failure names and to keep
  every other fact its tool results support.
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
The agent's own answer check (`agentConfig.verify`) is a line of its own,
`answer_check`, so the lines add up to the run's cost; a revision is a
call of the role that revises. Each `verify` step records the checker's
`tokens` (`input` is mostly the evidence), and its card shows the input
tokens.

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
  calls are the run's cost. Nothing is saved after a run whose answer
  check did not pass, or in which a tool of the agent never answered
  (every call of it errored: "a tool call failed: openalex_search_works"
  on the step), and the facts call is told never to keep the state of a
  tool or a service (an error, a timeout, an outage) as a fact.
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
the run or `maxTemporaryAgentsAlive` across the agent's runs. `runAs`
(`owner` or `agent`, Business) says who its unattended runs act as: an
agent acting as itself uses only what is granted to it and is named as the
actor in the audit log ([enterprise.md](enterprise.md#agents-that-act-as-themselves)).