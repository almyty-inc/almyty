import type { WorkerEnvelope } from './protocol.js';

/**
 * Sends envelopes to the backend one at a time, in the order they were
 * queued, each only once the backend has answered the one before.
 *
 * Coding output is the user's transcript, and each POST can land on a
 * different backend pod. A pod answers only once the event is in the
 * session's stream, so waiting for that answer before the next POST is what
 * makes the stream's order the order the output was produced in. Sending
 * them without waiting let a later chunk be recorded before an earlier one.
 *
 * A POST that can succeed if sent again (no answer at all, a 5xx, a 429, a
 * 404 while the session is being re-established) is retried after a delay,
 * with the same envelope and so the same envelope id: the backend records an
 * id once, which keeps a retry after a lost answer from duplicating output.
 * Anything else (the envelope itself was refused), or a POST still failing
 * after the last retry, is reported through onDrop and the queue moves on.
 */
export interface OrderedSenderOptions {
  /** Posts one envelope; rejects on failure (StreamableClient.send). */
  send: (env: WorkerEnvelope) => Promise<unknown>;
  /** The delay before each retry; their count is the number of retries. */
  retryDelaysMs?: number[];
  /** Most envelopes held; past it a new one is dropped and reported. */
  maxQueued?: number;
  /** Told about each envelope given up on. */
  onDrop?: (env: WorkerEnvelope, err: unknown) => void;
  /** Test injection. */
  sleep?: (ms: number) => Promise<void>;
}

/** 0.25s doubling to 8s, then 8s: a little over a minute in all. */
export const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000];
const DEFAULT_MAX_QUEUED = 10_000;

/** Whether a failed POST is worth sending again. */
export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true; // no answer: network error, reset, timeout
  return status >= 500 || status === 429 || status === 408 || status === 404;
}

export class OrderedSender {
  private readonly queue: WorkerEnvelope[] = [];
  private draining = false;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];
  private readonly retryDelaysMs: number[];
  private readonly maxQueued: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OrderedSenderOptions) {
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Queue an envelope behind everything queued before it. */
  enqueue(env: WorkerEnvelope): void {
    if (this.stopped) return;
    if (this.queue.length >= this.maxQueued) {
      this.opts.onDrop?.(env, new Error(`send queue full (${this.maxQueued})`));
      return;
    }
    this.queue.push(env);
    if (!this.draining) void this.drain();
  }

  /** Envelopes not yet answered, the one in flight included. */
  get pending(): number {
    return this.queue.length;
  }

  /** Resolves once everything queued so far has been sent or given up on. */
  idle(): Promise<void> {
    if (!this.draining) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** Stop sending; whatever is still queued is dropped. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        await this.deliver(this.queue[0]);
        this.queue.shift();
      }
    } finally {
      this.draining = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private async deliver(env: WorkerEnvelope): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.opts.send(env);
        return;
      } catch (err) {
        if (this.stopped) return;
        if (!isRetryable(err) || attempt >= this.retryDelaysMs.length) {
          this.opts.onDrop?.(env, err);
          return;
        }
        await this.sleep(this.retryDelaysMs[attempt]);
        if (this.stopped) return;
      }
    }
  }
}
