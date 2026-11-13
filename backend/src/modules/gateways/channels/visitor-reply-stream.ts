import { HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { withholdsCandidateAnswers } from '../../agents/final-answer';
import { answerStreamFilter } from '../../agents/answer-stream.filter';
import { visitorPosAfter, visitorPosText, type VisitorStreamPos } from '../../agents/run-stream-position';

/** A run that has ended, and the reason its stream gives: the page reads the reply from the transcript. */
export const FINISHED_RUN: Record<string, string | undefined> = {
  completed: 'run.completed',
  failed: 'run.failed',
  timeout: 'run.failed',
  cancelled: 'run.cancelled',
};

/**
 * A run a person stopped by turning down (or never deciding) an approval
 * it waited on, in the stream's words: `approval.rejected` or
 * `approval.expired`, so the page can say what happened rather than
 * "cancelled". Read from the live `run.cancelled` event's reasonCode, or
 * from the error a finished run was stored with (AgentRuntimeService
 * .handleApprovalDecided writes both).
 */
export function approvalEnding(source: { reasonCode?: string; error?: string | null } | null | undefined): string | undefined {
  if (source?.reasonCode === 'APPROVAL_EXPIRED') return 'approval.expired';
  if (source?.reasonCode === 'APPROVAL_REJECTED') return 'approval.rejected';
  const error = typeof source?.error === 'string' ? source.error : '';
  if (error.startsWith('approval expired')) return 'approval.expired';
  if (error.startsWith('approval rejected')) return 'approval.rejected';
  return undefined;
}

/** The `done` reason for a run that has already ended, or undefined while it is going. */
export function finishedReason(run: { status?: string; error?: string | null }): string | undefined {
  const ended = FINISHED_RUN[run.status as string];
  if (ended === 'run.cancelled') return approvalEnding(run) ?? ended;
  return ended;
}

/** What the page shows while a run waits for a person to approve one of its steps. */
const WAITING_FOR_APPROVAL = `event: waiting\ndata: ${JSON.stringify({ for: 'approval' })}\n\n`;
/** The approval came through and the run is working on the reply again. */
const RESUMED = `event: resumed\ndata: ${JSON.stringify({ after: 'approval' })}\n\n`;

/**
 * Refuse a reply stream to a visitor opening them too often.
 *
 * Anything but a browser's EventSource gets a plain 429 with Retry-After.
 * An EventSource cannot read either: a status other than 200 only tells it
 * the connection failed, so it would guess when to come back. It asks for
 * `text/event-stream`, and gets the wait as a frame it can read: an
 * `event: retry` with `retryAfterMs` (and the same as the stream's own
 * `retry:` field), then the end of the stream. Nothing of the run is read.
 */
export function refuseVisitorStream(
  req: Request,
  res: Response,
  limit: { code?: string; message?: string; retryAfterSeconds?: number },
): void {
  const seconds = limit.retryAfterSeconds ?? 5;
  res.setHeader('Retry-After', String(seconds));
  const body = {
    code: limit.code ?? 'VISITOR_RATE_LIMITED',
    message: limit.message ?? 'Reconnecting too often. Please wait a moment.',
  };
  const accept = String(req.headers?.accept ?? '');
  if (!accept.includes('text/event-stream')) throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
  const retryAfterMs = seconds * 1000;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`retry: ${retryAfterMs}\nevent: retry\ndata: ${JSON.stringify({ ...body, retryAfterMs })}\n\n`);
  res.end();
}

/**
 * A visitor's reply, as it is written, over SSE. Shared by the hosted chat
 * and the widget; each checks who the visitor is and that the run is theirs
 * before calling this.
 *
 * Resumable. Every frame that carries reply text (`token`, `reset`) has an
 * SSE id: where on the run's event stream the event it came from is, and
 * which of that event's frames it is (run-stream-position.ts). A visitor
 * whose connection drops mid-answer reconnects naming the last frame they
 * had, and gets the reply text from there on, then the live stream: nothing
 * they missed is left out and nothing they had comes twice. Named no frame
 * (the first look, or a page opened again while the reply is still being
 * written), they get the reply from its start.
 *
 * A resume works the reply out again rather than looking it up: the run's
 * events are read from the start through a fresh answer filter, the same
 * one, in the same order, so it reaches the same state, and the frames up
 * to the named one are not sent. Replay and live are one read of the same
 * stream, so there is no handover to lose an event in. Only what the filter
 * lets out is numbered, so a position can never name the agent's working,
 * or bring any of it back: a visitor sees the answer and never the steps,
 * tool calls or memory behind it.
 *
 * A finished run is not replayed: `done` at once, and the page reads the
 * reply from the transcript (or, for the widget, from its stored replies).
 * At its time limit the stream ends without `done`, so the browser
 * reconnects from its last frame.
 *
 * A run that stops to ask a person on the team sends `waiting`, then
 * `resumed` once approved; turned down or expired, it ends with `done`
 * and the reason `approval.rejected` or `approval.expired`.
 */
