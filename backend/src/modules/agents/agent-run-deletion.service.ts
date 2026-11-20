import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { assertManageable } from '../../common/authorization/read-rule';
import { AuditLogService } from '../audit-log/audit-log.service';
import { isFinishedRunStatus, removeRuns } from './run-removal';

export const RUN_STILL_GOING =
  'This run is still going. Cancel it or wait for it to finish, then delete it.';

/**
 * "Delete run": one finished run of an agent, removed on request by
 * someone who may manage the agent (the rule editing and deleting the
 * agent use: its owner, an org owner or admin, a team lead of its team).
 *
 * The run goes the way a visitor's erasure removes runs (run-removal.ts):
 * the run row with its event log and approval requests, and the tool
 * calls it made. The agent's counters (totalExecutions and the rest) are
 * lifetime counts and stay as they are, as they do when the retention
 * sweep deletes old runs.
 */
@Injectable()
export class AgentRunDeletionService {
  private readonly logger = new Logger(AgentRunDeletionService.name);

  constructor(
    @InjectRepository(Agent)
    private readonly agents: Repository<Agent>,
    @InjectRepository(AgentRun)
    private readonly runs: Repository<AgentRun>,
    private readonly accessPolicy: AccessPolicyService,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  async deleteRun(
    agentId: string,
    runId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ id: string; toolCalls: number }> {
    const agent = await this.agents.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');
    await assertManageable(this.accessPolicy, userId, agent, 'Agent', { ownerManages: true });

    const removed = await this.runs.manager.transaction(async (tx) => {
      // Read under a row lock, so a run cannot be resumed between the
      // check and the delete.
      const run = await tx.getRepository(AgentRun).findOne({
        where: { id: runId, organizationId, agentId },
        select: { id: true, status: true, agentId: true, organizationId: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!run) throw new NotFoundException('Run not found');
      if (!isFinishedRunStatus(run.status)) throw new ConflictException(RUN_STILL_GOING);
      return removeRuns(tx, organizationId, [run.id]);
    });

    // Ids only: what the run said is gone with it, and stays gone.
    await this.auditLog
      ?.log({
        organizationId,
        userId,
        action: AuditAction.DELETE,
        resourceType: AuditResource.AGENT_RUN,
        resourceId: runId,
        details: { agentId, toolCalls: removed.toolCalls },
      })
      .catch((err) => this.logger.warn(`Could not record the deletion of run ${runId}: ${err?.message ?? err}`));

    return { id: runId, toolCalls: removed.toolCalls };
  }
}
