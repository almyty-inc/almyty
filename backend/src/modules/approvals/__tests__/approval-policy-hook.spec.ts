import { BadRequestException } from '@nestjs/common';
import { ApprovalsService } from '../approvals.service';
import { fakeApprovalsRepo } from './approvals-repo.fixture';
import { ApprovalPolicyApproval } from '../../../common/ee-hooks/ee-hooks';
import { FakePolicyApprovalsRepo } from './fake-policy-approvals';

/**
 * EE hook seam: on create the optional APPROVAL_POLICY_HOOK may attach a
 * governing policy (recorded under payload._policy); on approve the hook
 * scores collected approvals and the row only flips to approved once the
 * policy is satisfied. No hook / no policy / null score → OSS single gate.
 */
class FakeRunsRepo {
  updates: any[] = [];
  async update(criteria: any, patch: any) {
    this.updates.push({ criteria, patch });
    return { affected: 1 };
  }
}

class FakeAccessPolicy {
  decision = { allowed: true, reason: 'ok' };
  orgRoles = new Map<string, string>();
  teamRoles = new Map<string, string>();
  async canAccess() {
    return this.decision;
  }
  async applyListFilter() {
    return { bypass: true, teamIds: [] };
  }
  async getOrgRole(userId: string) {
    return this.orgRoles.get(userId) ?? 'member';
  }
  async getTeamMemberships(userId: string) {
    const map = new Map<string, string>();
    const role = this.teamRoles.get(userId);
    if (role) map.set('t1', role);
    return map;
  }
}

/** Two approvals from anyone satisfy the fake policy. */
function makeQuorumHook(required = 2) {
  return {
    resolveForContext: jest.fn(async () => ({ id: 'pol-1', name: 'two-approver quorum' })),
    scoreProgress: jest.fn(
      async (_org: string, policyId: string, approvals: ApprovalPolicyApproval[]) => ({
        policyId,
        policyName: 'two-approver quorum',
        totalRequired: required,
        totalCollected: approvals.length,
        steps: [
          {
            index: 0,
            name: 'quorum',
            approverRole: '*',
            required,
            satisfiedBy: Math.min(approvals.length, required),
            satisfied: approvals.length >= required,
          },
        ],
        currentStep: approvals.length >= required ? -1 : 0,
        satisfied: approvals.length >= required,
      }),
    ),
  };
}

function makeService(hook?: any) {
  const approvals = fakeApprovalsRepo();
  const runs = new FakeRunsRepo();
  const policy = new FakeAccessPolicy();
  const policyApprovals = new FakePolicyApprovalsRepo();
  const svc = new ApprovalsService(
    approvals as any,
    runs as any,
    policyApprovals as any,
    policy as any,
    hook,
  );
  return { svc, approvals, runs, policy, policyApprovals };
}

const createInput = {
  organizationId: 'org-1',
  teamId: null,
  runId: 'r1',
  agentId: 'ag1',
  reason: 'wire transfer over 10k',
  payload: { amount: 25000 },
};

