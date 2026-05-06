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

    const streamKey = `run:${runId}:events`;
    this.redis.xadd(streamKey, '*', 'event', JSON.stringify(event)).catch((err) => {
      this.logger.warn(`Failed to write event to Redis stream ${streamKey}: ${err.message}`);
    });

    if (TERMINAL_EVENT_TYPES.includes(type)) {
      this.redis.expire(streamKey, 300).catch(() => {});
    }
  }

  /**
   * Subscribe to run events via Redis Streams (cross-pod). Calls
   * `handler` for each event. Resolves when a terminal event arrives,
   * the abort signal fires, or the timeout expires.
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

    const subscriber = this.redis.duplicate();

    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) break;

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
                return;
              }
            } catch {
              /* skip malformed */
            }
          }
        }
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
          select: ['id', 'status', 'updatedAt'],
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
