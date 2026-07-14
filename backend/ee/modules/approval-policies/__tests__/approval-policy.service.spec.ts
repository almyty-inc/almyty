import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApprovalPolicyService } from '../approval-policy.service';
import { ApprovalPolicyEvaluator } from '../approval-policy.evaluator';
import { ApprovalPolicy } from '../../../../src/entities/approval-policy.entity';

class FakeRepo {
  rows: ApprovalPolicy[] = [];
  private idc = 0;
  create(partial: any) {
    return { id: `p_${++this.idc}`, createdAt: new Date(), updatedAt: new Date(), ...partial } as ApprovalPolicy;
  }
  async save(row: ApprovalPolicy) {
    const i = this.rows.findIndex((r) => r.id === row.id);
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
    return row;
  }
  async findOne({ where }: any) {
    return this.rows.find((r) => Object.entries(where).every(([k, v]) => (r as any)[k] === v)) ?? null;
  }
  async find({ where }: any = {}) {
    return this.rows.filter((r) => Object.entries(where ?? {}).every(([k, v]) => (r as any)[k] === v));
  }
  async remove(row: ApprovalPolicy) {
    this.rows = this.rows.filter((r) => r.id !== row.id);
    return row;
  }
}

function makeService() {
  const repo = new FakeRepo();
  const svc = new ApprovalPolicyService(repo as any, new ApprovalPolicyEvaluator());
  return { svc, repo };
}

describe('ApprovalPolicyService', () => {
  it('creates a valid multi-step policy', async () => {
    const { svc } = makeService();
    const p = await svc.create({
      organizationId: 'org',
      name: 'refunds',
      match: [{ attr: 'amount', op: 'gt', value: 1000 }],
      steps: [
        { name: 'finance', approverRole: 'finance', minApprovals: 1 },
        { name: 'manager', approverRole: 'admin', minApprovals: 1 },
      ],
    });
    expect(p.enabled).toBe(true);
    expect(p.steps).toHaveLength(2);
  });

  it('rejects a step with minApprovals < 1', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({
        organizationId: 'org',
        name: 'bad',
        steps: [{ name: 's', approverRole: '*', minApprovals: 0 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a step missing an approverRole', async () => {
    const { svc } = makeService();
    await expect(
      svc.create({
        organizationId: 'org',
        name: 'bad',
        steps: [{ name: 's', approverRole: '', minApprovals: 1 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('resolves the governing policy for a context', async () => {
    const { svc } = makeService();
    await svc.create({
      organizationId: 'org',
      name: 'refunds',
      match: [{ attr: 'amount', op: 'gt', value: 1000 }],
      steps: [{ name: 'q', approverRole: '*', minApprovals: 2 }],
    });
    const hit = await svc.resolveForContext('org', { amount: 5000 });
    expect(hit?.name).toBe('refunds');
    const miss = await svc.resolveForContext('org', { amount: 5 });
    expect(miss).toBeNull();
  });

  it('scopes get by org', async () => {
    const { svc } = makeService();
    const p = await svc.create({ organizationId: 'org-a', name: 'x' });
    await expect(svc.get('org-b', p.id)).rejects.toThrow(NotFoundException);
  });
});