describe('ApprovalsService — approval policy hook', () => {
  describe('community build (no hook)', () => {
    it('create + single approve behave exactly as OSS', async () => {
      const { svc } = makeService();
      const events: any[] = [];
      svc.on('approval.decided', (a) => events.push(a));

      const row = await svc.create(createInput);
      expect((row.payload as any)._policy).toBeUndefined();

      const decided = await svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, row.organizationId);
      expect(decided.status).toBe('approved');
      expect(events).toHaveLength(1);
    });
  });

  describe('create with hook', () => {
    it('records the governing policy under payload._policy', async () => {
      const hook = makeQuorumHook();
      const { svc } = makeService(hook);

      const row = await svc.create(createInput);

      expect(hook.resolveForContext).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          reason: 'wire transfer over 10k',
          agentId: 'ag1',
          payload: { amount: 25000 },
        }),
      );
      expect((row.payload as any)._policy).toEqual({
        policyId: 'pol-1',
        policyName: 'two-approver quorum',
        approvals: [],
      });
      // Agent payload is preserved alongside the reserved key.
      expect((row.payload as any).amount).toBe(25000);
    });

    it('leaves payload untouched when no policy matches', async () => {
      const hook = makeQuorumHook();
      hook.resolveForContext.mockResolvedValue(null as any);
      const { svc } = makeService(hook);

      const row = await svc.create(createInput);

      expect(row.payload).toEqual({ amount: 25000 });
    });

    it('a throwing hook degrades to the OSS flow', async () => {
      const hook = makeQuorumHook();
      hook.resolveForContext.mockRejectedValue(new Error('boom'));
      const { svc } = makeService(hook);

      const row = await svc.create(createInput);

      expect(row.status).toBe('pending');
      expect(row.payload).toEqual({ amount: 25000 });
    });
  });

  describe('approve with hook (quorum of 2)', () => {
    it('first approval stays pending, records the step, emits approval.progress', async () => {
      const hook = makeQuorumHook();
      const { svc } = makeService(hook);
      const decidedEvents: any[] = [];
      const progressEvents: any[] = [];
      svc.on('approval.decided', (a) => decidedEvents.push(a));
      svc.on('approval.progress', (a) => progressEvents.push(a));

      const row = await svc.create(createInput);
      const afterFirst = await svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, row.organizationId);

      expect(afterFirst.status).toBe('pending');
      const state = (afterFirst.payload as any)._policy;
      expect(state.approvals).toHaveLength(1);
      expect(state.approvals[0]).toEqual({ approverId: 'u1', roles: ['member'] });
      expect(state.progress.satisfied).toBe(false);
      expect(state.progress.currentStep).toBe(0);
      expect(decidedEvents).toHaveLength(0);
      expect(progressEvents).toHaveLength(1);
      expect(hook.scoreProgress).toHaveBeenCalledWith('org-1', 'pol-1', [
        { approverId: 'u1', roles: ['member'] },
      ]);
    });

    // The snapshot has to reach the table, not only the object the deciding
    // reviewer holds: it is what the next reviewer's UI shows as "1 of 2".
    // Only the payload column moves; the flip is the CAS'd write.
    it('persists the progress snapshot on the stored row', async () => {
      const { svc, approvals } = makeService(makeQuorumHook(3));

      const row = await svc.create(createInput);
      await svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, row.organizationId);

      const stored = approvals.row(row.id)!;
      expect((stored.payload as any)._policy).toMatchObject({
        approvals: [{ approverId: 'u1', roles: ['member'] }],
        progress: { satisfied: false, totalCollected: 1 },
      });
      expect(stored.status).toBe('pending');
      expect(stored.decidedBy).toBeUndefined();
    });

    it('second approver satisfies the quorum and flips to approved', async () => {
      const hook = makeQuorumHook();
      const { svc } = makeService(hook);
      const decidedEvents: any[] = [];
      svc.on('approval.decided', (a) => decidedEvents.push(a));

      const row = await svc.create(createInput);
      await svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, row.organizationId);
      const decided = await svc.approve(row.id, { decidedBy: 'u2' }, { id: 'u2' }, row.organizationId);

      expect(decided.status).toBe('approved');
      expect(decided.decidedBy).toBe('u2');
      const state = (decided.payload as any)._policy;
      expect(state.approvals.map((a: any) => a.approverId)).toEqual(['u1', 'u2']);
      expect(state.progress.satisfied).toBe(true);
      expect(decidedEvents).toHaveLength(1);
    });

    it('rejects a duplicate approval from the same caller', async () => {
      const hook = makeQuorumHook();
      const { svc } = makeService(hook);

      const row = await svc.create(createInput);
      await svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, row.organizationId);

      await expect(
        svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, row.organizationId),
      ).rejects.toThrow(BadRequestException);
    });

    it('includes the team role for team-scoped requests', async () => {
      const hook = makeQuorumHook();
      const { svc, policy } = makeService(hook);
      policy.orgRoles.set('u1', 'admin');
      policy.teamRoles.set('u1', 'lead');

      const row = await svc.create({ ...createInput, teamId: 't1' });
      await svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, row.organizationId);

      expect(hook.scoreProgress).toHaveBeenCalledWith('org-1', 'pol-1', [
        { approverId: 'u1', roles: ['admin', 'team_lead'] },
      ]);
    });

    it('a single reject still kills a policy-governed request immediately', async () => {
      const hook = makeQuorumHook();
      const { svc } = makeService(hook);

      const row = await svc.create(createInput);
      const decided = await svc.reject(row.id, { decidedBy: 'u1', decisionReason: 'no' }, { id: 'u1' }, row.organizationId);

      expect(decided.status).toBe('rejected');
      expect(hook.scoreProgress).not.toHaveBeenCalled();
    });
  });

  describe('license degradation', () => {
    it('null score (unlicensed / policy deleted) falls back to the single gate', async () => {
      const hook = makeQuorumHook();
      const { svc } = makeService(hook);
      const row = await svc.create(createInput);

      // License expired between create and approve: hook scores null.
      hook.scoreProgress.mockResolvedValue(null as any);
      const decided = await svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, row.organizationId);

      expect(decided.status).toBe('approved');
    });

    /**
     * A scorer that threw is not a scorer that said "no policy".
     *
     * Both used to land as `progress === null`, and null means "fall
     * back to the OSS single gate" -- so one transient error inside the
     * EE scorer silently turned a configured 3-of-5 quorum into a single
     * approver and let the gated tool call run. That is the one outcome
     * a human-in-the-loop control must never reach by accident, and it
     * left no signal behind: the row simply read as approved.
     */
    it('holds the gate when scoreProgress throws, rather than approving on one vote', async () => {
      const hook = makeQuorumHook();
      const { svc } = makeService(hook);
      const row = await svc.create(createInput);

      hook.scoreProgress.mockRejectedValue(new Error('boom'));

      await expect(
        svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, row.organizationId),
      ).rejects.toMatchObject({ status: 503 });

      // And the request is still waiting for its quorum.
      const after = await svc.findOne(row.id, { id: 'u1' }, row.organizationId);
      expect(after.status).toBe('pending');
    });
  });
});
