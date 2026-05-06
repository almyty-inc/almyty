import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { CanonicalMemoryService } from '../memory/canonical/canonical-memory.service';
import { Provenance } from '../memory/canonical/canonical.types';

/**
 * Small private helpers split out of AgentRuntimeService:
 * temp-agent cleanup, run-status polling, post-run memory snapshot,
 * resource-limit checks, sleep, and the atomic stats bump.
 *
 * These are short enough on their own; bundling them into a single
 * helper keeps the runtime service focused on the step processor.
 */
@Injectable()
export class AgentRuntimeMiscHelper {
  private readonly logger = new Logger(AgentRuntimeMiscHelper.name);

  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @Inject(forwardRef(() => CanonicalMemoryService))
    private readonly memoryService: CanonicalMemoryService,
  ) {}

  async cleanupTemporaryAgents(runId: string): Promise<void> {
    try {
      const tempAgents = await this.agentRepository.find({
        where: { isTemporary: true, parentRunId: runId },
      });
      if (tempAgents.length > 0) {
        await this.agentRepository.remove(tempAgents);
        this.logger.log(`Cleaned up ${tempAgents.length} temporary agent(s) for run ${runId}`);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to cleanup temporary agents for run ${runId}: ${err.message}`);
    }
  }

  /** Poll for a run to reach a terminal state, with a hard timeout. */
  async waitForRun(runId: string, timeoutMs: number): Promise<AgentRun | null> {
    const pollInterval = 1000;
    const maxAttempts = Math.ceil(timeoutMs / pollInterval);

    for (let i = 0; i < maxAttempts; i++) {
      const run = await this.runRepository.findOne({ where: { id: runId } });
      if (!run) return null;
      if (run.isDone()) return run;
      await this.sleep(pollInterval);
    }

    try {
      const run = await this.runRepository.findOne({ where: { id: runId } });
      if (run && !run.isDone()) {
        run.status = AgentRunStatus.TIMEOUT;
        run.error = 'Timed out waiting for sub-agent';
        await this.runRepository.save(run);
      }
      return run;
    } catch {
      return null;
    }
  }

  /** Auto-save a summary of the run as a canonical memory entry. */
  async autoSaveMemory(run: AgentRun, agent: Agent): Promise<void> {
    try {
      if (run.status !== AgentRunStatus.COMPLETED || !run.output) return;

      const inputSummary = typeof run.input === 'string' ? run.input : JSON.stringify(run.input);
      const outputSummary = typeof run.output === 'string' ? run.output : JSON.stringify(run.output);

      if (inputSummary.length < 20 && outputSummary.length < 20) return;

      const content = `Task: ${inputSummary.substring(0, 500)}\nResult: ${outputSummary.substring(0, 500)}`;

      const provenance: Provenance = {
        agent_id: agent.id,
        session_id: run.id,
        collab_id: null,
        model: null,
        provider: null,
        tool_chain: ['auto_save'],
        created_by: 'agent',
        source_backend: 'almyty-native',
      };
      await this.memoryService.put(
        {
          mode: 'memory',
          scope: { scope_type: 'workspace', scope_id: run.organizationId },
          content,
          tier: 'project',
          tags: ['auto-saved', 'agent-run'],
          metadata: { source: { type: 'agent_runtime', id: run.id, name: agent.name } },
          provenance,
        },
        { user_id: run.userId },
      );
    } catch (err: any) {
      this.logger.warn(`Failed to auto-save memory for run ${run.id}: ${err.message}`);
    }
  }

  /**
   * Check resource limits.
   *
   * Unit note: `run.totalCost` accumulates values from `llmResponse.cost`, which
   * `LlmProvidersService.calculateProviderCost` returns in **dollars**. The
   * `maxCostCents` limit is, per its name, in **cents**. We therefore multiply
   * `totalCost` by 100 when comparing — previously the comparison was
   * dollars-vs-cents, which silently allowed a 100x cost overrun.
   */
  checkLimits(run: AgentRun): string | null {
    const limits = run.limits || {};

    if (run.currentStep >= (limits.maxSteps || run.maxSteps)) {
      return 'MAX_STEPS_EXCEEDED';
    }
    if (limits.maxCostCents && run.totalCost * 100 >= limits.maxCostCents) {
      return 'BUDGET_EXCEEDED';
    }
    if (limits.maxDurationMs && Date.now() - run.createdAt.getTime() > limits.maxDurationMs) {
      return 'TIMEOUT';
    }
    if (limits.maxTokens && run.totalTokens >= limits.maxTokens) {
      return 'TOKEN_LIMIT_EXCEEDED';
    }
    return null;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Atomically bump an agent's running stats. Mirrors the helper in
   * AgentExecutionEngine; both paths used to do a load-modify-save pair
   * which lost increments under concurrency.
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
}
