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

/**
 * Notification wiring: approval.pending fans out to the users who can
 * decide; approval.decided goes to the run's initiator. The pipeline is
 * injected @Optional() — everything above runs without it, these tests
 * pass a fake.
 */
describe('ApprovalsService notifications', () => {
  function makeNotifyingService(runUserId: string | null = 'initiator-1') {
    const approvals = new FakeApprovalsRepo();
    const runs: any = {
      updates: [] as any[],
      async update(criteria: any, patch: any) {
        this.updates.push({ criteria, patch });
        return { affected: 1 };
      },
      async findOne() {
        return runUserId ? { id: 'r1', userId: runUserId } : null;
      },
    };
    const policy = new FakePolicy();
    const notifications = { emit: jest.fn().mockResolvedValue(undefined) };
    const svc = new ApprovalsService(
      approvals as any,
      runs as any,
      policy as any,
      undefined,
      notifications as any,
    );
    return { svc, approvals, runs, notifications };
  }

  const createInput = (overrides: any = {}) => ({
    organizationId: 'org-1',
    teamId: null,
    runId: 'r1',
    agentId: 'a1',
    toolCallId: 'tc-1',
    reason: 'destructive action ahead',
    ...overrides,
  });

  async function flush() {
    await new Promise((r) => setImmediate(r));
  }

  it('emits approval.pending to org owners/admins on create', async () => {
    const { svc, notifications } = makeNotifyingService();
    const row = await svc.create(createInput());
    await flush();

    expect(notifications.emit).toHaveBeenCalledTimes(1);
    const input = notifications.emit.mock.calls[0][0];
    expect(input).toMatchObject({
      type: 'approval.pending',
      organizationId: 'org-1',
      body: 'destructive action ahead',
      link: `/approvals/${row.id}`,
    });
    expect(input.roleTarget.orgRoles).toEqual(['owner', 'admin']);
    expect(input.roleTarget.teamLeadOfTeamId).toBeNull();
    expect(input.email.template).toBe('approval.pending');
  });

  it('includes the team LEAD target for team-scoped requests', async () => {
    const { svc, notifications } = makeNotifyingService();
    await svc.create(createInput({ teamId: 'team-9' }));
    await flush();

    expect(notifications.emit.mock.calls[0][0].roleTarget.teamLeadOfTeamId).toBe('team-9');
  });

  it('emits approval.decided to the run initiator on approve', async () => {
    const { svc, notifications } = makeNotifyingService('initiator-1');
    const row = await svc.create(createInput());
    notifications.emit.mockClear();

    await svc.approve(row.id, { decidedBy: 'admin-1', decisionReason: 'ok' }, { id: 'admin-1' });
    await flush();

    expect(notifications.emit).toHaveBeenCalledTimes(1);
    const input = notifications.emit.mock.calls[0][0];
    expect(input).toMatchObject({
      type: 'approval.decided',
      userIds: ['initiator-1'],
      title: 'Approval approved',
    });
    expect(input.email.params.status).toBe('approved');
  });

  it('emits approval.decided on reject too', async () => {
    const { svc, notifications } = makeNotifyingService('initiator-1');
    const row = await svc.create(createInput());
    notifications.emit.mockClear();

    await svc.reject(row.id, { decidedBy: 'admin-1', decisionReason: 'no' }, { id: 'admin-1' });
    await flush();

    expect(notifications.emit.mock.calls[0][0].title).toBe('Approval rejected');
  });

  it('skips the decided notification when the initiator decided their own request', async () => {
    const { svc, notifications } = makeNotifyingService('admin-1');
    const row = await svc.create(createInput());
    notifications.emit.mockClear();

    await svc.approve(row.id, { decidedBy: 'admin-1' }, { id: 'admin-1' });
    await flush();

    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('notifies the initiator with status expired from the sweep', async () => {
    const { svc, notifications } = makeNotifyingService('initiator-1');
    await svc.create(createInput({ ttlSeconds: 1 }));
    notifications.emit.mockClear();

    await svc.sweepExpired(new Date(Date.now() + 60_000));
    await flush();

    expect(notifications.emit).toHaveBeenCalledTimes(1);
    expect(notifications.emit.mock.calls[0][0].title).toBe('Approval expired');
  });

  it('create still succeeds when the notification pipeline throws', async () => {
    const { svc, notifications } = makeNotifyingService();
    notifications.emit.mockRejectedValue(new Error('down'));

    const row = await svc.create(createInput());
    await flush();
    expect(row.status).toBe('pending');
  });
});