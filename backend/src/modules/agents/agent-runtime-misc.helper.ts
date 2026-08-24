import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Organization } from '../../entities/organization.entity';
import {
  ResolvedRunLimits,
  RunLimitTrip,
  checkRunLimits,
  resolveRunLimits,
} from './run-limits';
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
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
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
   * Resolve the ceilings that apply to a run.
   *
   * Min-wins across the operator env floor, the organization, the agent
   * and the run, so nothing below can raise what something above set.
   * Resolved at the point of use rather than read off the run, which is
   * what lets tightening org policy take effect on the next step instead
   * of only on runs created afterwards.
   */
  async resolveLimits(run: AgentRun): Promise<ResolvedRunLimits> {
    let organization: Organization | null = null;
    try {
      organization = await this.organizationRepository.findOne({
        where: { id: run.organizationId },
      });
    } catch (err: any) {
      // A ceiling we cannot read must not become a ceiling we ignore;
      // the env floor still applies because resolveRunLimits clamps to
      // it regardless.
      this.logger.warn(`Could not load organization limits for run ${run.id}: ${err.message}`);
    }

    return resolveRunLimits({ organization, agent: run.agent, run });
  }

  /**
   * Check the run ledger against its resolved ceilings.
   *
   * Returns a machine-readable code paired with a sentence the caller
   * can act on, never a bare stop. The dollars-versus-cents conversion
   * that used to live here now sits in checkRunLimits, next to the
   * comparison it belongs to.
   */
  async checkLimits(run: AgentRun): Promise<RunLimitTrip | null> {
    const limits = await this.resolveLimits(run);
    return checkRunLimits(run, limits);
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
