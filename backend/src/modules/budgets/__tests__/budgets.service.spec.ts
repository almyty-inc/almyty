import { BadRequestException, NotFoundException } from '@nestjs/common';

import { SpendAlert } from '../../../entities/spend-alert.entity';
import { SpendBudget } from '../../../entities/spend-budget.entity';
import { BudgetsService } from '../budgets.service';
import { BudgetExceededException } from '../budget-exceeded.exception';
import { FakeTable, fakeAlertTable, fakeBudgetTable } from './budgets.fixtures';

/**
 * Unit tests for BudgetsService — the P2 cost-governance core: CRUD +
 * validation, the pre-run enforcement hook (reject / warn_log /
 * no-budget), and append-only SpendAlert emission with per-period dedup
 * + email delivery.
 *
 * The repositories are the clone-storing, criteria-evaluating fakes from
 * `budgets.fixtures`. The doubles they replace stored the caller's own
 * entity, so `update()` was "persisted" by the service's in-place
 * mutation and the `save()` call could be deleted with the suite still
 * green; and no test read a row through a second organization, so the
 * `organizationId` half of every criteria was unproven.
 */
describe('BudgetsService', () => {
  let budgetRepo: FakeTable<SpendBudget>;
  let alertRepo: FakeTable<SpendAlert>;
  let userOrgRepo: any;
  let userRepo: any;
  let spend: { periodToDateCents: jest.Mock };
  let mail: { send: jest.Mock };
  let service: BudgetsService;

  /** The tables as they stand right now (clones, never the live rows). */
  const alerts = () => alertRepo.rows();
  const budgets = () => budgetRepo.rows();

  beforeEach(() => {
    budgetRepo = fakeBudgetTable();
    alertRepo = fakeAlertTable();

    userOrgRepo = {
      // Controller passes an array of where-clauses (owner OR admin).
      find: jest.fn(() => Promise.resolve([{ userId: 'owner-1' }])),
    };
    userRepo = {
      find: jest.fn(() => Promise.resolve([{ id: 'owner-1', email: 'owner@example.com' }])),
    };

    spend = { periodToDateCents: jest.fn().mockResolvedValue(0) };
    mail = { send: jest.fn().mockResolvedValue(true) };

    service = new BudgetsService(
      budgetRepo as any,
      alertRepo as any,
      userOrgRepo,
      userRepo,
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

  /**
   * The returned object is not the row. An update that mutated its copy
   * and never reached the repository used to be indistinguishable from
   * one that did, because the fake handed out the stored object itself.
   */
  it('update reaches the table, not only the object it returns', async () => {
    const b = await service.create('org-1', { limitCents: 5000 });
    await service.update(b.id, 'org-1', { limitCents: 8000, behavior: 'reject' });

    expect(budgetRepo.current(b.id)).toMatchObject({ limitCents: 8000, behavior: 'reject' });
    expect((await service.get(b.id, 'org-1')).limitCents).toBe(8000);
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
  //
  // A budget id is all a caller sends. Every read and every write is
  // therefore scoped by organization as well, and this is the test that
  // says so: without it, dropping `organizationId` from the `findOne` in
  // `get()` and from the `delete()` criteria in `remove()` changed
  // nothing the suite could see.

  it('a budget belongs to its organization and no other org can read, change or delete it', async () => {
    const mine = await service.create('org-1', { limitCents: 5000 });

    await expect(service.get(mine.id, 'org-2')).rejects.toThrow(NotFoundException);
    await expect(service.update(mine.id, 'org-2', { limitCents: 1 })).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.remove(mine.id, 'org-2')).rejects.toThrow(NotFoundException);

    // Untouched, and still only visible to its own organization.
    expect(budgetRepo.current(mine.id)).toMatchObject({ limitCents: 5000 });
    expect(await service.list('org-2')).toHaveLength(0);
    expect(await service.list('org-1')).toHaveLength(1);
  });

  // ── Enforcement ──────────────────────────────────────────────────

  it('no budget → enforcement is a no-op', async () => {
    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(spend.periodToDateCents).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(0);
  });

  it('enforcement reads only this org’s active budgets', async () => {
    // Another tenant's ceiling, blown wide open, plus a deactivated one
    // of our own: neither may stop this run.
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

  it('records an alert once per period and emails owners on the first breach', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'warn_log' });
    spend.periodToDateCents.mockResolvedValue(1100);

    await service.enforceForRun('org-1', 'agent-1');
    await service.enforceForRun('org-1', 'agent-1'); // same period → deduped
    await flush();

    expect(alerts()).toHaveLength(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0].to).toBe('owner@example.com');
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
