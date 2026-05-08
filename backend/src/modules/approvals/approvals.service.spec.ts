import { ApprovalsService } from './approvals.service';
import { ApprovalRequest } from '../../entities/approval-request.entity';
import { AgentRunStatus } from '../../entities/agent-run.entity';

class FakeApprovalsRepo {
  rows: ApprovalRequest[] = [];
  private idc = 0;
  async findOne({ where }: any) {
    return this.rows.find(r =>
      Object.entries(where).every(([k, v]) => (r as any)[k] === v),
    ) ?? null;
  }
  async find({ where, order }: any = {}) {
    let out = this.rows.filter(r =>
      Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
        if (v && typeof v === 'object' && '_type' in v) {
          // crude LessThan stub
          return new Date((r as any)[k]).getTime() < new Date(v._value).getTime();
        }
        return (r as any)[k] === v;
      }),
    );
    if (order?.createdAt === 'DESC') {
      out = [...out].sort((a, b) => +b.createdAt - +a.createdAt);
    }
    return out;
  }
  create(partial: Partial<ApprovalRequest>) {
    return { id: `a_${++this.idc}`, createdAt: new Date(), updatedAt: new Date(), ...partial } as ApprovalRequest;
  }
  async save(r: ApprovalRequest) {
    const existing = this.rows.findIndex(x => x.id === r.id);
    if (existing >= 0) this.rows[existing] = r;
    else this.rows.push(r);
    return r;
  }
  createQueryBuilder() {
    const self = this;
    let pending: ApprovalRequest[] = self.rows;
    const qb: any = {
      where: (_clause: string, params: any) => { pending = pending.filter(r => r.status === params.status); return qb; },
      andWhere: () => qb,
      orderBy: () => qb,
      take: (n: number) => { pending = pending.slice(0, n); return qb; },
      getMany: async () => pending,
    };
    return qb;
  }
}

class FakeRunsRepo {
  updates: any[] = [];
  async update(criteria: any, patch: any) {
    this.updates.push({ criteria, patch });
    return { affected: 1 };
  }
}

class FakePolicy {
  decision: { allowed: boolean; reason: string } = { allowed: true, reason: 'ok' };
  async canAccess() { return this.decision; }
  async applyListFilter() { return { bypass: true, teamIds: [] }; }
}

function makeService() {
  const approvals = new FakeApprovalsRepo();
  const runs = new FakeRunsRepo();
  const policy = new FakePolicy();
  const svc = new ApprovalsService(approvals as any, runs as any, policy as any);
  return { svc, approvals, runs, policy };
}

describe('ApprovalsService', () => {
  describe('create', () => {
    it('writes a row, pauses the run, emits approval.requested', async () => {
      const { svc, runs, approvals } = makeService();
      const events: any[] = [];
      svc.on('approval.requested', (a) => events.push(a));
      const row = await svc.create({
        organizationId: 'org-1',
        teamId: null,
        runId: 'r1',
        agentId: 'a1',
        toolCallId: 'tc-1',
        reason: 'about to send a non-reversible action',
      });
      expect(row.status).toBe('pending');
      expect(row.visibility).toBe('org');
      expect(approvals.rows.length).toBe(1);
      expect(runs.updates.length).toBe(1);
      expect(runs.updates[0].patch.status).toBe(AgentRunStatus.WAITING_APPROVAL);
      expect(events.length).toBe(1);
    });

    it('is idempotent on (runId, toolCallId)', async () => {
      const { svc } = makeService();
      const a = await svc.create({ organizationId: 'o', teamId: null, runId: 'r', agentId: 'a', toolCallId: 'tc', reason: 'x' });
      const b = await svc.create({ organizationId: 'o', teamId: null, runId: 'r', agentId: 'a', toolCallId: 'tc', reason: 'x' });
      expect(b.id).toBe(a.id);
    });

    it('marks visibility=team when teamId is set', async () => {
      const { svc } = makeService();
      const row = await svc.create({ organizationId: 'o', teamId: 't1', runId: 'r', agentId: 'a', reason: 'x' });
      expect(row.visibility).toBe('team');
      expect(row.teamId).toBe('t1');
    });
  });

  describe('approve / reject', () => {
    it('approve flips to approved + emits approval.decided', async () => {
      const { svc } = makeService();
      const events: any[] = [];
      svc.on('approval.decided', (a) => events.push(a));
      const row = await svc.create({ organizationId: 'o', teamId: null, runId: 'r', agentId: 'a', reason: 'x' });
      const decided = await svc.approve(row.id, { decidedBy: 'u-approver', decisionReason: 'lgtm' }, { id: 'u-approver' });
      expect(decided.status).toBe('approved');
      expect(decided.decidedBy).toBe('u-approver');
      expect(decided.decisionReason).toBe('lgtm');
      expect(events.length).toBe(1);
    });

    it('reject flips to rejected', async () => {
      const { svc } = makeService();
      const row = await svc.create({ organizationId: 'o', teamId: null, runId: 'r', agentId: 'a', reason: 'x' });
      const decided = await svc.reject(row.id, { decidedBy: 'u-rev' }, { id: 'u-rev' });
      expect(decided.status).toBe('rejected');
    });

    it('refuses to flip an already-decided row', async () => {
      const { svc } = makeService();
      const row = await svc.create({ organizationId: 'o', teamId: null, runId: 'r', agentId: 'a', reason: 'x' });
      await svc.approve(row.id, { decidedBy: 'u' }, { id: 'u' });
      await expect(svc.approve(row.id, { decidedBy: 'u' }, { id: 'u' })).rejects.toThrow(/already approved/);
    });

    it('refuses when policy denies', async () => {
      const { svc, policy } = makeService();
      policy.decision = { allowed: false, reason: 'team lead required' };
      const row = await svc.create({ organizationId: 'o', teamId: 't1', runId: 'r', agentId: 'a', reason: 'x' });
      await expect(svc.approve(row.id, { decidedBy: 'u' }, { id: 'u' })).rejects.toThrow(/team lead/);
    });
  });

  describe('listPending', () => {
    it('returns only pending rows', async () => {
      const { svc } = makeService();
      const a = await svc.create({ organizationId: 'o', teamId: null, runId: 'r1', agentId: 'a', reason: 'x' });
      await svc.create({ organizationId: 'o', teamId: null, runId: 'r2', agentId: 'a', reason: 'y' });
      await svc.approve(a.id, { decidedBy: 'u' }, { id: 'u' });
      const list = await svc.listPending({ organizationId: 'o', caller: { id: 'u' } });
      expect(list.length).toBe(1);
      expect(list[0].status).toBe('pending');
    });
  });
});
