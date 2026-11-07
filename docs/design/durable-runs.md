# Durable agent runs

Status: accepted. Being built step by step (see Rollout). Done: step 1,
the event log written alongside the run row, step 2, the projection
checked against the row on every write and live run views replayed from
the log, step 3, run leases, and step 4, resume from the log and
idempotency keys.

## In plain words

An autonomous run works in steps: ask the model, run the tools it asked
for, record what happened, repeat. Today each step rewrites the whole run
row (`agent_runs.steps` and `workingMemory`, a JSON blob) and hands the
next step to a queue. That works until a worker dies mid-step, a step is
delivered twice, or a viewer reconnects and wants to see what it missed.

This design makes a run's history an append-only list of events. The row
becomes a summary of that list, a worker holds a run by a lease it has to
renew, and anything that was in flight when a worker died can be picked up
from the last event, without doing a paid call or a side effect twice.

## Gaps today

- **A dead worker strands its run.** The run sits `running` until the
  reaper times it out, and the step's work is lost. There is no lease to
  expire and no record of how far the step got. (Steps 3 and 4: the lease
  expires, another worker takes the run over, on the log, and resumes the
  step from what it had done.)
- **Retries can repeat side effects.** The step CAS (`commitStep`, guarded
  on `currentStep` and a non-terminal status) stops a duplicate commit,
  but not a duplicate tool call made before the commit: a retried job
  calls the tool again. (Closed by step 4: a call finished is not made
  again, and one whose outcome is unknown goes out with its first key.)
- **State is rewritten, not appended.** `steps` and `workingMemory` are
  written whole on every commit. What changed in a step is not recorded
  anywhere, only the result.
- **Live views cannot replay.** Run events go out over Redis to whoever is
  subscribed now. A viewer that reconnects gets the current row and nothing
  in between. (Closed by step 2: a viewer resumes from the last seq it saw.)
- **Waits are queue delays.** A sleeping run or one waiting on a machine
  is a delayed job; if the queue loses it, nothing wakes the run. (Closed
  by step 3: the wait is `nextWakeAt` on the row, and the wake sweep
  nudges a run whose nudge was lost.)

## Spec 1: the run event log

`agent_run_events` (runId, seq, type, step, payload jsonb, createdAt),
primary key (runId, seq), which is also the index for "events after seq N
for run R". `agent_runs.headSeq` is the seq of the last event. Deleting a
run deletes its events (ON DELETE CASCADE), so retention and erasure need
nothing of their own.

Every write of a run's state appends, in the same transaction as the row
write, the events for what it changed, numbered headSeq+1.. . There is one
way to write a run, `writeRun` (`backend/src/modules/agents/run-event-writer.ts`),
used by the step commit and by every writer outside it: cancel, sending
input, an approval request pausing the run and its decision resuming or
ending it, the reaper, the queue giving up, a sub-agent wait timing out,
a race cancelling its losers, collaboration steps, the delivery claim of
a scheduled or always-on result, and metadata a channel or a wake adds
(the AI disclosure flag, reply addresses, the channel post outcome).

`writeRun` reads the row under a row lock (`SELECT ... FOR UPDATE`) with
the writer's guard (the step commit's is the step number and a status
that is not terminal), diffs the change against the row as locked, and
writes the row and the events at headSeq+1.. . The lock orders writers,
so a write made while a step runs (an approval pausing it, a wake leaving
a reply address) is already in the step commit's starting point: the log
never has a gap or a repeat, and folds into exactly what the row holds.
The UPDATE also names the headSeq it read, and the primary key refuses a
repeated seq, should anything write around the lock. A change can be a
function of the locked row, for a merge (one metadata key) that must not
write back a stale copy of the rest.

Event types (`backend/src/modules/agents/run-events.ts`):

