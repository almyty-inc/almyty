import { BadRequestException } from '@nestjs/common';

import { ApprovalPolicyService } from '../approval-policy.service';
import { ApprovalPolicyEvaluator } from '../approval-policy.evaluator';
import { ApprovalPolicy } from '../../../../src/entities/approval-policy.entity';
import { fakeRepository } from '../../../../src/test/fake-repository';

/**
 * Approval policies with an amount rule ("ask before issue_refund when
 * amount is over 500"): what saving one checks and stores, and which
 * requests such a policy governs -- the ones it raised at the tool call,
 * and nothing an agent raises by itself.
 */
describe('approval policies with an amount rule', () => {
  const trigger = { kind: 'tool_amount' as const, toolId: 'tool-refund', argument: 'amount', op: 'gt' as const, amount: 500 };

  const make = () => {
    const policies = fakeRepository<any>([]);
    const tools = fakeRepository<any>([
      { id: 'tool-refund', organizationId: 'org-1', name: 'issue_refund' },
      { id: 'tool-other-org', organizationId: 'org-2', name: 'issue_refund' },
    ]);
    return { svc: new ApprovalPolicyService(policies as any, new ApprovalPolicyEvaluator(), tools as any), policies };
  };

  const steps = [{ name: 'Finance', approverRole: '*', minApprovals: 1 }];

  it("stores the rule with the tool's own name", async () => {
    const { svc } = make();
    const p = await svc.create({ organizationId: 'org-1', name: 'Refunds over 500', steps, trigger: { ...trigger, toolName: 'spoofed' } });
    expect(p.trigger).toEqual({ ...trigger, toolName: 'issue_refund' });
  });

  it.each([
    ['a tool of another organization', { toolId: 'tool-other-org' }],
    ['no tool', { toolId: '' }],
    ['no argument', { argument: '' }],
    ['an argument that is not a field path', { argument: 'amount; drop' }],
    ['another comparison', { op: 'lt' }],
    ['a negative amount', { amount: -1 }],
    ['an amount that is not a number', { amount: 'lots' }],
    ['another kind of rule', { kind: 'cron' }],
  ])('refuses %s', async (_label, over) => {
    const { svc } = make();
    await expect(
      svc.create({ organizationId: 'org-1', name: 'x', steps, trigger: { ...trigger, ...(over as any) } }),
    ).rejects.toThrow(BadRequestException);
  });

  it('clears the rule on an update that sets it to null', async () => {
    const { svc } = make();
    const p = await svc.create({ organizationId: 'org-1', name: 'x', steps, trigger });
    const updated = await svc.update('org-1', p.id, { trigger: null });
    expect(updated.trigger).toBeNull();
  });

  describe('which requests it governs', () => {
    const evaluator = new ApprovalPolicyEvaluator();
    const policy = (over: Partial<ApprovalPolicy>): ApprovalPolicy =>
      ({ id: 'p', name: 'p', organizationId: 'org-1', teamId: null, match: [], steps, priority: 0, enabled: true, trigger: null, ...over }) as ApprovalPolicy;
    const amountRule = policy({ id: 'amount-rule', trigger, priority: 10 });
    const general = policy({ id: 'general' });

    it('a request the rule raised is governed by that rule', () => {
      expect(evaluator.resolvePolicy([general, amountRule], { policyId: 'amount-rule' })?.id).toBe('amount-rule');
    });

    it('a request an agent raised is never governed by a policy with an amount rule, whatever its priority', () => {
      expect(evaluator.resolvePolicy([general, amountRule], { reason: 'refund' })?.id).toBe('general');
      expect(evaluator.resolvePolicy([amountRule], { reason: 'refund' })).toBeNull();
    });

    it('a rule switched off after it raised a request no longer governs it (single approver)', () => {
      expect(evaluator.resolvePolicy([{ ...amountRule, enabled: false } as ApprovalPolicy], { policyId: 'amount-rule' })).toBeNull();
    });
  });
});
