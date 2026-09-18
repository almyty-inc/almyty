import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { EventEmitter } from 'events';

import { AgentRun } from '../../entities/agent-run.entity';

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

  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
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
