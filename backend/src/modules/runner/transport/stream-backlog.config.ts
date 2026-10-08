/**
 * Bounds for the Redis-held backlogs that let a stream resume on any API
 * pod: the worker stream's Last-Event-ID replay buffer and the coding
 * relay's per-session event stream. Read from the environment at call
 * time (so a test can set them), with defaults sized for the common case.
 * Without Redis neither backlog exists: the transport keeps its in-memory
 * ring buffer and the relay stays pod-local.
 */

function positiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Frames kept per worker session for Last-Event-ID replay (both modes). */
export function workerReplayMax(): number {
  return positiveInt('WORKER_STREAM_REPLAY_MAX', 256);
}

/**
 * Seconds a worker session's shared replay buffer outlives its last frame.
 * Matches the session registry TTL: a session no pod can adopt any more
 * has nothing to resume.
 */
export function workerReplayTtlSeconds(): number {
  return positiveInt('WORKER_STREAM_REPLAY_TTL_S', 600);
}

/** Approximate cap (XADD MAXLEN ~) on one coding session's event backlog. */
export function codingBacklogMaxLen(): number {
  return positiveInt('CODING_RELAY_BACKLOG_MAXLEN', 2000);
}

/** Seconds a coding session's backlog outlives its last event. */
export function codingBacklogTtlSeconds(): number {
  return positiveInt('CODING_RELAY_BACKLOG_TTL_S', 24 * 60 * 60);
}
