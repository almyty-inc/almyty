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

    service = new BudgetsService(
      budgetRepo as any,
      alertRepo as any,
      userOrgRepo as any,
      userRepo as any,
      spend as any,
      mail as any,
    );
  });

  const flush = () => new Promise((r) => setImmediate(r));

  // ── CRUD + validation ────────────────────────────────────────────

  it('creates, lists, updates and deletes a budget', async () => {
    const b = await service.create('org-1', { limitCents: 5000, periodType: 'month' });
    expect(b.id).toBeDefined();
    expect(b.limitCents).toBe(5000);
    expect(b.behavior).toBe('warn_log');
    expect(b.softThresholdPct).toBe(80);

    expect(await service.list('org-1')).toHaveLength(1);

    const updated = await service.update(b.id, 'org-1', { limitCents: 8000, behavior: 'reject' });
    expect(updated.limitCents).toBe(8000);
    expect(updated.behavior).toBe('reject');

    await service.remove(b.id, 'org-1');
    expect(await service.list('org-1')).toHaveLength(0);
  });

  // The object `update()` returns is its own copy; only the table says
  // whether the change was written.
  it('update reaches the table, not only the object it returns', async () => {
    const b = await service.create('org-1', { limitCents: 5000 });
    await service.update(b.id, 'org-1', { limitCents: 8000, behavior: 'reject' });

    expect(budgetRepo.row(b.id)).toMatchObject({ limitCents: 8000, behavior: 'reject' });
  });

  it('rejects invalid budget input', async () => {
    await expect(service.create('org-1', { limitCents: 0 })).rejects.toThrow(BadRequestException);
    await expect(service.create('org-1', { limitCents: -5 })).rejects.toThrow(BadRequestException);
    await expect(
      service.create('org-1', { limitCents: 100, periodType: 'year' as any }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create('org-1', { limitCents: 100, behavior: 'silent' as any }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create('org-1', { limitCents: 100, softThresholdPct: 150 }),
    ).rejects.toThrow(BadRequestException);
  });

  // ── Tenancy ──────────────────────────────────────────────────────

  it('no other organization can read, change or delete a budget', async () => {
    const mine = await service.create('org-1', { limitCents: 5000 });

    await expect(service.get(mine.id, 'org-2')).rejects.toThrow(NotFoundException);
    await expect(service.update(mine.id, 'org-2', { limitCents: 1 })).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.remove(mine.id, 'org-2')).rejects.toThrow(NotFoundException);

    expect(budgetRepo.row(mine.id)).toMatchObject({ organizationId: 'org-1', limitCents: 5000 });
    expect(await service.list('org-2')).toHaveLength(0);
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
    await service.create('org-2', { limitCents: 1, behavior: 'reject' });
    await service.create('org-1', { limitCents: 1, behavior: 'reject', active: false });
    spend.periodToDateCents.mockResolvedValue(99999);

    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(spend.periodToDateCents).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(0);
  });

  it('reject budget over limit → throws BudgetExceededException and logs a hard alert', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'reject' });
    spend.periodToDateCents.mockResolvedValue(1200);

    await expect(service.enforceForRun('org-1', 'agent-1')).rejects.toThrow(
      BudgetExceededException,
    );
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].level).toBe('hard');
    expect(alerts()[0].spentCents).toBe(1200);
  });

  it('warn_log budget over limit → records hard alert but proceeds', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'warn_log' });
    spend.periodToDateCents.mockResolvedValue(1500);

    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].level).toBe('hard');
  });

  it('soft threshold breach → records soft alert and proceeds', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'reject', softThresholdPct: 80 });
    spend.periodToDateCents.mockResolvedValue(850); // 85% > 80% soft, < 100%

    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0].level).toBe('soft');
  });

  it('spend below soft threshold → no alert', async () => {
    await service.create('org-1', { limitCents: 1000 });
    spend.periodToDateCents.mockResolvedValue(500);

    await service.enforceForRun('org-1', 'agent-1');
    expect(alerts()).toHaveLength(0);
  });

  it('agent-scoped budget does not apply to a different agent', async () => {
    await service.create('org-1', { limitCents: 1000, agentId: 'agent-A', behavior: 'reject' });
    spend.periodToDateCents.mockResolvedValue(9999);

    await expect(service.enforceForRun('org-1', 'agent-B')).resolves.toBeUndefined();
    expect(spend.periodToDateCents).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(0);
  });

  // ── Alert dedup + email ──────────────────────────────────────────

  it('records an alert once per period and emails only this org’s owners/admins', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'warn_log' });
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
      service.create('org-1', { limitCents: 1000, llmProviderId: 'prov-1' }),
    ).rejects.toThrow(BadRequestException);
    expect(budgets()).toHaveLength(0);
  });

  it('refuses to narrow an existing budget to a provider', async () => {
    const b = await service.create('org-1', { limitCents: 1000 });
    await expect(
      service.update(b.id, 'org-1', { llmProviderId: 'prov-1' }),
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
});
