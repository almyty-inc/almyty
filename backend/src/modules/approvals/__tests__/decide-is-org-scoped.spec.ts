import { NotFoundException } from '@nestjs/common';

import { ApprovalsService } from '../approvals.service';
import { ApprovalRequest } from '../../../entities/approval-request.entity';
import { fakeApprovalsRepo } from './approvals-repo.fixture';

/**
 * `POST /approvals/:id/approve|reject` read `req.user` and never used it.
 *
 * `decide()` loaded the row by id alone, and `AccessPolicyService` was the
 * only thing standing between the route and a cross-tenant write. It held
 * — a non-member gets no org role — but the "approval already <status>"
 * branch ran BEFORE that check, so the response separated three cases for
 * any UUID in the install: 404 (no such row), 400 "already approved" (a
 * decided row in another tenant, and its outcome), 403 (a pending row in
 * another tenant). A HITL approval queue is exactly the thing whose
 * existence and timing you do not want to leak.
 *
 * `findOne()` on the same service was already scoped. This is the
 * asymmetry closed.
 */
describe('approve/reject are scoped to the caller\'s organization', () => {
  const VICTIM_ORG = 'org-victim';
  const ATTACKER_ORG = 'org-attacker';

  function makeService(policyAllows = true) {
    const approvals = fakeApprovalsRepo();
    const policy = {
      canAccess: jest.fn(async () => ({ allowed: policyAllows, reason: 'not a member' })),
      applyListFilter: jest.fn(async () => ({ bypass: true, teamIds: [] })),
    };
    const svc = new ApprovalsService(
      approvals as any,
      { update: jest.fn(async () => ({ affected: 1 })) } as any,
      { find: jest.fn(async () => []), save: jest.fn(async (r: any) => r), create: (p: any) => p } as any,
      policy as any,
    );
    return { svc, approvals, policy };
  }

  /** A decided row belonging to the victim. */
  function victimRow(status: string): ApprovalRequest {
    return {
      id: 'a-victim',
      organizationId: VICTIM_ORG,
      status,
      teamId: null,
      visibility: 'org',
      runId: 'r',
      agentId: 'a',
    } as unknown as ApprovalRequest;
  }

  it('answers 404 for another tenant\'s DECIDED approval, not "already approved"', async () => {
    const { svc, approvals } = makeService();
    approvals.seed(victimRow('approved'));

    await expect(
      svc.approve('a-victim', { decidedBy: 'u-attacker' }, { id: 'u-attacker' }, ATTACKER_ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 for another tenant\'s PENDING approval, not 403', async () => {
    const { svc, approvals } = makeService(false);
    approvals.seed(victimRow('pending'));

    await expect(
      svc.reject('a-victim', { decidedBy: 'u-attacker' }, { id: 'u-attacker' }, ATTACKER_ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(approvals.row('a-victim')!.status).toBe('pending');
  });

  it('never even asks the access policy about a foreign row', async () => {
    // The org predicate is the gate; canAccess is the second layer, not
    // the first. If it is consulted at all here, the row was loaded.
    const { svc, approvals, policy } = makeService();
    approvals.seed(victimRow('pending'));

    await expect(
      svc.approve('a-victim', { decidedBy: 'u-attacker' }, { id: 'u-attacker' }, ATTACKER_ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(policy.canAccess).not.toHaveBeenCalled();
  });

  it('still decides a row in the caller\'s own organization', async () => {
    const { svc, approvals } = makeService();
    approvals.seed({ ...victimRow('pending'), organizationId: ATTACKER_ORG } as any);

    const decided = await svc.approve(
      'a-victim',
      { decidedBy: 'u-member' },
      { id: 'u-member' },
      ATTACKER_ORG,
    );
    expect(decided.status).toBe('approved');
    expect(approvals.row('a-victim')).toMatchObject({ status: 'approved', decidedBy: 'u-member' });
  });
});
