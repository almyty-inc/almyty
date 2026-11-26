import { BadRequestException } from '@nestjs/common';

import { ApprovalsService, RUN_CANCELLED_REASON } from '../approvals.service';
import { ApprovalRequest } from '../../../entities/approval-request.entity';
import { fakeApprovalsRepo } from './approvals-repo.fixture';

/**
 * Cancelling a run that waited in waiting_approval left its requests
 * pending in the Approvals queue until they expired (24 h), and approving
 * one later did nothing: the decision handler ignores a run that no longer
 * waits. closeForRun / closeRequests take them out of the queue as
 * 'cancelled', with the reason, and decide nothing: no 'approval.decided'
 * event, so nothing they hold runs and no run resumes.
 */
describe('ApprovalsService: closing the requests of a cancelled run', () => {
  const row = (over: Partial<ApprovalRequest>): Partial<ApprovalRequest> => ({
    organizationId: 'org-1',
    teamId: null,
    visibility: 'org',
    agentId: 'agent-1',
    toolId: null,
    toolCallId: null,
    reason: 'Send the invoice',
    payload: null,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    ...over,
  });

  function makeService() {
    const approvals = fakeApprovalsRepo([
      row({ id: 'own-1', runId: 'run-1', toolCallId: 'tc-1' }),
      row({ id: 'own-2', runId: 'run-1', toolCallId: 'tc-2', payload: { _gate: { kind: 'tool_amount' } } }),
      row({ id: 'own-decided', runId: 'run-1', toolCallId: 'tc-0', status: 'approved', decidedBy: 'u-ana', decisionReason: 'fine' }),
      row({ id: 'other-run', runId: 'run-2', toolCallId: 'tc-9' }),
      row({ id: 'held-call', runId: null, toolId: 'tool-refund', payload: { _gate: { kind: 'tool_amount' } } }),
      row({ id: 'other-org', runId: 'run-1', organizationId: 'org-2', toolCallId: 'tc-1' }),
    ]);
    const policy = {
      canAccess: jest.fn(async () => ({ allowed: true })),
      applyListFilter: jest.fn(async () => ({ bypass: true, teamIds: [] })),
    };
    const auditLog = { log: jest.fn(async () => null) };
    const svc = new ApprovalsService(
      approvals as any,
      { update: jest.fn(async () => ({ affected: 1 })), findOne: jest.fn(async () => null) } as any,
      { find: jest.fn(async () => []), save: jest.fn(async (r: any) => r), create: (p: any) => p } as any,
      policy as any,
      undefined,
      undefined,
      undefined,
      auditLog as any,
    );
    const decided = jest.fn();
    svc.on('approval.decided', decided);
    return { svc, approvals, auditLog, decided };
  }

  it("closes the run's pending requests as cancelled, saying the run was cancelled", async () => {
    const { svc, approvals } = makeService();

    const closed = await svc.closeForRun('run-1', 'org-1', 'u-bob');

    expect(closed.map((r) => r.id).sort()).toEqual(['own-1', 'own-2']);
    for (const id of ['own-1', 'own-2']) {
      expect(approvals.row(id)).toMatchObject({
        status: 'cancelled',
        decisionReason: RUN_CANCELLED_REASON,
        decidedBy: null,
      });
      expect(approvals.row(id)!.decidedAt).toBeInstanceOf(Date);
    }
    expect(RUN_CANCELLED_REASON).toMatch(/run cancelled/);
    // They leave the pending queue.
    const queue = await svc.listPending({ organizationId: 'org-1', caller: { id: 'u-bob' } });
    expect(queue.map((r) => r.id)).not.toEqual(expect.arrayContaining(['own-1']));
    expect(queue.map((r) => r.id)).not.toEqual(expect.arrayContaining(['own-2']));
  });

  it("leaves other runs' requests, held calls, another org's and already-decided requests untouched", async () => {
    const { svc, approvals } = makeService();

    await svc.closeForRun('run-1', 'org-1', 'u-bob');

    expect(approvals.row('other-run')).toMatchObject({ status: 'pending', decisionReason: null });
    expect(approvals.row('held-call')).toMatchObject({ status: 'pending', decisionReason: null });
    expect(approvals.row('other-org')).toMatchObject({ status: 'pending', decisionReason: null });
    expect(approvals.row('own-decided')).toMatchObject({ status: 'approved', decidedBy: 'u-ana', decisionReason: 'fine' });
  });

  it('decides nothing: no approval.decided event, so no held call runs and no run resumes', async () => {
    const { svc, decided, auditLog } = makeService();

    await svc.closeForRun('run-1', 'org-1', 'u-bob');

    expect(decided).not.toHaveBeenCalled();
    // On the audit trail, with who cancelled.
    expect(auditLog.log).toHaveBeenCalledTimes(2);
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-bob', resourceId: 'own-1', status: 'cancelled', details: expect.objectContaining({ note: RUN_CANCELLED_REASON }) }),
    );
  });

  it('a closed request can no longer be approved: refused, and still nothing runs', async () => {
    const { svc, approvals, decided } = makeService();
    await svc.closeForRun('run-1', 'org-1', 'u-bob');

    await expect(svc.approve('own-1', { decidedBy: 'u-ana' }, { id: 'u-ana' }, 'org-1')).rejects.toThrow(
      new BadRequestException('approval already cancelled'),
    );
    expect(approvals.row('own-1')!.status).toBe('cancelled');
    expect(decided).not.toHaveBeenCalled();
  });

  it('is idempotent: a second close finds nothing pending', async () => {
    const { svc } = makeService();
    await svc.closeForRun('run-1', 'org-1', 'u-bob');
    expect(await svc.closeForRun('run-1', 'org-1', 'u-bob')).toEqual([]);
  });

  it('closeRequests closes only the given pending ids in the org', async () => {
    const { svc, approvals, decided } = makeService();

    const closed = await svc.closeRequests(['held-call', 'own-decided', 'other-org'], 'org-1', 'u-bob');

    expect(closed.map((r) => r.id)).toEqual(['held-call']);
    expect(approvals.row('held-call')).toMatchObject({ status: 'cancelled', decisionReason: RUN_CANCELLED_REASON });
    expect(approvals.row('own-decided')!.status).toBe('approved');
    expect(approvals.row('other-org')!.status).toBe('pending');
    expect(decided).not.toHaveBeenCalled();
  });
});
