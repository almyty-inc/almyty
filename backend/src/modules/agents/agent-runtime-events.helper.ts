import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { EventEmitter } from 'events';

import { AgentRun } from '../../entities/agent-run.entity';
import { AgentRunEvent } from '../../entities/agent-run-event.entity';
import { RunWritten, onRunWritten } from './run-event-writer';

const RUNTIME_EMITTER_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const TERMINAL_EVENT_TYPES = ['run.completed', 'run.failed', 'run.cancelled'];
const TERMINAL_RUN_STATES = ['completed', 'failed', 'cancelled', 'timeout'];

/**
 * Entries kept per run stream. Every streamed token is one entry, so a
 * long reply runs to hundreds; this is a generous replay window that
 * still bounds a runaway run.
 */
const RUN_EVENT_STREAM_MAXLEN = 5_000;

/**
 * Backstop TTL, refreshed on every write.
 *
 * A run that reaches a terminal event gets the short replay window
 * instead. This is for the ones that never do -- timed out, pod killed,
 * abandoned waiting on approval -- which previously left the key with no
 * expiry at all.
 */
const RUN_EVENT_STREAM_TTL_SECONDS = 6 * 60 * 60;

/**
 * Head announcements kept per run on `run:<id>:log`. One per run write; a
 * viewer only ever needs the ones after it connected, so a short window
 * does.
 */
const RUN_LOG_STREAM_MAXLEN = 1_000;
/** Events read from agent_run_events per query while replaying. */
const RUN_LOG_PAGE = 500;
/** While nothing is announced, the log is still read this often, in case an announcement was lost. */
const RUN_LOG_IDLE_READ_MS = 5_000;
/** Once the log shows a run finished, how long its terminal runtime event is waited for. */
const RUN_LOG_END_GRACE_MS = 1_000;

export const runLogKey = (runId: string) => `run:${runId}:log`;

/**
 * Owns run-event emission for AgentRuntimeService:
 *  - per-run EventEmitter map (same-pod fast path)
 *  - Redis Stream fan-out (cross-pod)
 *  - subscribeRunEvents() blocking reader
 *  - periodic orphaned-emitter sweep
 *
 * Split out so the runtime service can stay focused on step
 * processing and run lifecycle.
 */
