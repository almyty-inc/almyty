import type { AgentRunEvent } from '../../entities/agent-run-event.entity';

/**
 * Where a run stream picks up again after a reconnect.
 *
 * Two kinds of position, one per kind of event:
 *
 *  - a seq, for the run's event log (agent_run_events). A logged event goes
 *    out with its seq as the SSE id, so `Last-Event-ID` or `?after=<seq>`
 *    names it (durable runs step 2).
 *  - a stream position, `<ms>-<n>` as Redis numbers the entries of
 *    `run:<id>:events`, for the runtime events (tokens, step progress, the
 *    run's end). They have no seq; a client that renders them names the
 *    last one it had (`?live=` on the run stream, the hosted chat's own SSE
 *    id) and gets the ones after it that are still in the stream's window.
 */

/**
 * Where a run view resumes: the seq in `Last-Event-ID` (what an
 * EventSource sends on reconnect), else `?after=`. Null when neither is
 * given (the plain live stream). A malformed header is ignored, since a
 * browser may send one left over from another stream; a malformed
 * `after` is the caller's mistake.
 */
export function resumeSeqOf(lastEventId: unknown, after: unknown): number | null | 'invalid' {
  const seq = (value: unknown): number | null => {
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text !== 'string' || !/^\d{1,10}$/.test(text.trim())) return null;
    const n = Number(text.trim());
    return Number.isSafeInteger(n) ? n : null;
  };
  const fromHeader = seq(lastEventId);
  if (fromHeader !== null) return fromHeader;
  if (after === undefined || after === null || after === '') return null;
  return seq(after) ?? 'invalid';
}

/** A logged event as a run view receives it. */
export function runLogEventOf(event: AgentRunEvent) {
  return { seq: event.seq, type: event.type, step: event.step ?? null, payload: event.payload ?? {}, createdAt: event.createdAt };
}

const STREAM_POS = /^(\d{1,15})-(\d{1,15})$/;

/**
 * A position on `run:<id>:events` from the caller: `0` (the start) or
 * `<ms>-<n>`. Null when not given, 'invalid' when given and not one.
 */
export function streamPosOf(value: unknown): string | null | 'invalid' {
  const text = Array.isArray(value) ? value[0] : value;
  if (text === undefined || text === null || text === '') return null;
  if (typeof text !== 'string') return 'invalid';
  const trimmed = text.trim();
  if (trimmed === '0') return '0';
  return STREAM_POS.test(trimmed) ? trimmed : 'invalid';
}

/** Order two stream positions (`0` sorts first): negative, zero or positive. */
export function compareStreamPos(a: string, b: string): number {
  const parts = (pos: string): [number, number] => {
    const m = STREAM_POS.exec(pos);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  };
  const [am, an] = parts(a);
  const [bm, bn] = parts(b);
  return am !== bm ? am - bm : an - bn;
}

/**
 * A place in a visitor's reply stream (the hosted chat): the stream
 * position of the runtime event a frame came from, and which frame of that
 * event it was, since one event can send two (a `reset`, then the answer).
 * Written `<ms>-<n>.<frame>` as the frame's SSE id.
 */
export interface VisitorStreamPos {
  event: string;
  frame: number;
}

const VISITOR_POS = /^(\d{1,15}-\d{1,15})\.(\d{1,6})$/;

export function visitorPosText(pos: VisitorStreamPos): string {
  return pos.event + '.' + pos.frame;
}

/** The highest frame number a position can carry. */
export const VISITOR_LAST_FRAME = 999_999;

/**
 * A position past every frame of the event at `event`: a stream resumed
 * from it sends only what events after that one bring.
 */
export function visitorPosPastEvent(event: string): string {
  return visitorPosText({ event, frame: VISITOR_LAST_FRAME });
}

/** Whether frame `a` comes after frame `b` in the stream. */
export function visitorPosAfter(a: VisitorStreamPos, b: VisitorStreamPos): boolean {
  const order = compareStreamPos(a.event, b.event);
  return order !== 0 ? order > 0 : a.frame > b.frame;
}

/**
 * Where a visitor's reply stream resumes: `Last-Event-ID` (what their
 * browser sends when it reconnects on its own), else `?after=`. Null when
 * neither is given (the reply from its start). A malformed header is
 * ignored, as above; a malformed `after` is refused.
 */
export function visitorResumeOf(lastEventId: unknown, after: unknown): VisitorStreamPos | null | 'invalid' {
  const parse = (value: unknown): VisitorStreamPos | null => {
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text !== 'string') return null;
    const m = VISITOR_POS.exec(text.trim());
    return m ? { event: m[1], frame: Number(m[2]) } : null;
  };
  const fromHeader = parse(lastEventId);
  if (fromHeader) return fromHeader;
  if (after === undefined || after === null || after === '') return null;
  return parse(after) ?? 'invalid';
}
