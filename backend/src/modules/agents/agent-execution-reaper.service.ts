import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, In } from 'typeorm';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';

/**
 * Reaps stuck workflow executions.
 *
 * `AgentRunReaperService` has always swept `AgentRun`, the autonomous
 * path's row. Nothing swept `AgentExecution`, the workflow path's — so a
 * pod killed mid-pipeline left its row RUNNING forever. Every ceiling a
 * workflow run has (`maxExecutionTime`, the budget checks, the final
 * terminal write) is enforced from inside `AgentExecutionEngine.execute`,
 * which never runs again after the process dies. The row was never looked
 * at by anything else, so it sat RUNNING for good: visible as a live run
 * in the UI, counted as in-flight by anything reading status, and never
 * reconciled.
 *
 * Judged on `createdAt`, not `updatedAt`. This is the one real difference
 * from the run reaper, and it is deliberate: an `AgentRun` is written on
 * every step, so a lack of writes means a lack of progress. An
 * `AgentExecution` is written once when it starts and then not again
 * until it finishes, so `updatedAt` says nothing about progress and a
 * perfectly healthy long run would look stale immediately.
 *
 * The window is therefore a wall-clock ceiling on any workflow run, and
 * generously above the engine's own 5-minute `maxExecutionTime` default
 * so an agent configured with a longer one is not cut short by this
 * sweep. Raise `AGENT_EXECUTION_STALE_MS` alongside any `maxExecutionTime`
 * that approaches it.
 *
 * PENDING is swept on the same clock: an execution row is created RUNNING,
 * so a row still sitting at the column default long after it was created
 * never reached the engine at all.
 */
const STALE_EXECUTION_MS = Number(process.env.AGENT_EXECUTION_STALE_MS) || 60 * 60_000; // 60 min
const REAP_INTERVAL_MS = Number(process.env.AGENT_EXECUTION_REAP_INTERVAL_MS) || 5 * 60_000; // 5 min
const REAP_BATCH = 200;

@Injectable()
export class AgentExecutionReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentExecutionReaperService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(AgentExecution)
    private readonly executionRepository: Repository<AgentExecution>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.reapStuckExecutions().catch((err) => {
        this.logger.warn(`Stuck-execution sweep failed: ${err.message}`);
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
   * Mark executions past the wall-clock ceiling as TIMEOUT. Batched to
   * bound the size of any single UPDATE. Returns the number of rows
   * reaped (primarily for tests).
   */
  async reapStuckExecutions(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_EXECUTION_MS);
    const sweepable = [AgentExecutionStatus.RUNNING, AgentExecutionStatus.PENDING];

    const stuck = await this.executionRepository.find({
      where: { status: In(sweepable), createdAt: LessThan(cutoff) },
      select: { id: true },
      take: REAP_BATCH,
    });
    if (stuck.length === 0) return 0;

    const ids = stuck.map((e) => e.id);
    // Guard the UPDATE on status, so a run that reached a terminal state
    // between this read and this write — finished on its own, or was
    // cancelled — is not clobbered back to TIMEOUT. Same reason the
    // engine's own terminal writes are guarded.
    const result = await this.executionRepository.update(
      { id: In(ids), status: In(sweepable) },
      {
        status: AgentExecutionStatus.TIMEOUT,
        error:
          `Execution timed out: still running ${Math.round(STALE_EXECUTION_MS / 60_000)} minutes after it ` +
          'started, so the process running it is gone.',
      },
    );

    const reaped = result.affected ?? ids.length;
    this.logger.warn(`Reaped ${reaped} stuck execution(s) to TIMEOUT`);
    return reaped;
  }
}
