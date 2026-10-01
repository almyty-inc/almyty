import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AmountRulesService, SINGLE_APPROVER_STEPS } from '../amount-rules.service';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * Amount rules are free: any organization can say "ask before
 * issue_refund when amount is over 500" and have one approval decide it.
 * Sign-off in several steps stays the Business approval-policy feature.
 */
describe('AmountRulesService', () => {
  const trigger = { kind: 'tool_amount' as const, toolId: 'tool-refund', argument: 'amount', op: 'gt' as const, amount: 500 };
  const twoSteps = [
    { name: 'Finance', approverRole: 'finance', minApprovals: 1 },
    { name: 'Admin', approverRole: 'admin', minApprovals: 1 },
  ];

  const make = (entitled: boolean) => {
    const policies = fakeRepository<any>([
      { id: 'p-general', organizationId: 'org-1', name: 'General', trigger: null, match: [], steps: twoSteps, enabled: true, createdAt: new Date() },
    ]);
    const tools = fakeRepository<any>([
      { id: 'tool-refund', organizationId: 'org-1', name: 'issue_refund' },
      { id: 'tool-elsewhere', organizationId: 'org-2', name: 'issue_refund' },
    ]);
    const licenses = { hasForOrg: jest.fn(async () => entitled) };
    return { svc: new AmountRulesService(policies as any, tools as any, licenses as any), policies, licenses };
  };

  it('creates a rule without the Business plan, decided by one approval', async () => {
    const { svc } = make(false);
    const rule = await svc.create('org-1', { name: 'Refunds over 500', trigger });
    expect(rule).toMatchObject({
      name: 'Refunds over 500',
      trigger: { ...trigger, toolName: 'issue_refund' },
      steps: SINGLE_APPROVER_STEPS,
      match: [],
      enabled: true,
    });
  });

  it('refuses sign-off in several steps without the Business plan, and says why', async () => {
    const { svc } = make(false);
    await expect(svc.create('org-1', { name: 'x', trigger, steps: twoSteps })).rejects.toThrow(/Business plan/);
  });

  it('takes the steps from an organization with the Business plan', async () => {
    const { svc } = make(true);
    const rule = await svc.create('org-1', { name: 'x', trigger, steps: twoSteps });
    expect(rule.steps).toEqual(twoSteps);
  });

  it.each([
    ['a tool of another organization', { ...trigger, toolId: 'tool-elsewhere' }],
    ['no amount', { ...trigger, amount: 'lots' as any }],
    ['no rule at all', undefined],
  ])('refuses %s', async (_label, bad) => {
    const { svc } = make(false);
    await expect(svc.create('org-1', { name: 'x', trigger: bad as any })).rejects.toThrow(BadRequestException);
  });

  it('lists and manages only amount rules, never the Business policies', async () => {
    const { svc } = make(false);
    const rule = await svc.create('org-1', { name: 'Refunds over 500', trigger });
    expect((await svc.list('org-1')).map((r) => r.id)).toEqual([rule.id]);
    await expect(svc.get('org-1', 'p-general')).rejects.toThrow(NotFoundException);
    await expect(svc.remove('org-1', 'p-general')).rejects.toThrow(NotFoundException);
    const updated = await svc.update('org-1', rule.id, { trigger: { ...trigger, amount: 1000 }, enabled: false });
    expect(updated).toMatchObject({ enabled: false, trigger: { amount: 1000 } });
    await expect(svc.get('org-2', rule.id)).rejects.toThrow(NotFoundException);
  });
});