| Type | What it carries |
|---|---|
| `run_started` | First event of a run: the row as it stood before its first write (status, step, working memory, metadata, steps). |
| `model_call` | A model call step, whole. |
| `tool_call` / `tool_result` | A tool or sub-agent call: the call, then its result (output, error, duration, cost, tokens), paired by `callIndex` within the commit. |
| `step_recorded` | Any other step (verify, error, memory save, ...). |
| `step_replaced` / `steps_reset` | A recorded step rewritten, or the list shortened. Not expected; present so the log stays complete if it happens. |
| `memory_changed` / `metadata_changed` | Top-level keys set and removed in working memory or metadata. |
| `compaction` | The step folded more of the conversation into its summary: `folded` (messages folded this step), `foldedTotal` (folded over the run, only grows), and what the summarizer cost. Written by the commit of the step it belongs to, and only when `folded > 0`. |
| `approval_requested` | A held tool call or change set waiting on a person (from the step that holds it), or a `request_approval` pause (from the request, with its id). |
| `approval_decided` | The decision: approval id, approved / rejected / expired, who decided, their note. |
| `approval_resolved` | A held call or change set taken off the run once its decision took effect. |
| `input_received` | A person's input resumed a waiting run (the message by id; its words stay in the conversation). |
| `delivery_claimed` | A finished run's result claimed for posting (schedule or always-on), once. |
| `lease_taken_over` | A worker claimed the run after the lease of the one processing it expired (step 3): the new `attempt` and when the old lease lapsed. |
| `model_answered` | Step progress (step 4): the model's answer, written before anything acts on it. |
| `tool_started` / `tool_finished` | Step progress (step 4): a call about to be made, with its idempotency key, and what it came to. |
| `waiting_input`, `status_changed`, `run_completed`, `run_failed` | Status transitions. |
| `step_committed` | Last event of every write: status, step, cost, tokens, tool calls, time, and output and error when they changed. |

Folding the events (`projectRunEvents`) gives back the row's status, step,
totals, output, error, steps, working memory and metadata. That equality is
the check every later step relies on.

## Spec 2: leases instead of queue delays

`agent_runs` gains `nextWakeAt`, `leaseOwner`, `leaseExpiresAt` and
`attempt`. A worker claims a due run with `UPDATE ... WHERE (leaseExpiresAt
IS NULL OR leaseExpiresAt < now()) AND nextWakeAt <= now() ... RETURNING`,
renews the lease while it works, and clears it on commit. A sleep or a
machine wait sets `nextWakeAt` instead of a delayed job. A lease that
expires means its worker is gone: the next claim takes the run, with
`attempt` + 1.

## Spec 3: resume and idempotency

A worker that takes over a run reads its events after the last
`step_committed` and resumes from there instead of starting the step over:
a model call already answered is not asked again, and a tool call already
made is not made again. Each tool call carries an idempotency key, (runId,
step, callIndex), sent to tools that accept one and checked against the
log before any call. Live views replay from the log: a viewer sends the
last seq it saw and gets everything after it, then the live stream (built
in step 2).

## Rollout

1. **Dual-write.** The commit writes the events with the row; nothing reads
   them except the projection check in tests. *Done.*
2. **Shadow read.** Compare the projection with the row on commit in
   staging and log any difference; serve SSE replay from the log. *Done*
   (see Step 2 as built, below).
3. **Leases.** Add the lease columns, claim runs by lease, move sleeps and
   machine waits to `nextWakeAt`. The queue only nudges. *Done* (see Step 3
   as built, below).
4. **Resume and idempotency keys.** Resume from the log after a lease
   expires; tool calls carry their key. *Done* (see Step 4 as built,
   below).
5. **The log is the source of truth.** `steps` and `workingMemory` on the
   row become a cache of the projection.

Not on the log: creating the run (its INSERT is what `run_started` records
at the first write) and deleting it (its events go with it). Every other
write of a run, anywhere in the backend, goes through `writeRun`; a guard
spec (`run-writes-are-logged.spec.ts`) fails on an `AgentRun` repository
write anywhere else.

## Step 2 as built: shadow read

**The projection check.** `writeRun` tells whoever watches run writes,
after its transaction commits (`onRunWritten`, run-event-writer.ts), what
it wrote: the row as locked, the row as written and the events appended.
With `RUN_PROJECTION_CHECK` set (`true`, `1` or `on`), the check
(`backend/src/modules/agents/run-projection-check.ts`) folds those events
onto the run's projection and compares every field the log describes
with the row as written. Where the fields differ it logs a warning
(`event: run_projection_mismatch`, with the run id, the seq, the seq the
fold started from and, per differing field, a hash of each side; for
steps also both lengths and the first index where they part, never a
value) and writes a `run_projection_mismatch` row to `usage_metrics` with
the run's organization. The monitoring sample counts them over its
window (`runs.projectionMismatches`, Prometheus
`almyty_run_projection_mismatches`). The write has already committed: a
check that differs, throws or is slow changes nothing about it.