export async function streamVisitorReply(opts: {
  req: Request;
  res: Response;
  runtime: Pick<AgentRuntimeService, 'subscribeRunEvents'>;
  run: { id: string; status?: string; error?: string | null; agent?: any };
  resumeFrom: VisitorStreamPos | null;
}): Promise<void> {
  const { req, res, runtime, run, resumeFrom } = opts;
  const withholdCandidateChunks = withholdsCandidateAnswers(run.agent);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx would otherwise buffer the stream
  res.flushHeaders?.();

  const ended = finishedReason(run);
  if (ended) {
    res.write(`event: done\ndata: ${JSON.stringify({ reason: ended })}\n\n`);
    res.end();
    return;
  }
  // Already waiting on a person (the page was reopened, or the stream came
  // back after its time limit): say so before anything else.
  if (run.status === 'waiting_approval') res.write(WAITING_FOR_APPROVAL);

  let closed = false;
  let timedOut = false;
  const abortController = new AbortController();
  const close = () => {
    if (closed) return;
    closed = true;
    abortController.abort();
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      /* socket already gone */
    }
  };

  // The event being filtered, and how many frames it has sent so far.
  let source: string | undefined;
  let frame = 0;
  const send = (name: 'token' | 'reset', data: unknown) => {
    const at = source === undefined ? null : { event: source, frame: frame++ };
    // The visitor already has this one.
    if (at && resumeFrom && !visitorPosAfter(at, resumeFrom)) return;
    const id = at ? `id: ${visitorPosText(at)}\n` : '';
    res.write(`${id}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // A visitor sees the answer, never the working: the run's events are
  // reduced to the answer as it is written (agents/answer-stream.filter.ts,
  // shared with the /v1 compat APIs). A token that turns out not to be the
  // answer is retracted with `reset`; with a verify panel or a strategy
  // that judges candidates nothing is sent before the answer is chosen, and
  // the page reconciles from the transcript on `done`.
  const filter = answerStreamFilter(
    {
      token: (content) => send('token', { content }),
      reset: () => send('reset', {}),
      done: (reason) => {
        res.write(`event: done\ndata: ${JSON.stringify({ reason })}\n\n`);
        close();
      },
    },
    { withholdCandidates: withholdCandidateChunks },
  );
  const onEvent = (event: any, id?: string) => {
    if (closed) return;
    if (event?.type === 'stream.timeout') {
      timedOut = true;
      return;
    }
    // The run stopped to ask a person on the team, which can take hours:
    // say so, rather than leave the visitor watching "thinking" dots. These
    // frames carry no id; they say what the run is doing, not reply text.
    if (event?.type === 'step.completed' && event?.data?.status === 'waiting_approval') {
      res.write(WAITING_FOR_APPROVAL);
      return;
    }
    if (event?.type === 'approval.decided' && event?.data?.resumed) {
      res.write(RESUMED);
      return;
    }
    // Turned down, or nobody decided in time: the run ends there, and the
    // page says which.
    const declined = event?.type === 'run.cancelled' ? approvalEnding(event?.data) : undefined;
    if (declined) {
      res.write(`event: done\ndata: ${JSON.stringify({ reason: declined })}\n\n`);
      close();
      return;
    }
    source = id;
    frame = 0;
    filter(event);
  };

  // Proxies drop idle connections; a comment frame keeps it warm
  // without being visible to the EventSource consumer.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 25_000);
  heartbeat.unref?.();

  req.on('close', close);

  try {
    // Redis Streams are the cross-pod source of truth. A visitor's request
    // and the run's worker frequently land on different API pods, so a
    // process-local EventEmitter cannot reliably deliver completion. Read
    // from the start every time: a resume rebuilds the filter's state from it.
    await runtime.subscribeRunEvents(run.id, onEvent, abortController.signal);
  } catch {
    // The done event below tells the browser to reconcile from the persisted
    // transcript even if Redis disconnected after the run had completed.
  }

  if (!closed) {
    // Still going at the time limit: end without `done`, and the page
    // reconnects from the last frame it had.
    if (!timedOut) res.write(`event: done\ndata: ${JSON.stringify({ reason: 'stream_ended' })}\n\n`);
    close();
  }
}
