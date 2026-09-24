import { BadRequestException } from '@nestjs/common';
import { ApprovalsService } from '../approvals.service';
import { ApprovalPolicyApproval } from '../../../common/ee-hooks/ee-hooks';
import { FakePolicyApprovalsRepo } from './fake-policy-approvals';
import { fakeApprovalsRepo } from './approvals-repo.fixture';

/**
 * EE (approval_policy): a quorum has to be able to count.
 *
 * The collected approvals used to live in a JSONB accumulator on the
 * request row, and every reviewer read the list, appended itself and
 * wrote the whole list back. A multi-reviewer queue is the designed use
 * case, so two reviewers acting at once is normal — and on a 3-of-N
 * gate holding [A], reviewer B wrote [A,B] while reviewer C, who had
 * loaded before B committed, wrote [A,C] over it. B's approval was gone.
 * Two outcomes, both bad: the quorum never completes and a properly
 * approved request expires denied, or the erased approver drops out of
 * the repeat-approver guard and one human satisfies a 3-of-3 twice over.
 *
 * The repo fakes here model the two writes honestly. The request table
 * is the shared truthful fixture: every read hands out a detached copy
 * the way a real read does, a save stores a copy rather than the
 * caller's object, and the status flip is a real compare-and-set. The
 * approvals table enforces its unique (requestId, approverId) index. A
 * fake that shared one object between reviewers, or between the service
 * and the table, or that accepted every insert, would show none of these
 * failures however the service was written.
 */
class FakeRunsRepo {
  async update() { return { affected: 1 }; }
}

class FakeAccessPolicy {
  async canAccess() { return { allowed: true, reason: 'ok' }; }
  async applyListFilter() { return { bypass: true, teamIds: [] }; }
  async getOrgRole() { return 'admin'; }
  async getTeamMemberships() { return new Map<string, string>(); }
}

/** N approvals from anyone satisfy the policy. Counts DISTINCT approvers. */
function makeQuorumHook(required: number) {
  return {
    resolveForContext: jest.fn(async () => ({ id: 'pol-1', name: `${required}-approver quorum` })),
    scoreProgress: jest.fn(
      async (_org: string, policyId: string, approvals: ApprovalPolicyApproval[]) => {
        const distinct = new Set(approvals.map((a) => a.approverId)).size;
        return {
          policyId,
          policyName: `${required}-approver quorum`,
          totalRequired: required,
          totalCollected: approvals.length,
          steps: [
            {
              index: 0,
              name: 'quorum',
              approverRole: '*',
              required,
              satisfiedBy: Math.min(distinct, required),
              satisfied: distinct >= required,
            },
          ],
          currentStep: distinct >= required ? -1 : 0,
          satisfied: distinct >= required,
        };
      },
    ),
  };
}

function makeService(required: number) {
  const approvals = fakeApprovalsRepo();
  const policyApprovals = new FakePolicyApprovalsRepo();
  const hook = makeQuorumHook(required);
  const svc = new ApprovalsService(
    approvals as any,
    new FakeRunsRepo() as any,
    policyApprovals as any,
    new FakeAccessPolicy() as any,
    hook,
  );
  return { svc, approvals, policyApprovals, hook };
}

const createInput = {
  organizationId: 'org-1',
  teamId: null,
  runId: 'r1',
  agentId: 'ag1',
  reason: 'wire transfer over 10k',
  payload: { amount: 25000 },
};

/** What the hook was asked to score on its most recent call. */
const lastScored = (hook: any): ApprovalPolicyApproval[] =>
  hook.scoreProgress.mock.calls[hook.scoreProgress.mock.calls.length - 1][2];

