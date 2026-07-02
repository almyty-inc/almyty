import { ApprovalPolicyEvaluator, CollectedApproval } from '../approval-policy.evaluator';
import { ApprovalPolicy } from '../../../../src/entities/approval-policy.entity';

function policy(p: Partial<ApprovalPolicy>): ApprovalPolicy {
  return {
    id: p.id ?? 'p1',
    organizationId: 'org',
    name: p.name ?? 'policy',
    description: null,
    teamId: null,
    match: p.match ?? [],
    steps: p.steps ?? [],
    priority: p.priority ?? 0,
    enabled: p.enabled ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ApprovalPolicy;
}

const approver = (id: string, ...roles: string[]): CollectedApproval => ({ approverId: id, roles });

describe('ApprovalPolicyEvaluator', () => {
  const evalr = new ApprovalPolicyEvaluator();

  describe('resolvePolicy', () => {
    it('returns null when nothing matches (falls back to single-gate)', () => {
      const policies = [
        policy({ match: [{ attr: 'amount', op: 'gt', value: 1000 }] }),
      ];
      expect(evalr.resolvePolicy(policies, { amount: 10 })).toBeNull();
    });

    it('matches a conditional policy on amount + tool', () => {
      const p = policy({
        id: 'refunds',
        match: [
          { attr: 'amount', op: 'gt', value: 1000 },
          { attr: 'toolName', op: 'eq', value: 'issue_refund' },
        ],
      });
      const hit = evalr.resolvePolicy([p], { amount: 5000, toolName: 'issue_refund' });
      expect(hit?.id).toBe('refunds');
    });

    it('picks the highest-priority matching policy', () => {
      const lo = policy({ id: 'lo', priority: 1 });
      const hi = policy({ id: 'hi', priority: 10 });
      expect(evalr.resolvePolicy([lo, hi], {})?.id).toBe('hi');
    });

    it('ignores disabled policies', () => {
      const p = policy({ enabled: false });
      expect(evalr.resolvePolicy([p], {})).toBeNull();
    });
  });

  describe('progress (quorum)', () => {
    const quorum = policy({
      steps: [{ name: 'any-two', approverRole: '*', minApprovals: 2 }],
    });

    it('is unsatisfied with one approval', () => {
      const prog = evalr.progress(quorum, [approver('u1', 'member')]);
      expect(prog.satisfied).toBe(false);
      expect(prog.totalRequired).toBe(2);
      expect(prog.currentStep).toBe(0);
    });

    it('is satisfied once the quorum is met', () => {
      const prog = evalr.progress(quorum, [approver('u1'), approver('u2')]);
      expect(prog.satisfied).toBe(true);
      expect(prog.currentStep).toBe(-1);
    });
  });

  describe('progress (multi-step, role-scoped, sequential)', () => {
    const twoStep = policy({
      steps: [
        { name: 'finance', approverRole: 'finance', minApprovals: 1 },
        { name: 'manager', approverRole: 'admin', minApprovals: 1 },
      ],
    });

    it('requires each step to be satisfied by a matching approver', () => {
      const prog = evalr.progress(twoStep, [approver('u1', 'finance')]);
      expect(prog.steps[0].satisfied).toBe(true);
      expect(prog.steps[1].satisfied).toBe(false);
      expect(prog.currentStep).toBe(1);
      expect(prog.satisfied).toBe(false);
    });

    it('does not let a manager approval satisfy the finance step', () => {
      const prog = evalr.progress(twoStep, [approver('u1', 'admin')]);
      // The admin can only be credited after finance is satisfied → step 0 blocks.
      expect(prog.steps[0].satisfied).toBe(false);
      expect(prog.steps[1].satisfied).toBe(false);
      expect(prog.currentStep).toBe(0);
    });

    it('is satisfied when both steps are met by the right roles', () => {
      const prog = evalr.progress(twoStep, [
        approver('u1', 'finance'),
        approver('u2', 'admin'),
      ]);
      expect(prog.satisfied).toBe(true);
      expect(prog.currentStep).toBe(-1);
    });

    it('does not double-count one approver across two steps', () => {
      const dualQuorum = policy({
        steps: [
          { name: 's1', approverRole: '*', minApprovals: 1 },
          { name: 's2', approverRole: '*', minApprovals: 1 },
        ],
      });
      const single = evalr.progress(dualQuorum, [approver('u1')]);
      expect(single.steps[0].satisfied).toBe(true);
      expect(single.steps[1].satisfied).toBe(false);
      const both = evalr.progress(dualQuorum, [approver('u1'), approver('u2')]);
      expect(both.satisfied).toBe(true);
    });
  });
});
