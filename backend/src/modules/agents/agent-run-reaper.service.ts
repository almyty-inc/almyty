import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, In } from 'typeorm';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';

/**
 * Reaps stuck agent runs.
 *
 * The autonomous runtime persists a run as RUNNING and advances it one
 * BullMQ step at a time, writing the row (and therefore `updatedAt`) on
 * every step. If the worker process dies mid-step, or a `next-step` job is
 * lost after its retries are exhausted, the row is left RUNNING forever:
 * `maxDurationMs` is only enforced from inside `processStep`, which never
 * runs again, so the run never reaches a terminal state. These leaked
 * "running" rows accumulate and skew sibling cost/limit accounting.
 *
 * This sweep transitions a RUNNING run to TIMEOUT once it has made no
 * progress (no DB write) for `STALE_RUN_MS`. The window is deliberately
 * generous — far longer than any single legitimate step (an LLM/tool call
 * is socket-timeout-bounded, and a blocking sub-agent `waitForRun` caps at
 * a few minutes) — so a run that is genuinely still working is never
 * reaped. Non-terminal states that legitimately idle (`WAITING_INPUT`
 * pending a human, `SLEEPING` pending a scheduled resume, `PENDING` newly
 * queued) are intentionally left alone.
 */
const STALE_RUN_MS = Number(process.env.AGENT_RUN_STALE_MS) || 30 * 60_000; // 30 min
const REAP_INTERVAL_MS = Number(process.env.AGENT_RUN_REAP_INTERVAL_MS) || 5 * 60_000; // 5 min
const REAP_BATCH = 200;

@Injectable()
export class AgentRunReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRunReaperService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.reapStuckRuns().catch((err) => {
        this.logger.warn(`Stuck-run sweep failed: ${err.message}`);
      });
    }, REAP_INTERVAL_MS);
    // Don't keep the event loop alive for the timer (matches the other
    // runtime sweeps); lets the process exit cleanly in tests/shutdown.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Mark RUNNING runs with no progress past the stale window as TIMEOUT.
   * Batched to bound the size of any single UPDATE. Returns the number of
   * rows reaped (primarily for tests).
   */
  async reapStuckRuns(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_RUN_MS);

    const stuck = await this.runRepository.find({
      where: { status: AgentRunStatus.RUNNING, updatedAt: LessThan(cutoff) },
      select: { id: true },
      take: REAP_BATCH,
    });
    if (stuck.length === 0) return 0;

    const ids = stuck.map((r) => r.id);
    // Guard the UPDATE on status so we never clobber a run that just
    // transitioned to a terminal/non-terminal state between the read and
    // the write.
    await this.runRepository.update(
      { id: In(ids), status: AgentRunStatus.RUNNING },
      {
        status: AgentRunStatus.TIMEOUT,
        error: `Run timed out: no progress for over ${Math.round(STALE_RUN_MS / 60_000)} minutes (worker likely terminated).`,
      },
    );

    this.logger.warn(`Reaped ${ids.length} stuck run(s) to TIMEOUT`);
    return ids.length;
  }
}
