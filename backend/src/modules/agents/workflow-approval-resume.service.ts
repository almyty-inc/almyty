import { Inject, Injectable, Logger, OnModuleInit, Optional, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import type { ApprovalRequest } from '../../entities/approval-request.entity';
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { CodeModeService } from '../code-mode/code-mode.service';
import { safeErrorMessage } from '../llm-providers/llm-providers.service';
import { AgentExecutionEngine } from './agent-execution.engine';
import { SettledCodeStep, WorkflowWaitState, settledCodeStep } from './workflow-approval';

/**
 * Carries a workflow run on once a person has decided what its Code steps
 * asked for (workflow-approval.ts). A Code step whose script staged changes
 * stops its run in `waiting_approval`, and its change set waits in Approvals
 * marked with the run. When that request is decided this service settles the
 * change set itself (approved, the changes run once, in order; rejected or
 * expired, none of them does), and once every change set the run waits on is
 * settled, moves the run back to running and hands it to the engine to carry
 * on from those steps: approved, the step finishes with what the script
 * returned; rejected, the step ends "Rejected" and the run is cancelled.
 *
 * The decision arrives on the replica that took it ('approval.decided' is an
 * in-process event, as for autonomous runs). The run row is claimed
 * (waiting_approval -> running) before anything runs, so two decisions
 * landing together carry the run on once.
 */
@Injectable()
export class WorkflowApprovalResumeService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowApprovalResumeService.name);

  constructor(
    @InjectRepository(AgentExecution)
    private readonly executions: Repository<AgentExecution>,
    @InjectRepository(Agent)
    private readonly agents: Repository<Agent>,
    private readonly engine: AgentExecutionEngine,
    @Inject(forwardRef(() => ApprovalsService))
    private readonly approvals: ApprovalsService,
    @Optional()
    @Inject(forwardRef(() => CodeModeService))
    private readonly codeMode?: CodeModeService,
  ) {}

  onModuleInit(): void {
    this.approvals?.on?.('approval.decided', (row: ApprovalRequest) => {
      const executionId = row?.payload?.workflowExecutionId;
      if (!row || row.runId || row.payload?.kind !== 'change_set' || typeof executionId !== 'string') return;
      this.onDecided(row).catch((err: any) =>
        this.logger.error(`Could not carry on workflow run ${executionId} after approval ${row.id}: ${err?.message ?? err}`),
      );
    });
  }

  /** A workflow run's change set was decided: settle it, then carry the run on if nothing else is pending. */
  async onDecided(row: Pick<ApprovalRequest, 'id' | 'organizationId' | 'status' | 'payload'>): Promise<AgentExecution | null> {
    if (!this.codeMode) return null;
    // Runs the approved changes once (the script row is claimed first), or
    // marks a rejected or expired set as not run. Also for a run that no
    // longer waits (cancelled meanwhile): the decision still stands.
    await this.codeMode.decideHeld(row);
    return this.resumeIfDecided(row.payload?.workflowExecutionId, row.organizationId);
  }

  /**
   * Carry the run on when every change set it waits on is settled. Returns
   * the run as it ended up, or null when it is not waiting, or something it
   * waits on is still undecided or still running its changes.
   */
  async resumeIfDecided(executionId: string, organizationId: string): Promise<AgentExecution | null> {
    if (!this.codeMode) return null;
    const execution = await this.executions.findOne({ where: { id: executionId, organizationId } });
    if (!execution || execution.status !== AgentExecutionStatus.WAITING_APPROVAL) return null;
    const wait = execution.metadata?.waitingForApproval as WorkflowWaitState | undefined;
    if (!wait?.steps?.length) return null;

    const settled: Record<string, SettledCodeStep> = {};
    for (const step of wait.steps) {
      const approval = await this.approvals.findInOrganization(step.approvalId, organizationId);
      if (!approval || approval.status === 'pending') return null;
      const script = step.codeExecutionId ? await this.codeMode.findExecution(step.codeExecutionId, organizationId) : null;
      // Settled once the script's row says so; until then its changes are still running.
      if (script && script.status !== 'approved' && script.status !== 'rejected') return null;
      const decision = approval.status === 'approved' ? 'approved' : approval.status === 'expired' ? 'expired' : 'rejected';
      settled[step.nodeId] = settledCodeStep(decision, script?.changeSet ?? [], step.result, decision === 'rejected' ? approval.decisionReason : null);
    }

    const claim = await this.executions.update(
      { id: execution.id, organizationId, status: AgentExecutionStatus.WAITING_APPROVAL },
      { status: AgentExecutionStatus.RUNNING },
    );
    if (!claim.affected) return null;
    execution.status = AgentExecutionStatus.RUNNING;

    const agent = await this.agents.findOne({ where: { id: execution.agentId, organizationId } });
    try {
      if (!agent) throw new Error('The agent this run belongs to no longer exists');
      return await this.engine.execute(
        agent,
        organizationId,
        execution.userId,
        {
          input: execution.input ?? {},
          ...(wait.variables ? { variables: wait.variables } : {}),
          metadata: execution.metadata ?? {},
          ...(wait.principal ? { principal: wait.principal as ExecutionPrincipal } : {}),
        },
        undefined,
        { resume: { execution, settled } },
      );
    } catch (err: any) {
      // Refused before it could carry on (the agent is gone, or the run's
      // principal may no longer run it): the run ends here, saying why,
      // rather than sitting in running until the reaper times it out.
      await this.executions.update(
        { id: execution.id, status: AgentExecutionStatus.RUNNING },
        { status: AgentExecutionStatus.FAILED, error: `Could not carry on after the approval: ${safeErrorMessage(err)}` },
      );
      this.logger.warn(`Workflow run ${execution.id} could not carry on after its approval: ${err?.message ?? err}`);
      return null;
    }
  }
}
