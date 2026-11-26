import { BadRequestException } from '@nestjs/common';

import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { ApprovalRequest } from '../../../entities/approval-request.entity';
import { Message } from '../../../entities/message.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { runsWithEvents } from '../../../test/fake-run-events';
import { ApprovalsService, RUN_CANCELLED_REASON } from '../../approvals/approvals.service';
import { fakeApprovalsRepo } from '../../approvals/__tests__/approvals-repo.fixture';
import { AgentRuntimeService } from '../agent-runtime.service';

/**
 * Seen on staging (26 Nov 2026): runs cancelled while waiting_approval kept
 * their approval requests pending in the queue until they expired, and
 * approving one did nothing. cancelRun now closes the run's pending
 * requests as 'cancelled' with the reason; the run is not resumed and
 * nothing a request held runs, then or when someone tries to approve it.
 */
describe('cancelling an autonomous run closes its pending approval requests', () => {
  const req = (over: Partial<ApprovalRequest>): Partial<ApprovalRequest> => ({
    organizationId: 'org-1',
    teamId: null,
    visibility: 'org',
    agentId: 'agent-1',
    toolId: null,
    reason: 'Issue refund',
    payload: null,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    ...over,
  });

  function setup() {
    const runs = runsWithEvents([
      { id: 'run-1', organizationId: 'org-1', agentId: 'agent-1', status: AgentRunStatus.WAITING_APPROVAL, currentStep: 3 },
      { id: 'run-2', organizationId: 'org-1', agentId: 'agent-1', status: AgentRunStatus.WAITING_APPROVAL, currentStep: 1 },
    ]);
    const rows = fakeApprovalsRepo([
      // request_approval's own request, and a call an amount rule held for the run.
      req({ id: 'ask', runId: 'run-1', toolCallId: 'tc-1' }),
      req({ id: 'held', runId: 'run-1', toolCallId: 'tc-2', payload: { _gate: { kind: 'tool_amount', toolId: 'tool-refund' } } }),
      req({ id: 'decided', runId: 'run-1', toolCallId: 'tc-0', status: 'rejected', decidedBy: 'u-ana', decisionReason: 'no' }),
      req({ id: 'other', runId: 'run-2', toolCallId: 'tc-9' }),
    ]);
    const approvals = new ApprovalsService(
      rows as any,
      runs as any,
      { find: jest.fn(async () => []), save: jest.fn(async (r: any) => r), create: (p: any) => p } as any,
      { canAccess: jest.fn(async () => ({ allowed: true })), applyListFilter: jest.fn(async () => ({ bypass: true })) } as any,
    );
    const runtimeQueue = { add: jest.fn() };
    const svc: any = Object.create(AgentRuntimeService.prototype);
    Object.assign(svc, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      runRepository: runs,
      messageRepository: fakeRepository<Message>({ make: () => new Message(), idPrefix: 'msg' }),
      runtimeQueue,
      workspaceRepository: fakeRepository({ seed: [] }),
      emitEvent: jest.fn(),
      events: { emitEvent: jest.fn() },
      approvals,
      getRun: jest.fn(async (id: string) => runs.row(id)),
    });
    // As onModuleInit wires it: a decision resumes or ends the run.
    const handled = jest.fn((a: any) => svc.handleApprovalDecided(a));
    approvals.on('approval.decided', handled);
    return { svc, runs, rows, approvals, runtimeQueue, handled };
  }

  it("closes the run's pending requests as cancelled with the cancel reason", async () => {
    const { svc, runs, rows } = setup();

    await svc.cancelRun('run-1', 'org-1', 'agent-1', 'u-bob');

    expect(runs.row('run-1')!.status).toBe(AgentRunStatus.CANCELLED);
    for (const id of ['ask', 'held']) {
      expect(rows.row(id)).toMatchObject({ status: 'cancelled', decisionReason: RUN_CANCELLED_REASON, decidedBy: null });
    }
  });

  it("leaves other runs' requests and already-decided ones untouched", async () => {
    const { svc, runs, rows } = setup();

    await svc.cancelRun('run-1', 'org-1', 'agent-1', 'u-bob');

    expect(rows.row('other')).toMatchObject({ status: 'pending', decisionReason: null });
    expect(rows.row('decided')).toMatchObject({ status: 'rejected', decidedBy: 'u-ana', decisionReason: 'no' });
    expect(runs.row('run-2')!.status).toBe(AgentRunStatus.WAITING_APPROVAL);
  });

  it('runs no held call and resumes nothing, then or when someone tries to approve afterwards', async () => {
    const { svc, runs, rows, approvals, runtimeQueue, handled } = setup();

    await svc.cancelRun('run-1', 'org-1', 'agent-1', 'u-bob');
    expect(handled).not.toHaveBeenCalled();
    expect(runtimeQueue.add).not.toHaveBeenCalled();

    for (const id of ['ask', 'held']) {
      await expect(approvals.approve(id, { decidedBy: 'u-ana' }, { id: 'u-ana' }, 'org-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(rows.row(id)!.status).toBe('cancelled');
    }
    expect(handled).not.toHaveBeenCalled();
    expect(runtimeQueue.add).not.toHaveBeenCalled();
    expect(runs.row('run-1')!.status).toBe(AgentRunStatus.CANCELLED);
  });

  it('a request approved a moment before the cancel keeps its decision', async () => {
    const { svc, rows } = setup();
    await rows.update({ id: 'ask' }, { status: 'approved', decidedBy: 'u-ana' } as any);

    await svc.cancelRun('run-1', 'org-1', 'agent-1', 'u-bob');

    expect(rows.row('ask')).toMatchObject({ status: 'approved', decidedBy: 'u-ana' });
    expect(rows.row('held')!.status).toBe('cancelled');
  });
});
