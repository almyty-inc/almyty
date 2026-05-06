import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import { ExecutionErrorType } from './agent-execution-validators.helper';
import { StreamEvent } from './stream-event.types';

export interface FailureOpts {
  status: AgentExecutionStatus;
  error: string;
  errorType: ExecutionErrorType | 'CANCELLED';
  executionTime: number;
  totalCost: number;
  totalTokens: number;
  nodeResults: Record<string, any>;
}

@Injectable()
export class AgentExecutionStateHelper {
  private readonly logger = new Logger(AgentExecutionStateHelper.name);

  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectRepository(AgentExecution)
    private readonly agentExecutionRepository: Repository<AgentExecution>,
  ) {}

  /**
   * Atomically update an agent's running stats via a single SQL UPDATE.
   * The rolling average uses the Welford formula
   *   new_avg = old_avg + (x - old_avg) / new_count
   * which Postgres evaluates atomically under MVCC, so concurrent
   * updates can't lose increments or drift the average.
   */
  async bumpAgentStats(
    agentId: string,
    success: boolean,
    executionTime: number,
    cost: number,
  ): Promise<void> {
    try {
      await this.agentRepository
        .createQueryBuilder()
        .update(Agent)
        .set({
          totalExecutions: () => '"totalExecutions" + 1',
          successfulExecutions: success
            ? () => '"successfulExecutions" + 1'
            : () => '"successfulExecutions"',
          totalCost: () => `"totalCost" + ${Number(cost) || 0}`,
          averageExecutionTime: () =>
            `ROUND("averageExecutionTime" + (${Number(executionTime) || 0} - "averageExecutionTime") / ("totalExecutions" + 1))`,
          lastExecutedAt: new Date(),
        })
        .where('id = :id', { id: agentId })
        .execute();
    } catch (err: any) {
      this.logger.error(`Failed to update agent stats: ${err.message}`);
    }
  }

  /**
   * Wrap a promise with a timeout. The timer is explicitly cleared on
   * settlement so it doesn't keep the event loop alive past the layer.
   */
  async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    if (timeoutMs <= 0) {
      throw new Error(message);
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    try {
      return (await Promise.race([promise, timeout])) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  emitEvent(onEvent: ((event: StreamEvent) => void) | undefined, event: StreamEvent): void {
    if (onEvent) {
      try {
        onEvent(event);
      } catch (err: any) {
        this.logger.warn(`Failed to emit stream event: ${err.message}`);
      }
    }
  }

  /**
   * Persist a failed execution, bump agent stats, emit the failure
   * event, and return the execution record. Centralizes the
   * boilerplate that fires on cancel / timeout / budget / failed
   * pipelines so each call site only carries the relevant fields.
   */
  async finalizeFailure(
    execution: AgentExecution,
    agentId: string,
    opts: FailureOpts,
    onEvent: ((event: StreamEvent) => void) | undefined,
  ): Promise<AgentExecution> {
    execution.status = opts.status;
    execution.error = opts.error;
    execution.executionTime = opts.executionTime;
    execution.totalCost = opts.totalCost;
    execution.totalTokens = opts.totalTokens;
    execution.nodeResults = opts.nodeResults;
    await this.agentExecutionRepository.save(execution);
    await this.bumpAgentStats(agentId, false, opts.executionTime, opts.totalCost);

    this.emitEvent(onEvent, {
      type: 'execution.failed',
      data: { error: opts.error, errorType: opts.errorType, executionId: execution.id },
      timestamp: Date.now(),
    });

    return execution;
  }
}
