import { BadRequestException, NotFoundException } from '@nestjs/common';

import { SpendAlert } from '../../../entities/spend-alert.entity';
import { SpendBudget } from '../../../entities/spend-budget.entity';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { FakeRepository, fakeRepository } from '../../../test/fake-repository';
import { BudgetsService } from '../budgets.service';
import { BudgetExceededException } from '../budget-exceeded.exception';

/**
 * Unit tests for BudgetsService — the P2 cost-governance core: CRUD +
 * validation, the pre-run enforcement hook (reject / warn_log /
 * no-budget), and append-only SpendAlert emission with per-period dedup
 * + email delivery.
 *
 * Every repository is the shared truthful fake: rows are copied in and
 * out and every `where` is evaluated. The double this replaced stored
 * the caller's own entity, so `update()`'s in-place mutation already was
 * "the row" and its `save()` could be deleted with the suite green; the
 * membership double answered the same owner for any organization; and
 * no test put a second organization's rows in any table, so every
 * `organizationId` predicate in this service was unwitnessed.
 */
describe('BudgetsService', () => {
  let budgetRepo: FakeRepository<SpendBudget>;
  let alertRepo: FakeRepository<SpendAlert>;
  let userOrgRepo: FakeRepository<any>;
  let userRepo: FakeRepository<any>;
  let agentRepo: FakeRepository<any>;
  let userTeamRepo: FakeRepository<any>;
  let spend: { periodToDateCents: jest.Mock };
  let mail: { send: jest.Mock };
  let service: BudgetsService;

  const alerts = () => alertRepo.rows();
  const budgets = () => budgetRepo.rows();

  beforeEach(() => {
    budgetRepo = fakeRepository<SpendBudget>({ make: () => new SpendBudget(), idPrefix: 'b' });
    alertRepo = fakeRepository<SpendAlert>({ make: () => new SpendAlert(), idPrefix: 'a' });
    userOrgRepo = fakeRepository([
      { id: 'm-1', organizationId: 'org-1', userId: 'owner-1', role: OrganizationRole.OWNER, isActive: true },
      { id: 'm-2', organizationId: 'org-1', userId: 'member-1', role: OrganizationRole.MEMBER, isActive: true },
      // Another tenant's owner: never a recipient of org-1's alerts.
      { id: 'm-3', organizationId: 'org-2', userId: 'owner-2', role: OrganizationRole.OWNER, isActive: true },
    ]);
    userRepo = fakeRepository([
      { id: 'owner-1', email: 'owner@example.com' },
      { id: 'member-1', email: 'member@example.com' },
      { id: 'owner-2', email: 'other-tenant@example.com' },
    ]);

    spend = { periodToDateCents: jest.fn().mockResolvedValue(0) };
    mail = { send: jest.fn().mockResolvedValue(true) };

    agentRepo = fakeRepository([
      { id: 'agent-A', organizationId: 'org-1', visibility: 'org', createdBy: 'member-1' },
      { id: 'agent-B', organizationId: 'org-1', visibility: 'org', createdBy: 'member-1' },
    ]);
    userTeamRepo = fakeRepository<any>([]);

    service = new BudgetsService(
      budgetRepo as any,
      alertRepo as any,
      userOrgRepo as any,
      userRepo as any,
      spend as any,
      mail as any,
      undefined,
      agentRepo as any,
      userTeamRepo as any,
    );
  });

  const flush = () => new Promise((r) => setImmediate(r));

  // ── CRUD + validation ────────────────────────────────────────────

  it('creates, lists, updates and deletes a budget', async () => {
    const b = await service.create('org-1', { limitCents: 5000, periodType: 'month' }, 'owner-1');
    expect(b.id).toBeDefined();
    expect(b.limitCents).toBe(5000);
    expect(b.behavior).toBe('warn_log');
    expect(b.softThresholdPct).toBe(80);

    expect(await service.list('org-1', 'owner-1')).toHaveLength(1);

    const updated = await service.update(b.id, 'org-1', { limitCents: 8000, behavior: 'reject' }, 'owner-1');
    expect(updated.limitCents).toBe(8000);
    expect(updated.behavior).toBe('reject');

    await service.remove(b.id, 'org-1', 'owner-1');
    expect(await service.list('org-1', 'owner-1')).toHaveLength(0);
  });

  // The object `update()` returns is its own copy; only the table says
  // whether the change was written.
  it('update reaches the table, not only the object it returns', async () => {
    const b = await service.create('org-1', { limitCents: 5000 }, 'owner-1');
    await service.update(b.id, 'org-1', { limitCents: 8000, behavior: 'reject' }, 'owner-1');

    expect(budgetRepo.row(b.id)).toMatchObject({ limitCents: 8000, behavior: 'reject' });
  });

  it('rejects invalid budget input', async () => {
    await expect(service.create('org-1', { limitCents: 0 }, 'owner-1')).rejects.toThrow(BadRequestException);
    await expect(service.create('org-1', { limitCents: -5 }, 'owner-1')).rejects.toThrow(BadRequestException);
    await expect(
      service.create('org-1', { limitCents: 100, periodType: 'year' as any }, 'owner-1'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create('org-1', { limitCents: 100, behavior: 'silent' as any }, 'owner-1'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create('org-1', { limitCents: 100, softThresholdPct: 150 }, 'owner-1'),
    ).rejects.toThrow(BadRequestException);
  });

  // ── Tenancy ──────────────────────────────────────────────────────

  it('no other organization can read, change or delete a budget', async () => {
    const mine = await service.create('org-1', { limitCents: 5000 }, 'owner-1');

    await expect(service.get(mine.id, 'org-2', 'owner-1')).rejects.toThrow(NotFoundException);
    await expect(service.update(mine.id, 'org-2', { limitCents: 1 }, 'owner-1')).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.remove(mine.id, 'org-2', 'owner-1')).rejects.toThrow(NotFoundException);

    expect(budgetRepo.row(mine.id)).toMatchObject({ organizationId: 'org-1', limitCents: 5000 });
    expect(await service.list('org-2', 'owner-1')).toHaveLength(0);
  });

  // ── Enforcement ──────────────────────────────────────────────────

  it('no budget → enforcement is a no-op', async () => {
    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(spend.periodToDateCents).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(0);
  });

  it('enforcement reads only this organization’s active budgets', async () => {
    // Another tenant's ceiling and a deactivated one of our own, both far
    // past their limit: neither may stop this run.
    await service.create('org-2', { limitCents: 1, behavior: 'reject' }, 'owner-1');
    await service.create('org-1', { limitCents: 1, behavior: 'reject', active: false }, 'owner-1');
    spend.periodToDateCents.mockResolvedValue(99999);

    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(spend.periodToDateCents).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(0);
  });

  it('reject budget over limit → throws BudgetExceededException and logs a hard alert', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'reject' }, 'owner-1');
    spend.periodToDateCents.mockResolvedValue(1200);

    await expect(service.enforceForRun('org-1', 'agent-1')).rejects.toThrow(
      BudgetExceededException,
    );
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].level).toBe('hard');
    expect(alerts()[0].spentCents).toBe(1200);
  });

  it('warn_log budget over limit → records hard alert but proceeds', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'warn_log' }, 'owner-1');
    spend.periodToDateCents.mockResolvedValue(1500);

    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].level).toBe('hard');
  });

  it('soft threshold breach → records soft alert and proceeds', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'reject', softThresholdPct: 80 }, 'owner-1');
    spend.periodToDateCents.mockResolvedValue(850); // 85% > 80% soft, < 100%

    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].level).toBe('soft');
  });

  it('spend below soft threshold → no alert', async () => {
    await service.create('org-1', { limitCents: 1000 }, 'owner-1');
    spend.periodToDateCents.mockResolvedValue(500);

    await service.enforceForRun('org-1', 'agent-1');
    expect(alerts()).toHaveLength(0);
  });

  it('agent-scoped budget does not apply to a different agent', async () => {
    await service.create('org-1', { limitCents: 1000, agentId: 'agent-A', behavior: 'reject' }, 'owner-1');
    spend.periodToDateCents.mockResolvedValue(9999);

    await expect(service.enforceForRun('org-1', 'agent-B')).resolves.toBeUndefined();
    expect(spend.periodToDateCents).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(0);
  });

  // ── Alert dedup + email ──────────────────────────────────────────

  it('records an alert once per period and emails only this org’s owners/admins', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'warn_log' }, 'owner-1');
    spend.periodToDateCents.mockResolvedValue(1100);

    await service.enforceForRun('org-1', 'agent-1');
    await service.enforceForRun('org-1', 'agent-1'); // same period → deduped
    await flush();

    expect(alerts()).toHaveLength(1);
    expect(mail.send.mock.calls.map((c) => c[0].to)).toEqual(['owner@example.com']);
  });

  // ── Provider scope is not a measurable ceiling ───────────────────
  //
  // No spend table records which LLM provider a run was billed to, so a
  // provider-scoped budget has no meter. It must not be creatable, and a
  // row that exists anyway must not be evaluated against org-wide spend.

  it('refuses to create a provider-scoped budget', async () => {
    await expect(
      service.create('org-1', { limitCents: 1000, llmProviderId: 'prov-1' }, 'owner-1'),
    ).rejects.toThrow(BadRequestException);
    expect(budgets()).toHaveLength(0);
  });

  it('refuses to narrow an existing budget to a provider', async () => {
    const b = await service.create('org-1', { limitCents: 1000 }, 'owner-1');
    await expect(
      service.update(b.id, 'org-1', { llmProviderId: 'prov-1' }, 'owner-1'),
    ).rejects.toThrow(BadRequestException);
    expect(budgetRepo.row(b.id)?.llmProviderId).toBeNull();
  });

  it('never hard-stops a run on a provider-scoped budget', async () => {
    // Hand-insert the row the API now refuses, with a `reject` behavior
    // and org spend far past its limit. Enforcing it would block every
    // run in the org on a ceiling meant for one provider.
    budgetRepo.seed({
      id: 'b-provider',
      organizationId: 'org-1',
      agentId: null,
      llmProviderId: 'prov-1',
      periodType: 'month',
      limitCents: 1000,
      behavior: 'reject',
      softThresholdPct: 80,
      active: true,
    });
    spend.periodToDateCents.mockResolvedValue(99999);

    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(spend.periodToDateCents).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(0);
  });

  // ── Another member's private agent ───────────────────────────────
  //
  // member-1 owns a private agent. To everyone else -- the org owner
  // included -- a budget or breach on it answers like a missing one, a
  // budget cannot be pointed at it, and its breach is told to member-1
  // alone. A private agent with no recorded owner is nobody's.

  describe('budgets and alerts on a private agent', () => {
    let notifications: { emit: jest.Mock; filterUsersWithEmailEnabled: jest.Mock };

    const seedBudget = (id: string, agentId: string | null, extra: Record<string, unknown> = {}) =>
      budgetRepo.seed({
        id,
        organizationId: 'org-1',
        agentId,
        llmProviderId: null,
        periodType: 'month',
        limitCents: 1000,
        behavior: 'warn_log',
        softThresholdPct: 80,
        active: true,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        ...extra,
      } as any);

    const seedAlert = (id: string, agentId: string | null, at: string) =>
      alertRepo.seed({
        id,
        budgetId: 'b-x',
        organizationId: 'org-1',
        agentId,
        llmProviderId: null,
        level: 'soft',
        periodType: 'month',
        periodStart: new Date('2026-09-01T00:00:00Z'),
        spentCents: 900,
        limitCents: 1000,
        at: new Date(at),
      } as any);

    beforeEach(() => {
      agentRepo.seed({ id: 'agent-priv', organizationId: 'org-1', visibility: 'private', createdBy: 'member-1' });
      agentRepo.seed({ id: 'agent-orphan', organizationId: 'org-1', visibility: 'private', createdBy: null });
      notifications = {
        emit: jest.fn().mockResolvedValue(undefined),
        filterUsersWithEmailEnabled: jest.fn(async (_type: string, ids: string[]) => ids),
      };
      service = new BudgetsService(
        budgetRepo as any,
        alertRepo as any,
        userOrgRepo as any,
        userRepo as any,
        spend as any,
        mail as any,
        notifications as any,
        agentRepo as any,
        userTeamRepo as any,
      );
    });

    it('is not listed, fetched, changed or deleted by anyone but the agent owner', async () => {
      seedBudget('b-priv', 'agent-priv');
      seedBudget('b-org', null);

      expect((await service.list('org-1', 'owner-1')).map((b) => b.id)).toEqual(['b-org']);
      expect((await service.list('org-1', null)).map((b) => b.id)).toEqual(['b-org']);
      await expect(service.get('b-priv', 'org-1', 'owner-1')).rejects.toThrow(NotFoundException);
      await expect(service.get('b-priv', 'org-1', undefined)).rejects.toThrow(NotFoundException);
      await expect(service.update('b-priv', 'org-1', { limitCents: 1 }, 'owner-1')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.remove('b-priv', 'org-1', 'owner-1')).rejects.toThrow(NotFoundException);
      expect(budgetRepo.row('b-priv')).toMatchObject({ limitCents: 1000 });

      expect((await service.list('org-1', 'member-1')).map((b) => b.id).sort()).toEqual(['b-org', 'b-priv']);
      await expect(service.get('b-priv', 'org-1', 'member-1')).resolves.toMatchObject({ id: 'b-priv' });
    });

    it('cannot be created or re-pointed at by someone who cannot see the agent', async () => {
      await expect(
        service.create('org-1', { limitCents: 1000, agentId: 'agent-priv' }, 'owner-1'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.create('org-1', { limitCents: 1000, agentId: 'agent-orphan' }, 'member-1'),
      ).rejects.toThrow(NotFoundException);
      // Same answer as for an agent that does not exist in this org.
      await expect(
        service.create('org-1', { limitCents: 1000, agentId: 'agent-nope' }, 'owner-1'),
      ).rejects.toThrow('Agent not found');
      expect(budgets()).toHaveLength(0);

      const mine = await service.create('org-1', { limitCents: 1000 }, 'owner-1');
      await expect(
        service.update(mine.id, 'org-1', { agentId: 'agent-priv' }, 'owner-1'),
      ).rejects.toThrow(NotFoundException);
      expect(budgetRepo.row(mine.id)?.agentId).toBeNull();

      // The owner may.
      const own = await service.create('org-1', { limitCents: 1000, agentId: 'agent-priv' }, 'member-1');
      expect(own.agentId).toBe('agent-priv');
    });

    it('keeps breach alerts on the agent from everyone but its owner', async () => {
      seedAlert('a-org', null, '2026-09-10T00:00:00Z');
      seedAlert('a-shared', 'agent-A', '2026-09-11T00:00:00Z');
      seedAlert('a-priv', 'agent-priv', '2026-09-12T00:00:00Z');
      seedAlert('a-orphan', 'agent-orphan', '2026-09-13T00:00:00Z');

      const ids = async (viewer: string | null | undefined, limit?: number) =>
        (await service.listAlerts('org-1', viewer, limit)).map((a) => a.id);

      expect(await ids('owner-1')).toEqual(['a-shared', 'a-org']);
      expect(await ids(undefined)).toEqual(['a-shared', 'a-org']);
      expect(await ids('member-1')).toEqual(['a-priv', 'a-shared', 'a-org']);
      // The limit counts rows the viewer may see, not rows dropped after.
      expect(await ids('owner-1', 1)).toEqual(['a-shared']);
    });

    it('notifies only the agent owner of a breach, never the org admins', async () => {
      seedBudget('b-priv', 'agent-priv');
      spend.periodToDateCents.mockResolvedValue(1100);

      await service.enforceForRun('org-1', 'agent-priv');
      await flush();

      expect(alerts()).toHaveLength(1);
      expect(mail.send.mock.calls.map((c) => c[0].to)).toEqual(['member@example.com']);
      expect(notifications.emit).toHaveBeenCalledTimes(1);
      expect(notifications.emit.mock.calls[0][0].userIds).toEqual(['member-1']);
    });

    it('notifies nobody when the private agent has no owner or the owner left', async () => {
      seedBudget('b-orphan', 'agent-orphan');
      spend.periodToDateCents.mockResolvedValue(1100);
      await service.enforceForRun('org-1', 'agent-orphan');
      await flush();
      expect(alerts()).toHaveLength(1);
      expect(mail.send).not.toHaveBeenCalled();
      expect(notifications.emit).not.toHaveBeenCalled();

      await userOrgRepo.update({ id: 'm-2' }, { isActive: false });
      seedBudget('b-priv', 'agent-priv');
      await service.enforceForRun('org-1', 'agent-priv');
      await flush();
      expect(mail.send).not.toHaveBeenCalled();
      expect(notifications.emit).not.toHaveBeenCalled();
    });

    it('still tells the admins about a budget on an agent they can see', async () => {
      seedBudget('b-shared', 'agent-A');
      spend.periodToDateCents.mockResolvedValue(1100);
      await service.enforceForRun('org-1', 'agent-A');
      await flush();
      expect(mail.send.mock.calls.map((c) => c[0].to)).toEqual(['owner@example.com']);
      expect(notifications.emit.mock.calls[0][0].userIds).toEqual(['owner-1']);
    });

    it('still enforces a hidden budget: making the agent private does not shed it', async () => {
      seedBudget('b-priv', 'agent-priv', { behavior: 'reject' });
      spend.periodToDateCents.mockResolvedValue(1100);
      await expect(service.enforceForRun('org-1', 'agent-priv')).rejects.toThrow(BudgetExceededException);
    });
  });

  /**
   * A team agent is visible to its team and to the org's owners/admins.
   * A budget or breach on one names the agent and its spend, so it
   * follows the agent: members outside the team neither see it listed
   * nor fetch it, exactly as if it did not exist.
   */
  describe('budgets and alerts on a team agent', () => {
    const budget = (id: string, agentId: string | null, createdAt: string) =>
      budgetRepo.seed({
        id, organizationId: 'org-1', agentId, llmProviderId: null, periodType: 'month',
        limitCents: 1000, behavior: 'warn_log', softThresholdPct: 80, active: true, createdAt: new Date(createdAt),
      } as any);
    const alert = (id: string, agentId: string | null, at: string) =>
      alertRepo.seed({
        id, budgetId: 'b-x', organizationId: 'org-1', agentId, llmProviderId: null, level: 'soft', periodType: 'month',
        periodStart: new Date('2026-09-01T00:00:00Z'), spentCents: 900, limitCents: 1000, at: new Date(at),
      } as any);

    beforeEach(() => {
      userOrgRepo.seed({ id: 'm-4', organizationId: 'org-1', userId: 'outsider', role: OrganizationRole.MEMBER, isActive: true });
      userOrgRepo.seed({ id: 'm-5', organizationId: 'org-1', userId: 'lapsed', role: OrganizationRole.MEMBER, isActive: true });
      agentRepo.seed({ id: 'agent-team', organizationId: 'org-1', visibility: 'team', teamId: 'team-1', createdBy: 'member-1' });
      agentRepo.seed({ id: 'agent-teamless', organizationId: 'org-1', visibility: 'team', teamId: null, createdBy: 'member-1' });
      userTeamRepo.seed({ id: 't-1', userId: 'member-1', teamId: 'team-1', isActive: true });
      // A team row that is no longer active is no membership.
      userTeamRepo.seed({ id: 't-2', userId: 'lapsed', teamId: 'team-1', isActive: false });
      // The same user in a team of that name elsewhere proves nothing here.
      userTeamRepo.seed({ id: 't-3', userId: 'outsider', teamId: 'team-2', isActive: true });

      budget('b-org', null, '2026-09-01T00:00:00Z');
      budget('b-team', 'agent-team', '2026-09-02T00:00:00Z');
      budget('b-teamless', 'agent-teamless', '2026-09-03T00:00:00Z');
      alert('a-org', null, '2026-09-10T00:00:00Z');
      alert('a-team', 'agent-team', '2026-09-11T00:00:00Z');
    });

    it('is hidden from members outside the team', async () => {
      for (const viewer of ['outsider', 'lapsed', 'stranger', null]) {
        expect((await service.list('org-1', viewer)).map((b) => b.id)).toEqual(['b-org']);
        expect((await service.listAlerts('org-1', viewer)).map((a) => a.id)).toEqual(['a-org']);
        await expect(service.get('b-team', 'org-1', viewer)).rejects.toThrow(NotFoundException);
      }
    });

    it('is visible to the team and to the org owners/admins', async () => {
      expect((await service.list('org-1', 'member-1')).map((b) => b.id)).toEqual(['b-team', 'b-org']);
      expect((await service.listAlerts('org-1', 'member-1')).map((a) => a.id)).toEqual(['a-team', 'a-org']);
      expect((await service.get('b-team', 'org-1', 'member-1')).id).toBe('b-team');

      expect((await service.list('org-1', 'owner-1')).map((b) => b.id)).toEqual(['b-teamless', 'b-team', 'b-org']);
      expect((await service.get('b-team', 'org-1', 'owner-1')).id).toBe('b-team');
    });

    it('names the hidden agents for the spend breakdown', async () => {
      expect((await service.hiddenAgentIds('org-1', 'outsider')).sort()).toEqual(['agent-team', 'agent-teamless']);
      expect(await service.hiddenAgentIds('org-1', 'member-1')).toEqual(['agent-teamless']);
      expect(await service.hiddenAgentIds('org-1', 'owner-1')).toEqual([]);
    });
  });
});