"No mismatches" means something only against how many writes were
compared, so that is counted too. Every write checked increments the
Redis key `run_projection:checks`, shared by all replicas and kept across
restarts; the sample carries it as `runs.projectionChecks`, Prometheus as
the counter `almyty_run_projection_checks_total`. Each process also logs
its own totals every 15 minutes when they moved, and once on shutdown
(`event: run_projection_summary`, "N run writes checked, M mismatches
since this process started"), so `kubectl logs` answers the question
where the metrics endpoint is closed (`PLATFORM_METRICS_TOKEN` unset).

The flag is read, never inferred from the environment's name. It is off
when unset and in the base Kubernetes config map, which is production's
(the API deployment reads it from there, `optional: true`);
the development compose file turns it on, and the staging and development
deployments turn it on with `RUN_PROJECTION_CHECK: "true"` in their overlays
(infra repository).

The fold is incremental (`foldRunEvents`, run-events.ts). The projection
each check ends with is kept in memory, least recently used out first,
within `RUN_PROJECTION_CHECK_CACHE_MB` (default 32), so the next write of
that run folds only what it appended. A run the cache does not hold at
the previous head (first write this process sees, another pod wrote it
last, evicted) starts from the row the write locked, which is the
projection at the previous head when the log is sound. Nothing is read
back from the database. A cached projection also catches a write made
around `writeRun`: it changed the row and not the log, and the next
write's projection no longer matches. After a difference the check starts
again from the row, so one difference is reported once. A finished run is
not kept.

Measured on a run of 10,001 events (2,000 commits, 4,000 steps, 1.4 MB of
steps and working memory, 12.5 MB of log): a check takes 9 ms at the
median over the run and 17 ms (p95 20 ms) at the end, against 20 ms for
the write's own diff and serialisation of the same state. Its cost is the
size of the run's state, the same order as the UPDATE, and does not grow
with the history; a full replay would read the 12.5 MB of log back on
every commit.

**Replay for live views.** Every committed write appends its new head to
`run:<id>:log` in Redis (one small entry, the seq; the events are read
from Postgres). `GET /agents/:id/runs/:runId/stream` takes the seq a
viewer last saw, from `Last-Event-ID` (what an EventSource sends on
reconnect) or `?after=<seq>`, and then
(`AgentRuntimeEventsHelper.subscribeRunLog`):

1. notes the current end of `run:<id>:log` and `run:<id>:events`,
2. reads `agent_run_events` after the seq, 500 at a time, and sends each
   as a `run.log` event with SSE `id:` its seq,
3. waits on both Redis streams from the noted ends: a head past the last
   seq sent reads the log again from there; a runtime event (tokens, step
   progress) goes out as before, without an id.

Only the next seq is ever sent, so nothing goes out twice, and a write
that commits while the log is being read has its announcement after the
noted end, so nothing is dropped. While nothing is announced the log is
read again every five seconds, in case an announcement was lost. The
stream ends on a terminal runtime event (after sending the rest of the
log), a second after the log shows the run finished, or at its time limit
with `stream.timeout` carrying `lastSeq`. Without a seq the endpoint is
the live stream it was. Org and agent scoping is the endpoint's own
(`getRun(runId, organizationId, agentId)` before anything is sent).

**Live events resume too.** Runtime events have no seq, but each has a
place on `run:<id>:events` (the Redis entry id, `<ms>-<n>`). In the
resumable stream each one carries it as `pos`, and `?live=<pos>` (or `0`,
the run's start) makes the runtime events start after that one instead of
from now (`subscribeRunLog`'s `eventsAfter`). A client that shows tokens
keeps both positions and reconnects with `?after=<seq>&live=<pos>`: no
token lost, none twice, as long as the entry is still in the stream's
window (5,000 entries, six hours). Without `live` nothing changes.
`stream.timeout` and the server's closing `done` are not the run's end.
The API-key route `GET /:org/:agent/runs/:runId/stream` is resumable the
same way and now checks the run is the key's organization's and this
agent's before sending anything (it used to stream any run id it was
given). `run-stream-writer.ts` serves both.

The clients follow this contract. `@almyty/client`'s
`followRunStream` (behind `AlmytyClient.followRun` and
`GatewayClient.streamRun`, so the chat CLI too), the ACP server's
`streamRun`, and `agents run --watch`, which now prints each step from the
log as its commit lands instead of polling the row: each starts at
`after=0&live=0`, hands each event on once, reconnects from where it was
when the connection drops or the server ends it at its time limit, retries
a network error or a 5xx with backoff, and stops on a 400, 401, 403, 404
or 410. A server that sends neither a seq nor a `pos` (one without this
contract) is read once, as before.

The agent's **Runs** tab follows an open, unfinished run this way
(`useLiveRun`, `lib/run-stream.ts`): it starts from the listed row and its
`headSeq` (now in the list response), folds each event the way
`projectRunEvents` does, keeps the last seq applied across connections
and reconnects after it, reading the stream with fetch so the
`X-Organization-Id` header goes with it. A network error or a 5xx is
retried with backoff; a 400, 401, 403, 404 or 410 ends it for good, and
the run keeps its last known state with a note that it is no longer
available.

**The hosted chat: the answer resumes, the working never shows.** The
visitor stream (`GET /public/chat/:slug/stream`) is not on the log: a
visitor sees the answer, never the working. It resumes from its own
position: every frame that carries reply text (`token`, `reset`) has the
SSE id `<pos>.<n>`, the place of the runtime event it came from and which
of that event's frames it is (one event can send a `reset` and then the
answer). A visitor reconnects with `Last-Event-ID` or `?after=` and the
server works the reply out again: it reads the run's events from the start
through a fresh answer filter, which reaches the same state in the same
order, and does not send the frames up to the named one. Replay and live
are one read of the stream, so there is no handover to lose a token in.
Only what the filter lets out is numbered, so a position cannot name or
bring back anything of the working. Who may resume is who may watch: the
visitor's own cookie, the chat's sign-in rule, the run in one of their
conversations on this chat (`runBelongsToEndUser`) and the gateway's
organization and agent; anyone else gets 404. The stream only reads, so it
never makes a visitor: it looks the cookie up (`findEndUser`) and a request
with no cookie, or one nobody holds, gets what a stranger gets (401 where
the chat requires sign-in, 404 otherwise) with no row written. Opening a
stream is limited per visitor and per address
(`GatewayRateLimitService.checkVisitorStream`: 30 a minute and 600 an hour
for a visitor, 120 and 2,400 for an address), counted apart from the
message limits and never as one bucket for the whole chat. Over it, a
caller gets 429 with `Retry-After`. A browser's EventSource can read
neither (any status but 200 is just a failed connection to it), so a
request that accepts `text/event-stream` gets a 200 stream holding one
frame, `event: retry` with `{ code, message, retryAfterMs }` (also the
stream's own `retry:` field), and then the end (`refuseVisitorStream`).
The page and the widget wait exactly that long and reconnect from where
they were; a wait is not counted as a failed attempt.
A finished run is not replayed (`done` at once, the page reads the
transcript); at the time limit the stream ends without `done`, so the page
reconnects. The page keeps the id of the last frame it showed and opens
the stream again with `?after=` after a drop, with backoff, reading the
transcript after a few failed attempts. The streaming itself is one
function (`gateways/channels/visitor-reply-stream.ts`) the hosted chat and
the widget share.

**Reattaching on load.** A conversation's transcript names the reply still
being written, if any (`openRunId`: its latest run, while pending or
running). The page that opens it, from the list or after a reload (the tab
keeps the open conversation's id in `sessionStorage`), opens that run's
stream with no position: the reply from its start, then live, replies only.
A finished conversation opens from its transcript as before.

**The widget.** It streams each reply over the same stream at
`GET /gateways/:id/widget/stream?threadId=&runId=&after=`. Its visitor is
the thread (it has no session of ours), so a run is streamed only to the
thread, widget and agent it was started under (`widgetRunOnThread`);
anything else is 404. The same per-visitor (the thread) and per-address
limit applies. When a reply is done the widget reads its stored copy, which
takes the streamed bubble's place. A stream that will not stay open (five
attempts) is given up on and the widget polls the stored replies with
`afterId`, the last one it showed, compared by (createdAt, id) in the
database, one poll at a time; after two such streams in a row it only
polls. A widget thread can carry on in a run waiting for input, whose
stream already holds that run's earlier replies. Before the input goes in,
`handleWidgetMessage` reads where the run's stream ends
(`lastRunEventPos`, one XREVRANGE; nothing is written to it while the run
waits) and answers with `after`, a position past every frame of that last
event (`<pos>.999999`). The widget opens the stream from there, so only
the new reply shows.

**The ACP server.** It reads an autonomous run's `llm.*` events the same
way the answer filter does: the answering call's `llm.chunk`s go to the
editor as `agent_message_chunk` as they arrive, a working step's as
`agent_thought_chunk`, a step its provider never classifies goes out whole
when its `llm.response` lands, and whatever of the run's final output did
not stream goes out at the end, so the answer is never sent twice. The run
stream sends each runtime event whole (`{ type, data, timestamp, pos }`),
so every mapping reads the event's own fields from under `data`
(`runEventData`): `tool.started` and `tool.result` reach the editor as a
tool call and its update, and `run.failed` ends the turn with its error.

## Step 3 as built: leases

**The columns.** `agent_runs` has `nextWakeAt`, `leaseOwner`,
`leaseExpiresAt` and `attempt` (migration `AgentRunLeases1791000900000`),
with a partial index on `nextWakeAt` where it is set. They say who holds
the run and when it next needs a worker, not what the run is, so they are
not in the projection and a write of them alone appends nothing to the
log.

**When a run is due.** `writeRun` sets `nextWakeAt` from the status a
write leaves: `pending` or `running` is due now, `sleeping` keeps the wake
time its step wrote, anything else (waiting on a person, finished) has
none. Every writer goes through it, so a run resumed by input or an
approval is due even if the nudge its writer queued is lost. A new run is
due at creation. The `wait` tool, and with it a machine wait (a hosted
workspace still starting), no longer queues a delayed job: it sets
`nextWakeAt` to the wake time and the commit writes it.

**The claim.** `AgentStepProcessor.processStep` claims the run before it
does anything (`claimRun`, `run-lease.ts`): one `writeRun` under the row
lock whose `where` is the doc's condition, status `pending`, `running` or
`sleeping`, `nextWakeAt` passed (or not set), the lease free or expired,
and, when the queue job names a step, the run still at it. The lease
token is the worker (host and pid) plus a fresh id per claim, so two
claims of one process are told apart too. A claim reads only the lease
columns, writes `leaseOwner` and `leaseExpiresAt`, appends nothing and
leaves `updatedAt` alone (the reaper reads `updatedAt` as progress). Not
claimed, the step does nothing: `done` for a run that is gone or
finished, as before, and a new outcome, `held`, for a run another worker
holds, that is not due, or that is past the job's step. A woken sleeping
run is `running` again from the step that claims it.

**Renewal and release.** While the step runs the lease is renewed every
`RUN_LEASE_RENEW_MS` (`holdLease`), and let go when the step returns or
throws, before the next step is queued. A renewal that finds the lease
gone marks it lost and stops; a renewal that fails is retried at the next
tick and the lease holds until it expires.

**Fencing.** Every write the step makes of the run it holds names the
lease token in its `where` (`heldBy(run)`): the step commit, the cost of
a step abandoned because the run was cancelled, the memory step after
completion, and the collaboration step's write. A worker whose lease
expired and was taken over writes nothing: its commit matches no row,
whatever it did meanwhile. A lease that expired and that nobody took over
still lets its holder commit; there is no one to conflict with. A guard
spec (`run-writes-are-logged.spec.ts`) fails on a write of the leased run
in those files without the fence. Writers that do not hold the run
(cancel, input, approvals, the reaper) are not fenced; they take the row
lock as before, and the commit's status guard keeps a cancel final.

**Takeover.** A claim that finds the lease expired takes the run over:
`attempt` + 1, and `lease_taken_over` on the log (`attempt`, `lapsedAt`;
the worker's identity is not on the log). The taken-over step resumes from
its progress on the log (step 4, below).

**The takeover cap.** `takeovers` (migration
`AgentRunTakeovers1791001000000`, a lease column like `attempt`, so not in
the projection) counts the takeovers of the step the run is at: + 1 with
every takeover, back to 0 when a step commits (the step commit and the
collaboration step's write set it). `attempt` keeps counting every
takeover of the run. The takeover that brings `takeovers` to
`RUN_MAX_TAKEOVERS` (default 3) does not start the step again: in the same
`writeRun`, fenced on the lapsed lease like any takeover, it fails the run
with "This step stopped its worker 3 times in a row, so the run was
stopped." and clears the lease. The log has `lease_taken_over`, then the
failed-run events any failing write appends (`status_changed`,
`run_failed` with the error, `step_committed`). The claim comes back
`stopped`; the step processor sends `run.failed` with the error and
reason code `TAKEOVER_LIMIT` to live viewers and processes nothing.
Workers racing for that takeover find the run finished (`done`).

**The queue only nudges.** A `next-step` job names the step it was queued
for: the continuation (read after the commit), a sleep's wake (queued by
the step processor for `nextWakeAt` once the commit has landed), input,
an approval resuming the run, the first step. A job for a step already
done claims nothing, so a duplicate nudge never starts a second chain of
jobs. `RunWakeSweepService` runs in every backend process every
`RUN_WAKE_SWEEP_INTERVAL_MS` and nudges up to 200 runs whose `nextWakeAt`
is more than `RUN_WAKE_GRACE_MS` past and that no live lease holds: a lost
nudge, an overslept wake, or a dead worker's expired lease. Its job id is
the run and its due time, removed once run, so pods sweeping together
queue one job and a later pass can queue another.

**Settings.** Read from the environment each time, with defaults:

| Variable | Default | What |
|---|---|---|
| `RUN_LEASE_MS` | 60000 | How long a claim or a renewal holds a run. |
| `RUN_LEASE_RENEW_MS` | a third of the lease | How often the holder renews (at most half the lease). |
| `RUN_WAKE_SWEEP_INTERVAL_MS` | 15000 | How often the wake sweep runs. |
| `RUN_WAKE_GRACE_MS` | 30000 | How far past due a run must be before the sweep nudges it. |
| `RUN_MAX_TAKEOVERS` | 3 | The takeover of one step, with no commit between, that fails the run (a whole number, at least 1). |

A worker that dies mid-step is therefore taken over after at most the
lease, the grace and one sweep interval (about 105 s by default) instead
of the reaper's 30 minutes. The reaper still ends a run that makes no
progress for `AGENT_RUN_STALE_MS`. A step that takes its worker down every
time ends the run at its third takeover (by default) instead of being
taken over until its own limits (duration, steps, cost) or the reaper end
it.

## Step 4 as built: resume and idempotency keys

**A step writes its progress.** While it works, before its commit, a step
puts what it has done on the run's log (`StepJournal`,
`backend/src/modules/agents/run-resume.ts`):

| Event | When | What it carries |
|---|---|---|
| `model_answered` | The model answered, before anything acts on the answer. | The response as the provider layer returned it (message, tool calls with their arguments, cost, usage, model, routing), how many messages the call was made with, the role, and what compaction folded before the call (its summary, cost and tokens), when it folded anything. |
| `tool_started` | Before each call is made. | `callIndex` (the call's place in the step), its idempotency key, the tool, and the arguments it is made with (the real ones; see Arguments on the log, below). |
| `tool_attempted` | Before and after each further try of a write whose outcome was lost (Unknown outcomes, below). | The key, the try's number and phase (`started`, `finished`), and once finished its outcome, HTTP status, error and result (capped, personal data hidden). |
| `tool_finished` | Once the call's outcome is known. | The key, what the step reads of the call afterwards (its result and error, capped and with personal data hidden, as the stored steps are), the steps it recorded (stored the same way), what it added to cost, tokens and the tool-call ledger, working memory or metadata when it changed them, and what it left for the rest of the step (a call held for approval, a call waiting on a machine, a change set, a machine failure). |

They are markers: nothing in the fold changes, and the commit that follows
describes the step exactly as before, so the projection, the live views
and every reader of the log stay as they were (they skip types they do not
know). The write is `writeRun` with `{ progress: true }`: it locks the row,
reads only the columns that guard it, appends the notes with no
`step_committed` after them, and moves `headSeq` (and `updatedAt`, which
the reaper reads as progress). It is guarded like the step's commit: the
run still at the step, not finished, and held by this worker's lease
(`heldBy`). A refused write stops the step where it is: a call is never
made unless its `tool_started` landed, and a cancelled run keeps the cost
of the answer already paid for (`abandonIfTerminal`). The projection
check moves a cached projection over progress without comparing anything
(`RunWritten.progress`).

**Where a step's progress is.** Every event a write appends carries the
step the run was at. The commit that moves a run to step N is written at
step N - 1, and a step number is never processed again once its commit
lands, so step N's progress is the tail of the log at step N. A step reads
it from the end, newest first, 100 events a page, until an event of
another step: one indexed read of the primary key in the common case. A
write someone else makes during the step (a channel's metadata, an
approval request) sits in that tail and does not cut it short.

**Resume.** Every step reads its progress before it does anything (a
takeover after a lapsed lease, a retried job, or, almost always, nothing):

- The model answered an earlier attempt: it is not asked again. Its
  answer, cost and tokens are the step's, the role is charged once, and
  what compaction folded before the call is put back without folding
  again. The live `llm.response` goes out once more with `resumed: true`.
  The assistant message with the tool calls is saved only if the earlier
  attempt did not save it.
- A call has `tool_finished`: it is not made again. Its outcome stands in
  for it (`replayCall`): its steps, totals, working memory and the step's
  own bookkeeping, so the commit is the one an uninterrupted step would
  have written. Its conversation message was saved before its
  `tool_finished`, so it is not saved twice.
- A call has `tool_started` and no `tool_finished`: the worker died in
  the call, or between the call returning and its outcome landing on the
  log, and nobody knows whether it ran. A read, or a call to a tool that
  takes an idempotency key, is made again, with the key it was first made
  with. A write or delete to a tool that takes none is not: it is tried
  again with backoff, the model is told, and a person decides (Unknown
  outcomes, below).
- Anything else runs as it would have.

The calls of a step made before the model is asked, held calls once
approved, change sets once decided and calls that found their machine
waking (`runApprovedCalls`, `retryWakingCalls`), are journaled the same
way: change sets first, then held calls, by their place in the step.

**Idempotency keys.** A call's key is `runId:step:callIndex`
(`idempotencyKey`), the same on every attempt of the step. It is on the
log with the call (`tool_started`, `tool_finished`), checked there before
the call, and handed to the tool executor as
`ToolExecutionOptions.idempotencyKey`, which keeps it across its own
retries. A tool accepts one when its operation declares an
`Idempotency-Key` or `X-Idempotency-Key` header (any case), or its HTTP
config sets one (`idempotencyHeader`, `operation-header-params.ts`): the
call sends the key as that header, in place of whatever the model put
there. A tool that declares none is sent no key; for it, a call the log
does not know the outcome of is made again when it reads, and tried again
with care when it writes (Unknown outcomes, below).

**The takeover cap.** Resuming does not change what the cap counts:
`takeovers` goes back to 0 only when a step commits, so a step that makes
progress on each attempt and still takes its worker down every time ends
the run at `RUN_MAX_TAKEOVERS` like before, and every attempt before that
resumes from the last one's progress. A call finished on any attempt is
made once.

**What is not resumed.** Only the step's own model call and its tool calls
are on the log. A strategy's further calls on a final answer (cascade's
checker, best-of-n and panel candidates and judge, the composed answer,
the verify panel) and the explore phase are made again by a step that
resumes after them; so are the calls a `run_code` script makes inside its
one call, and a sub-agent call that was started and not finished starts
its child run again. Built-in tools (memory, wait, input) and teammates are
journaled like any call but get no key: they make no outside call of their
own.

**Unknown outcomes.** A call on the log as started and not finished, to
a tool that writes or deletes (its side-effect class, `tool-side-effect.ts`)
and takes no idempotency key, is not made again silently
(`backend/src/modules/agents/unknown-writes.ts`). Making it again could do
the same thing twice, a second email or a second payment, and nobody
would know. Instead:

1. It is tried again, up to `RUN_UNKNOWN_WRITE_RETRIES` times, waiting
   `RUN_UNKNOWN_WRITE_BACKOFF_MS` before the first try and twice as long
   before each next one. It stops at the first try with a definite
   outcome: the tool succeeded, the service refused it (a 4xx other than
   408 and 429), or it never reached the service (no such tool, no
   access, held by an approval rule). A timeout, a network error, a 5xx,
   408 or 429, or a machine still starting is no answer, and the next try
   follows. Each try is on the log twice, as `tool_attempted`: before it
   is made (`phase: started`) and once it came back (`phase: finished`,
   its outcome, HTTP status, error and result, capped and with personal
   data hidden). A try that another death cut off is counted as one that
   got no answer, and the step that picks up next goes on from the tries
   already made.
2. Whatever came of the tries, the model is told plainly, as the call's
   result: an earlier attempt may already have gone through, the tool
   takes no idempotency key, how many tries were made and what each came
   to (the last one's result when it succeeded), and not to make the call
   again itself.
3. The run waits for a person. The step asks for an approval of kind
   `unknown_outcome` (the same approvals as held calls, on the Approvals
   page and in the approval notifications) carrying the call, its
   arguments with personal data hidden, and the tries; the call goes on
   working memory as `unknownOutcomeCalls` (tool, approval and each try's
   outcome, no arguments and no results), and the run is
   `waiting_approval` once the step commits, like a held call. The log
   says so with `approval_requested` (kind `unknown_outcome`).
4. Once the person decides (`approval_decided`, kind `unknown_outcome`),
   the run carries on whatever the decision, like a change set: a
   rejection does not cancel it. The next step adds the decision to the
   call's result before the model is asked anything. Approved: a person
   checked it and the agent carries on. Rejected, or left until the
   request expired: the agent is told to treat the action as not done,
   not to make the call again, and to carry on without it. Nothing is
   sent again or undone either way.

Reads, and tools that take a key, are made again as described above. The
same holds for held calls once approved and calls retried after a waking
machine: one of those cut off mid-call goes through the same tries,
telling and approval.

| Variable | Default | What |
|---|---|---|
| `RUN_UNKNOWN_WRITE_RETRIES` | 3 | How many times a keyless write whose outcome was lost is tried again (a whole number from 0 to 10; 0 tries nothing and still asks a person). |
| `RUN_UNKNOWN_WRITE_BACKOFF_MS` | 1000 | The wait before the first try; each next try waits twice as long (1 s, 2 s, 4 s by default). |

**Arguments on the log.** `model_answered` and `tool_started` keep a
call's real arguments: a step that resumes reads them from the log
(`StepJournal`) and makes the call with them, so every try above sends
the real values. Everywhere the log is read out, the arguments are shown
with personal data hidden (`backend/src/modules/agents/run-log-privacy.ts`):

- The run streams, `GET /agents/:id/runs/:runId/stream` and the API-key
  route, send every page of the log they read through the run log view
  (`AgentRuntimeEventsHelper.setRunLogView`, set by the runtime service on
  start). What a live view folds the log into, the run as the dashboard
  rebuilds it, is therefore built from hidden arguments too.
- The run view (`GET /agents/:id/runs/:runId` and the API-key route)
  answers with the run's held calls (`gatedToolCalls`, `wakingToolCalls`,
  `unknownOutcomeCalls`) and its steps the same way
  (`AgentRuntimeService.getRunForViewer`).
- A visitor's reply stream reads only the runtime events, which carry no
  arguments, never the log. Nothing exports the log today; a guard spec
  (`run-log-privacy.spec.ts`) fails when code outside resume, the writer
  and the live view starts reading `agent_run_events`, so a new reader
  goes through `eventsForViewers` from the start.

The hiding is the organization's own PII filter
(`ToolExecutorService.hidePersonalData`, the pii-filter plugin), the same
one the stored steps and tool results go through, so it applies exactly
where they are hidden: an organization with the filter on, or a
compliance policy that enforces it. Only arguments are touched; ids,
states and costs are left as they are. A filter that fails, or a run that
can no longer be found, hides the arguments altogether.

The lease settings above decide when a step is picked up again.

## The worker-kill test

The acceptance test for steps 3 and 4: start a run whose step makes a tool
call with a side effect, kill the worker process after the tool call
returned and before the commit, and let the lease expire. The run must
finish on another worker with the side effect made exactly once, the model
asked no more times than without the kill, cost counted once, and a viewer
connected throughout seeing every event once and in order.

It is `run-resume.integration.spec.ts` (real Postgres and Redis): the dying
worker stops at its commit and never writes or renews again, three workers
race to pick the run up and one takes it over, and a viewer subscribed to
the run's log from seq 0 sees it whole. The same spec kills a worker inside
its call (the call goes out again with its first key, and the service makes
it once) and runs a step into the takeover cap; `run-resume.spec.ts` drives
the same cases over the fake repositories.

`unknown-writes.integration.spec.ts` (real Postgres and Redis) kills a
worker inside a call to a keyless write: the run is taken over, the call
is tried again with backoff and the run waits for a person; approved, it
carries on to the end without the call made again; rejected, the model is
told to carry on without it; and a viewer on the run's SSE stream never
sees the email address in the call's arguments while every try sends the
real one. `unknown-writes.spec.ts` and `run-log-privacy.spec.ts` drive
the same over the fake repositories.