# Durable agent runs

Status: accepted. Being built step by step (see Rollout). Done: step 1,
the event log written alongside the run row.

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
  expire and no record of how far the step got.
- **Retries can repeat side effects.** The step CAS (`commitStep`, guarded
  on `currentStep` and a non-terminal status) stops a duplicate commit,
  but not a duplicate tool call made before the commit: a retried job
  calls the tool again.
- **State is rewritten, not appended.** `steps` and `workingMemory` are
  written whole on every commit. What changed in a step is not recorded
  anywhere, only the result.
- **Live views cannot replay.** Run events go out over Redis to whoever is
  subscribed now. A viewer that reconnects gets the current row and nothing
  in between.
- **Waits are queue delays.** A sleeping run or one waiting on a machine
  is a delayed job; if the queue loses it, nothing wakes the run.

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
last seq it saw and gets everything after it, then the live stream.

## Rollout

1. **Dual-write.** The commit writes the events with the row; nothing reads
   them except the projection check in tests. *Done.*
2. **Shadow read.** Compare the projection with the row on commit in
   staging and log any difference; serve SSE replay from the log.
3. **Leases.** Add the lease columns, claim runs by lease, move sleeps and
   machine waits to `nextWakeAt`. The queue only nudges.
4. **Resume and idempotency keys.** Resume from the log after a lease
   expires; tool calls carry their key.
5. **The log is the source of truth.** `steps` and `workingMemory` on the
   row become a cache of the projection.

Not on the log: creating the run (its INSERT is what `run_started` records
at the first write) and deleting it (its events go with it). Every other
write of a run, anywhere in the backend, goes through `writeRun`; a guard
spec (`run-writes-are-logged.spec.ts`) fails on an `AgentRun` repository
write anywhere else.

## The worker-kill test

The acceptance test for steps 3 and 4: start a run whose step makes a tool
call with a side effect, kill the worker process after the tool call
returned and before the commit, and let the lease expire. The run must
finish on another worker with the side effect made exactly once, the model
asked no more times than without the kill, cost counted once, and a viewer
connected throughout seeing every event once and in order.