@Injectable()
export class AgentRuntimeEventsHelper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRuntimeEventsHelper.name);
  private readonly runEmitters = new Map<string, EventEmitter>();
  private emitterSweepTimer?: NodeJS.Timeout;
  private cleanupHook?: (runId: string) => Promise<void>;
  private stopWatchingWrites?: () => void;
  /** How often a resumable view reads the log while nothing is announced (RUN_LOG_IDLE_READ_MS). */
  logIdleReadMs = RUN_LOG_IDLE_READ_MS;
  /** How long a resumable view waits for the terminal runtime event once the log shows the run finished. */
  logEndGraceMs = RUN_LOG_END_GRACE_MS;

  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    // Every committed run write announces its new head to live run views.
    this.stopWatchingWrites = onRunWritten((written) => this.publishRunLogHead(written));
    this.emitterSweepTimer = setInterval(() => {
      this.sweepOrphanedRunEmitters().catch((err) => {
        this.logger.warn(`Emitter sweep failed: ${err.message}`);
      });
    }, RUNTIME_EMITTER_SWEEP_INTERVAL_MS);

    if (this.emitterSweepTimer.unref) {
      this.emitterSweepTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.emitterSweepTimer) {
      clearInterval(this.emitterSweepTimer);
      this.emitterSweepTimer = undefined;
    }
    this.stopWatchingWrites?.();
    this.stopWatchingWrites = undefined;
    this.runEmitters.clear();
  }

  /**
   * Hook called when a terminal event closes a run's emitter, so the
   * runtime can clean up temporary collaboration agents tied to that
   * run. Set once at construction time by the runtime service.
   */
  setCleanupHook(hook: (runId: string) => Promise<void>): void {
    this.cleanupHook = hook;
  }

  ensureRunEmitter(runId: string): EventEmitter {
    let emitter = this.runEmitters.get(runId);
    if (!emitter) {
      emitter = new EventEmitter();
      this.runEmitters.set(runId, emitter);
    }
    return emitter;
  }

  getRunEmitter(runId: string): EventEmitter | null {
    return this.runEmitters.get(runId) || null;
  }

  hasEmitter(runId: string): boolean {
    return this.runEmitters.has(runId);
  }

  emitEvent(runId: string, type: string, data: any): void {
    const event = { type, data, timestamp: new Date().toISOString() };

    const emitter = this.runEmitters.get(runId);
    if (emitter) {
      emitter.emit('event', event);

      if (TERMINAL_EVENT_TYPES.includes(type)) {
        emitter.emit('done');
        this.runEmitters.delete(runId);
        if (this.cleanupHook) {
          this.cleanupHook(runId).catch(() => {});
        }
      }
    }

    // Capped, and given a TTL on every write rather than only on a
    // terminal one.
    //
    // Every streamed token is one XADD (llm.chunk is emitted per chunk),
    // so a 500-token reply is ~500 entries and a 10-step run about a
    // megabyte. The TTL was set only when a run emitted
    // completed/failed/cancelled -- and a run that times out never emits
    // one: the reaper flips it to TIMEOUT with a bare repository update
    // and calls nothing here. Same for a pod killed mid-run, and for
    // anything abandoned waiting on input or approval. Redis has no
    // default expiry, so those keys were immortal, full token history
    // included.
    //
    // MAXLEN ~ is the cheap approximate trim; the window is generous
    // enough that a live subscriber never loses events it has not read.
    const streamKey = `run:${runId}:events`;
    this.redis
      .xadd(streamKey, 'MAXLEN', '~', RUN_EVENT_STREAM_MAXLEN, '*', 'event', JSON.stringify(event))
      .catch((err) => {
        this.logger.warn(`Failed to write event to Redis stream ${streamKey}: ${err.message}`);
      });

    // A terminal event shortens it to the replay window; every other
    // write refreshes a long backstop, so an abandoned run still expires.
    this.redis
      .expire(streamKey, TERMINAL_EVENT_TYPES.includes(type) ? 300 : RUN_EVENT_STREAM_TTL_SECONDS)
      .catch(() => {});
  }

  /**
   * Subscribe to run events via Redis Streams (cross-pod). Calls
   * `handler` for each event. Resolves when a terminal event arrives,
   * the abort signal fires, or the timeout expires.
   *
   * When the timeout is what ends it, a synthetic `stream.timeout` event
   * is delivered first. A run can outlive the ceiling — the stream just
   * stopped, the run did not — and ending the subscription silently left
   * every client unable to tell "finished" from "we stopped watching".
   * The CLI reported whatever the next `getRun` said, which for a live
   * run is `running`, from a connection that had already closed.
   */
  async subscribeRunEvents(
    runId: string,
    handler: (event: { type: string; data: any; timestamp: string }) => void,
    signal?: AbortSignal,
    timeoutMs = 300_000,
  ): Promise<void> {
    const streamKey = `run:${runId}:events`;
    const deadline = Date.now() + timeoutMs;
    let lastId = '0';
    let sawTerminal = false;
    let aborted = false;

    const subscriber = this.redis.duplicate();

    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }

        const blockMs = Math.min(2000, deadline - Date.now());
        if (blockMs <= 0) break;

        const results = (await (subscriber as any).xread(
          'BLOCK',
          blockMs,
          'COUNT',
          100,
          'STREAMS',
          streamKey,
          lastId,
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!results) continue;

        for (const [, messages] of results) {
          for (const [id, fields] of messages) {
            lastId = id;
            const raw = fields[1];
            try {
              const event = JSON.parse(raw);
              handler(event);
              if (TERMINAL_EVENT_TYPES.includes(event.type)) {
                sawTerminal = true;
                return;
              }
            } catch {
              /* skip malformed */
            }
          }
        }
      }

      // Fell out of the loop with the run still going. Say so, so a
      // client can reconnect rather than guess.
      if (!sawTerminal && !aborted) {
        handler({
          type: 'stream.timeout',
          data: {
            runId,
            afterMs: timeoutMs,
            message:
              'This event stream reached its time limit. The run is still going server-side — subscribe again to keep watching.',
          },
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      subscriber.disconnect();
    }
  }

  /**
   * Tell live run views that a run's log moved: one small entry, the new
   * head, on `run:<id>:log`. The events themselves are read from
   * agent_run_events, so Redis never carries a run's content twice and a
   * viewer can never be told about an event it cannot read.
   */
  publishRunLogHead(written: RunWritten): void {
    const runId = written.after.id;
    const head = written.after.headSeq ?? 0;
    const key = runLogKey(runId);
    this.redis
      .xadd(key, 'MAXLEN', '~', RUN_LOG_STREAM_MAXLEN, '*', 'head', String(head))
      .catch((err) => this.logger.warn(`Failed to announce run log head on ${key}: ${err.message}`));
    this.redis.expire(key, written.after.isDone?.() ? 300 : RUN_EVENT_STREAM_TTL_SECONDS).catch(() => {});
  }

  /**
   * A live run view that can pick up where it left off (durable runs step
   * 2): every logged event after `afterSeq`, read from agent_run_events in
   * seq order, then the live stream, without a gap or a repeat between
   * the two.
   *
   * The handover: the positions of both Redis streams are taken before the
   * log is read, so every write that commits after the read announces a
   * head the loop below sees, and each announcement is answered by reading
   * the log after the last seq sent. Only the next seq is ever sent, so an
   * event cannot go out twice, and a viewer that misses an announcement
   * still gets the event at the next read (one every few seconds while the
   * stream is idle).
   *
   * `onLog` gets the logged events, `onEvent` the live runtime events
   * (tokens, step progress) from now on; those have no seq and are not
   * replayed. Ends on a terminal runtime event (after sending the rest of
   * the log), shortly after the log shows the run finished (a run that
   * ended before the viewer came has no terminal event left to wait for),
   * on abort, or at the timeout, with a `stream.timeout` event carrying the
   * last seq sent, from which a viewer reconnects.
   */
  async subscribeRunLog(
    runId: string,
    afterSeq: number,
    onLog: (event: AgentRunEvent) => void,
    onEvent: (event: { type: string; data: any; timestamp: string }) => void,
    signal?: AbortSignal,
    timeoutMs = 300_000,
  ): Promise<void> {
    const logKey = runLogKey(runId);
    const eventsKey = `run:${runId}:events`;
    const log = this.runRepository.manager.getRepository(AgentRunEvent);
    const deadline = Date.now() + timeoutMs;
    let last = Math.max(0, Math.floor(afterSeq));
    // When the log showed the run finished, and whether a terminal runtime event came.
    let loggedEndAt: number | null = null;
    let ended = false;
    let aborted = false;

    // Send the log after `last`, contiguously. A seq that is not the next
    // one ends the read: it is sent once the one before it can be.
    const drain = async (): Promise<void> => {
      for (;;) {
        const rows = await log.find({ where: { runId, seq: MoreThan(last) }, order: { seq: 'ASC' }, take: RUN_LOG_PAGE });
        for (const row of rows) {
          if (row.seq !== last + 1) return;
          last = row.seq;
          onLog(row);
          if (row.type === 'step_committed' && TERMINAL_RUN_STATES.includes(row.payload?.status)) {
            if (loggedEndAt === null) loggedEndAt = Date.now();
          }
        }
        if (rows.length < RUN_LOG_PAGE) return;
      }
    };

    const subscriber = this.redis.duplicate();
    const lastId = async (key: string): Promise<string> => {
      const latest = (await (subscriber as any).xrevrange(key, '+', '-', 'COUNT', 1)) as Array<[string, string[]]> | null;
      return latest?.[0]?.[0] ?? '0-0';
    };

    try {
      let logPos = await lastId(logKey);
      let eventsPos = await lastId(eventsKey);
      await drain();
      let drainedAt = Date.now();

      for (;;) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        const now = Date.now();
        // The log says the run is over: wait a moment for its terminal
        // runtime event (written just after the commit), then stop.
        const until = loggedEndAt === null ? deadline : Math.min(deadline, loggedEndAt + this.logEndGraceMs);
        const blockMs = Math.min(2000, until - now);
        if (blockMs <= 0) break;

        const results = (await (subscriber as any).xread(
          'BLOCK',
          blockMs,
          'COUNT',
          100,
          'STREAMS',
          logKey,
          eventsKey,
          logPos,
          eventsPos,
        )) as Array<[string, Array<[string, string[]]>]> | null;

        let moved = false;
        for (const [key, messages] of results ?? []) {
          for (const [id, fields] of messages) {
            if (key === logKey) {
              logPos = id;
              if (Number(fields[1]) > last) moved = true;
              continue;
            }
            eventsPos = id;
            try {
              const event = JSON.parse(fields[1]);
              onEvent(event);
              if (TERMINAL_EVENT_TYPES.includes(event.type)) ended = true;
            } catch {
              /* skip malformed */
            }
          }
        }
        // The run ended: whatever it logged last is read now.
        if (moved || ended || Date.now() - drainedAt >= this.logIdleReadMs) {
          await drain();
          drainedAt = Date.now();
        }
        if (ended) break;
      }

      if (!ended && loggedEndAt === null && !aborted && !signal?.aborted) {
        onEvent({
          type: 'stream.timeout',
          data: {
            runId,
            afterMs: timeoutMs,
            lastSeq: last,
            message:
              'This event stream reached its time limit. The run is still going server-side — subscribe again with the last seq to keep watching.',
          },
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      subscriber.disconnect();
    }
  }

  /**
   * Best-effort periodic sweep of orphaned run emitters: any emitter
   * whose run has been in a terminal state for >15 minutes is evicted.
   */
  async sweepOrphanedRunEmitters(): Promise<void> {
    if (this.runEmitters.size === 0) return;
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);

    for (const runId of Array.from(this.runEmitters.keys())) {
      try {
        const run = await this.runRepository.findOne({
          where: { id: runId },
          select: { id: true, status: true, updatedAt: true },
        });
        if (!run) {
          this.runEmitters.delete(runId);
          continue;
        }
        if (TERMINAL_RUN_STATES.includes(run.status as any) && run.updatedAt < cutoff) {
          this.runEmitters.delete(runId);
        }
      } catch {
        // best-effort
      }
    }
  }
}
