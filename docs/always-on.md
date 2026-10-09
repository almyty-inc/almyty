# Always on

An autonomous agent can be **always on**: it keeps working in the
background. It wakes on a timer and whenever something happens, and every
time it wakes it carries on the same conversation it was having before, so
it remembers what it did yesterday.

Always on is not the same as a schedule. A **schedule** runs one task at a
set time (every weekday at 9:00) and posts the result. **Always on** is a
standing job: it wakes often, looks at what changed, and picks up where it
left off. An agent can have both.

## Turning it on

Open the agent and find the **Always on** card (on the agent's page and in
the builder), then **Set up always on**. You choose:

- **What it keeps doing.** Standing instructions, read at every wake. Write
  them the way you would brief a colleague: "Keep the refund queue moving.
  Answer what you can, and tell me about anything over $500."
- **What wakes it.**
  - *A timer*: every so many minutes or hours. Your plan sets the shortest
    timer (see [Limits](#limits)).
  - *Messages on its channels*: pick any of its Slack, email, Teams,
    webhook and other messaging channels. A webhook delivery wakes it with
    what was sent. On every other channel, the people writing keep their
    own chats exactly as before; the agent is only told that someone
    wrote, never what they said, so one person's words never turn up in an
    answer to someone else. With a timer on, that note waits for the next
    wake instead of waking it by itself, so a busy channel does not start a run per message.
  - *Connections that need attention*: a connection it was given is about
    to expire, has expired, or is due for a new key.
- **Talk to it yourself.** Pick one of its channels and your own address
  there (your Slack member ID, your email address). Your messages on that
  channel join its conversation, and it answers you there. Nobody else's
  messages do. On an email channel there is one more choice, off by
  default: **Treat email from my address as me**. Anyone can put your
  address on an email, while Slack and Teams messages can't be faked that
  way, so with it off your emails reach the agent like anyone else's.
- **What it may do on its own.**
  - *Looks things up, and asks you before it changes anything* (the
    default). On its wakes, every tool that may change something waits for
    your OK in **Approvals** before it runs.
  - *Does things, and asks you first only before what you pick.* Switching
    to this starts the list with every tool that may change something; take
    off what it may do alone. A tool on this list waits for your OK on
    **every** run of the agent, not only its wakes: **Try it**, a chat on
    any of its channels (yours or anyone's), a schedule, and a call through
    the API or a gateway. The list holds even while Always on is off.

  Your approval rules (for example "ask before a refund over 500") apply
  either way.
- **Reports.** A channel to post reports to, and when it reports: after
  every wake, only when it did something, or **once a day, a short summary
  of what it did** (see [The daily summary](#the-daily-summary)). Reports
  also show on the agent's page and in your notifications. When it is
  waiting for your OK, it says so there too.

The card then shows what wakes it, what it may do, when it reports, when it
last woke and why, and when the timer fires next. **Wake now** wakes it
straight away.

## The daily summary

With **Once a day, a short summary of what it did**, it no longer reports
after each wake. Once a day, at the time you pick, it sends one short
message about the last 24 hours instead:

- how often it was woken, and by what: its timer, a webhook, a message, you;
- how its work ended: finished, stopped before finishing, or still going;
- what it changed (the tools it used that change something), or that it
  only looked things up;
- what is waiting for your OK, with a link to **Approvals**.

A day it did nothing sends nothing.

The summary goes to the channel you picked and to your notifications. To
get it by email, turn on email for agent reports in your notification
settings. Two things still come straight away: its answers to your own
messages, and a note when it is waiting for your OK.

You pick the time and the time zone next to the choice, for each agent.
Until you change them, it goes out at 9:00 in your own time zone.

## What happens at a wake

1. Everything that woke it since it last worked is collected, oldest first.
2. If it is still working on something, the new things join that work at
   its next step ("While you were working: ..."). It never runs twice at
   once.
3. Otherwise it starts on its conversation again, with its standing
   instructions and the list of what happened.
4. It works with its own run limits (steps, cost, time), the same ones you
   set under **Run limits**.
5. When it finishes, it answers you where you wrote, and reports where you
   asked.

## When it stops on its own

The agent page says why, and you get a notification:

- **It woke more often in an hour than it may.** Something kept waking
  it: a webhook that fires too often, or a channel it reports into and
  also listens to. Look at **What woke it lately**, fix the cause, and turn
  it back on.
- **Its owner can no longer run it.** Always-on work answers to the
  agent's owner, checked at every wake. Add them back, or duplicate the
  agent.
- **It acts as itself, and your plan no longer includes that.** An agent
  set to act as itself (Business) runs with its own access. If the plan
  lapses it pauses instead of running as you. Switch it back to acting as
  you, or upgrade, then turn it back on.
- **Its timer could not be restored after a restart.** Turn it back on.
- **Your plan has room for fewer always-on agents on almyty-hosted
  machines than were on.** This only concerns agents that live on an
  almyty-hosted machine; one on your own machine, or with no machine, is
  never paused for it. It happens when a plan changes or lapses. The ones
  turned on last pause first, at their next wake, and the message says how
  many your plan includes. They turn back on by themselves as soon as there
  is room: when you turn Always on off for another of them, or your plan
  includes more. Once there is room you can also turn one back on yourself.

## Limits

| | Free | Pro | Business, Enterprise |
|---|---|---|---|
| Always-on agents | No limit | 3 included | No limit |
| Shortest timer | 15 minutes | 5 minutes | 5 minutes |
| Wakes an hour before it pauses | 6 | 12 | 12 |

These are settings, not fixed numbers: an install changes them for any plan
(`ALWAYS_ON_PLAN_CAPACITY`), and an organization can set tighter ones for
itself. On machines you run yourself or with no machine at all, the number
of always-on agents is not limited on any plan, and changing plans never
pauses one. The included count is for almyty-hosted machines when they
arrive.

## For developers

Design: `docs/design/hosted-runners-and-always-on.md` (PR #899), Part 2; this
is phase 1, without hosted runners.

**Storage.** `agents.alwaysOn` (json, `AlwaysOnConfig` in
`backend/src/modules/agents/always-on/always-on.types.ts`; the migration
`1750813802000-AlwaysOn` renamed `agents.heartbeat` and reshaped it, keeping
an existing heartbeat acting on its own). `agent_wakes` is the inbox: one row
per wake, unique per `(agentId, dedupeKey)`, `status` `queued | consumed |
coalesced | dropped`, `runId` of the run that took it.

**One way in.** Every source calls `AlwaysOnService.wake(agentId, org,
source, { summary, dedupeKey, payload?, ownerMessage? })`:

| Source | Caller | Dedupe key |
|---|---|---|
| `timer` | `always-on-tick` repeatable job on the `agent-runtime` queue | the minute |
| `webhook`, `channel` | `ChannelGatewayService.handleInboundMessage` -> `AlwaysOnService.routeInbound` | the delivery id |
| `connection` | `connections/connection-events.ts`, published where `connections.*` notifications are made (credentials governance) | connection + event + day |
| `manual` | `POST /agents/:id/always-on/wake` | time |

`always-on-wiring.guard.spec.ts` fails if a source loses its caller.

**Turning wakes into runs.** The `always-on-wake` job calls
`AlwaysOnService.process`: a Redis lock per agent (single flight); if the
thread's latest run (`alwaysOn.liveRunId`) is still live the wakes stay
queued and `AgentStepProcessor` hands them to it before its next model call
(`drainInto`); a run waiting for input gets the owner's message as its input.
Otherwise the queued wakes are claimed (compare-and-set on `queued`) and
`AgentRuntimeService.startRun` is called with `conversationId:
standingConversationId`, `agentLimits: true` (the agent's resolved limits,
never the old fixed ten steps) and `metadata.triggerType: 'always_on'`. Runs
started in the last hour are counted from consumed wakes; at the plan's
`maxWakesPerHour` the agent pauses with `WAKE_LOOP`. Access is judged at
fire time as the owner (`OWNER_CANNOT_RUN`); the run then acts as
`AgentIdentityService.resolve(agent, 'always_on')` says: the owner, or the
agent itself under `agent_identity`, and `IDENTITY_LAPSED` pauses it when the
plan no longer includes that. The standing thread is always
compacted (`AgentContextCompactor`, the agent's own settings when it has
them).

**Timers.** `reconcileTimer` on every change; `restoreTimers` at boot
removes every `always-on-tick` and legacy `heartbeat` repeatable job and
adds one per enabled, active autonomous agent, at the plan floor or above.
A legacy `heartbeat` job still in Redis fires as a tick.

**Ask first.** `ToolApprovalGateService.check` returns a `tool_call` hit
(after amount rules) when the call's run is an always-on run and
`asksFirst(alwaysOn, tool)`: in `propose`, any tool whose `sideEffect` is not
`read`; in `act`, the tools on `askFirstToolIds`. The autonomous runtime then
pauses in `WAITING_APPROVAL` exactly as for an amount rule, and the approved
call runs once.

**Reporting.** `onRunFinished` (called by `AgentRuntimeProcessor` for every
finished run) posts the result to the owner's channel when they wrote, and
to `reportTo` through `ScheduledPostService`; it notifies `agent.report`
(in the app) or `run.failed`, and looks at the inbox again. With
`report: 'daily_digest'` it skips the `reportTo` post and the
`agent.report` notification; replies to the owner and `run.failed` stay. A
pause notifies `agent.paused` (in the app and by email). An approval
request of an always-on run is posted to the same places, digest or not.

**Daily summary.** `report: 'daily_digest'` adds a second repeatable job
per agent, `always-on-digest` (job id `always-on-digest-<agentId>`,
`repeat: { cron: 'M H * * *', tz }`), added by `reconcileTimer` and
`restoreTimers` beside the timer and removed with it. When it goes out is
`digestTiming` in `always-on-digest.ts`, set per agent: `alwaysOn.digest.time`
/ `.timezone`, else 09:00 in the owner's `users.timezone`. Data-only
fallbacks with no screen: `organizations.settings.alwaysOn.digestTime`
(and `.digestTimezone` when the owner has no zone), then
`ALWAYS_ON_DIGEST_DEFAULT` (`{"time":"08:00","timezone":"Europe/Berlin"}`),
then the seeded 09:00 UTC.
`GET /agents/:id/always-on` returns the result as `digest`. The job calls
`AlwaysOnService.digest`: a Redis `SET NX` on
`always-on:digest:<agentId>:<local day>` makes it once a day whatever the
queue redelivers; it reads `agent_wakes` and the agent's `always_on` runs
created in the last 24 hours, the tools those runs called that are not
read-only, and the live run if it waits for approval, and `digestText`
writes the message (null on a quiet day, which posts nothing). It is posted
to `reportTo` as a `ScheduledResult` of kind `digest` (no row to record the
outcome on) and notified as `agent.report` with email params
`{ digest: true }`, which the email template renders as a summary.

**Capacity.** `always-on-capacity.ts`: the seeded plan catalog,
`ALWAYS_ON_PLAN_CAPACITY` (JSON keyed by plan) for the install, and
`organizations.settings.alwaysOn` to tighten one organization.
`includedAgents` bounds how many of an organization's active autonomous
agents with a hosted home (`alwaysOn.home.environmentId`, `hasHostedHome`)
may have Always on enabled at once, counted in the order they were turned
on (`alwaysOn.enabledAt`, set by `mergeAlwaysOn`; the agent's `createdAt`
for one turned on before that existed). Agents on the owner's own machines
or with no machine never count and are never refused or paused for it, on
any plan, so a plan change such as Free to Pro pauses none of them. Nothing
sets `alwaysOn.home` until hosted homes ship, so today the count is zero.

- `configure` refuses turning one more hosted-home agent on
  (`capacityRefusal`, naming the hosted-home agents that are on).
- `process` checks the agent's place before anything else
  (`beyondIncluded`, null for an agent without a hosted home); past the
  limit it pauses with `CAPACITY_EXHAUSTED` (`capacityPause`: the limit, how
  many were on, how to make room) and the `agent.paused` email says it comes
  back by itself (`resumesItself`).
- `resumeWithinCapacity(org)` turns paused-for-capacity agents back on,
  oldest pause first, as far as there is room among hosted-home agents (one
  without a hosted home takes no room), and tells each owner
  (`agent.report`, "is back on"). It runs when an agent is turned off or
  pauses for another reason, and from the `always-on-capacity` repeatable
  job (`resumeAllWithinCapacity`, every `ALWAYS_ON_CAPACITY_CHECK_MINUTES`,
  default 15, registered at boot), which notices a plan or setting that
  changed.

`WAKE_LOOP` (`maxWakesPerHour`) stays a per-agent loop guard and is not
resumed automatically.

**API.** `GET/PATCH /agents/:id/always-on` (`PATCH` also takes `report:
'daily_digest'` and `digest: { time, timezone }`; `GET` also returns `digest`,
`hostedHome` and `hostedAgentsOn`; the page names the plan's limit only when
`hostedHome`), `POST /agents/:id/always-on/wake`,
`GET /agents/:id/always-on/wakes`. Audit actions: `always_on_enable`,
`always_on_disable`, `always_on_pause`, `wake_dropped`.

**Retention.** See [retention.md](retention.md#an-always-on-agents-standing-conversation).
