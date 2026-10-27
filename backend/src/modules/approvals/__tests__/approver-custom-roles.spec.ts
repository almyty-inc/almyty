import { ApprovalsService } from '../approvals.service';
import { fakeApprovalsRepo } from './approvals-repo.fixture';
import { FakePolicyApprovalsRepo } from './fake-policy-approvals';
import { runsWithEvents } from '../../../test/fake-run-events';

/**
 * An approval policy step whose approver role is a custom role name
 * ("finance") matched nobody: the approver's roles were only the org role
 * and team_lead/team_member. The custom roles come from the optional
 * ADVANCED_RBAC_HOOK, and a held tool call puts its tool's name in the
 * policy context so a `toolName` condition can match.
 */
class FakeAccessPolicy {
  async canAccess() {
    return { allowed: true, reason: 'ok' };
  }
  async applyListFilter() {
    return { bypass: true, teamIds: [] };
  }
  async getOrgRole() {
    return 'member';
  }
  async getTeamMemberships() {
    return new Map<string, string>();
  }
}

function policyHook() {
  return {
    resolveForContext: jest.fn(async () => ({ id: 'pol-1', name: 'finance sign-off' })),
    scoreProgress: jest.fn(async (_org: string, policyId: string) => ({
      policyId,
      policyName: 'finance sign-off',
      totalRequired: 2,
      totalCollected: 1,
      steps: [],
      currentStep: 1,
      satisfied: false,
    })),
  };
}

function makeService(rbacHook?: any) {
  const approvals = fakeApprovalsRepo();
  const policyApprovals = new FakePolicyApprovalsRepo();
  const hook = policyHook();
  const svc = new ApprovalsService(
    approvals as any,
    runsWithEvents() as any,
    policyApprovals as any,
    new FakeAccessPolicy() as any,
    hook,
    undefined,
    rbacHook,
  );
  return { svc, approvals, policyApprovals, hook };
}

const input = {
  organizationId: 'org-1',
  teamId: null,
  runId: 'r1',
  agentId: null,
  reason: 'refund over 1000',
  payload: { amount: 2500 },
};

describe('approval policy approver roles include custom roles', () => {
  it('records the approver custom role names next to the org role', async () => {
    const rbacHook = {
      hasPermission: jest.fn(),
      evaluateAccess: jest.fn(),
      roleNames: jest.fn(async () => ['finance']),
    };
    const { svc, policyApprovals } = makeService(rbacHook);
    const row = await svc.create(input);

    await svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, 'org-1');

    const collected = await policyApprovals.find({ where: { requestId: row.id } });
    expect(collected[0].roles).toEqual(['member', 'finance']);
    expect(rbacHook.roleNames).toHaveBeenCalledWith('org-1', 'u1');
  });

  it('without the hook only the built-in role is recorded', async () => {
    const { svc, policyApprovals } = makeService();
    const row = await svc.create(input);

    await svc.approve(row.id, { decidedBy: 'u1' }, { id: 'u1' }, 'org-1');

    const collected = await policyApprovals.find({ where: { requestId: row.id } });
    expect(collected[0].roles).toEqual(['member']);
  });

  it('a held tool call puts its tool name in the policy context', async () => {
    const { svc, approvals, hook } = makeService();
    await approvals.tools.save({ id: 'tool-1', organizationId: 'org-1', name: 'issue_refund' } as any);

    await svc.create({ ...input, toolId: 'tool-1', fingerprint: 'fp' });

    expect(hook.resolveForContext).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ toolName: 'issue_refund', payload: { amount: 2500 } }),
    );
  });
});