describe('a quorum does not lose an approver', () => {
  it('two reviewers who both loaded before either committed are both counted', async () => {
    const { svc, approvals, hook, policyApprovals } = makeService(3);
    const row = await svc.create(createInput);

    // A approves first and commits.
    await svc.approve(row.id, { decidedBy: 'A' }, { id: 'A' }, row.organizationId);

    // B and C both read the request while it holds only [A], then both
    // decide. This is the interleaving the accumulator lost. One of the
    // two will find the gate already satisfied by the time it reaches
    // the status flip and be told so — that part is correct and is the
    // CAS doing its job; what matters is that neither approval is
    // forgotten.
    const outcomes = await Promise.allSettled([
      svc.approve(row.id, { decidedBy: 'B' }, { id: 'B' }, row.organizationId),
      svc.approve(row.id, { decidedBy: 'C' }, { id: 'C' }, row.organizationId),
    ]);
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);

    expect(new Set(policyApprovals.rows.map((r) => r.approverId))).toEqual(
      new Set(['A', 'B', 'C']),
    );
    expect(new Set(lastScored(hook).map((a) => a.approverId))).toEqual(new Set(['A', 'B', 'C']));
    // A properly approved 3-of-N must not sit pending until it expires.
    expect(approvals.row(row.id)!.status).toBe('approved');
  });

  it('a 3-of-N gate approved one reviewer at a time still completes', async () => {
    const { svc, approvals } = makeService(3);
    const row = await svc.create(createInput);

    await svc.approve(row.id, { decidedBy: 'A' }, { id: 'A' }, row.organizationId);
    expect(approvals.row(row.id)!.status).toBe('pending');
    await svc.approve(row.id, { decidedBy: 'B' }, { id: 'B' }, row.organizationId);
    expect(approvals.row(row.id)!.status).toBe('pending');
    await svc.approve(row.id, { decidedBy: 'C' }, { id: 'C' }, row.organizationId);

    expect(approvals.row(row.id)!.status).toBe('approved');
  });

  it('one human cannot be counted twice, even racing themselves', async () => {
    const { svc, hook, policyApprovals } = makeService(3);
    const row = await svc.create(createInput);

    await svc.approve(row.id, { decidedBy: 'A' }, { id: 'A' }, row.organizationId);

    // B double-clicks: two requests, one person.
    const outcomes = await Promise.allSettled([
      svc.approve(row.id, { decidedBy: 'B' }, { id: 'B' }, row.organizationId),
      svc.approve(row.id, { decidedBy: 'B' }, { id: 'B' }, row.organizationId),
    ]);
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

    expect(policyApprovals.rows.filter((r) => r.approverId === 'B')).toHaveLength(1);
    expect(lastScored(hook).filter((a) => a.approverId === 'B')).toHaveLength(1);
    // Two humans have not satisfied a 3-of-3.
    expect(await svc.findOne(row.id, { id: 'A' }, 'org-1').then((r) => r.status)).toBe('pending');
  });

  it('a repeat approval is refused even when the request has forgotten the earlier one', async () => {
    const { svc, approvals } = makeService(3);
    const row = await svc.create(createInput);
    await svc.approve(row.id, { decidedBy: 'A' }, { id: 'A' }, row.organizationId);

    // Wipe the payload accumulator, i.e. exactly the state a lost
    // update produced. The guard must still hold, because it is the
    // index and not this list.
    const stored = approvals.row(row.id)!;
    approvals.seed({
      ...stored,
      payload: { ...(stored.payload as any), _policy: { ...(stored.payload as any)._policy, approvals: [] } },
    });

    await expect(svc.approve(row.id, { decidedBy: 'A' }, { id: 'A' }, row.organizationId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('an approval recorded only in the request payload is still counted', async () => {
    const { svc, hook, approvals } = makeService(2);
    const row = await svc.create(createInput);

    // A request carrying its approvals the old way.
    approvals.seed({
      ...approvals.row(row.id)!,
      payload: {
        amount: 25000,
        _policy: {
          policyId: 'pol-1',
          policyName: '2-approver quorum',
          approvals: [{ approverId: 'A', roles: ['admin'] }],
        },
      },
    });

    await svc.approve(row.id, { decidedBy: 'B' }, { id: 'B' }, row.organizationId);

    expect(new Set(lastScored(hook).map((a) => a.approverId))).toEqual(new Set(['A', 'B']));
    expect(approvals.row(row.id)!.status).toBe('approved');
  });

  it('the progress write does not carry a reviewer stale status back over the flip', async () => {
    const { svc, approvals } = makeService(2);
    const row = await svc.create(createInput);

    await svc.approve(row.id, { decidedBy: 'A' }, { id: 'A' }, row.organizationId);
    expect(approvals.row(row.id)!.status).toBe('pending');

    await svc.approve(row.id, { decidedBy: 'B' }, { id: 'B' }, row.organizationId);
    expect(approvals.row(row.id)!.status).toBe('approved');
    expect(approvals.row(row.id)!.decidedBy).toBe('B');
  });
});
