import { BadRequestException } from '@nestjs/common';

import { BudgetsService } from '../budgets.service';
import { BudgetExceededException } from '../budget-exceeded.exception';

/**
 * Unit tests for BudgetsService — the P2 cost-governance core: CRUD +
 * validation, the pre-run enforcement hook (reject / warn_log /
 * no-budget), and append-only SpendAlert emission with per-period dedup
 * + email delivery.
 */
describe('BudgetsService', () => {
  let budgetStore: any[];
  let alertStore: any[];
  let budgetRepo: any;
  let alertRepo: any;
  let userOrgRepo: any;
  let userRepo: any;
  let spend: { periodToDateCents: jest.Mock };
  let mail: { send: jest.Mock };
  let service: BudgetsService;

  const matches = (row: any, where: any): boolean =>
    Object.keys(where).every((k) => {
      const v = where[k];
      if (v instanceof Date) return new Date(row[k]).getTime() === v.getTime();
      return row[k] === v;
    });

  beforeEach(() => {
    budgetStore = [];
    alertStore = [];
    let bId = 0;
    let aId = 0;

    budgetRepo = {
      create: jest.fn((x: any) => ({ ...x })),
      save: jest.fn((b: any) => {
        if (!b.id) b.id = `b-${++bId}`;
        const i = budgetStore.findIndex((x) => x.id === b.id);
        if (i >= 0) budgetStore[i] = b;
        else budgetStore.push(b);
        return Promise.resolve(b);
      }),
      find: jest.fn(({ where }: any) =>
        Promise.resolve(budgetStore.filter((b) => matches(b, where))),
      ),
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve(budgetStore.find((b) => matches(b, where)) || null),
      ),
      delete: jest.fn((where: any) => {
        const before = budgetStore.length;
        budgetStore = budgetStore.filter((b) => !matches(b, where));
        return Promise.resolve({ affected: before - budgetStore.length });
      }),
    };

    alertRepo = {
      create: jest.fn((x: any) => ({ ...x })),
      save: jest.fn((a: any) => {
        if (!a.id) a.id = `a-${++aId}`;
        alertStore.push(a);
        return Promise.resolve(a);
      }),
      findOne: jest.fn(({ where }: any) =>
        Promise.resolve(alertStore.find((a) => matches(a, where)) || null),
      ),
      find: jest.fn(() => Promise.resolve([...alertStore])),
    };

    userOrgRepo = {
      // Controller passes an array of where-clauses (owner OR admin).
      find: jest.fn(() => Promise.resolve([{ userId: 'owner-1' }])),
    };
    userRepo = {
      find: jest.fn(() => Promise.resolve([{ email: 'owner@example.com' }])),
    };

    spend = { periodToDateCents: jest.fn().mockResolvedValue(0) };
    mail = { send: jest.fn().mockResolvedValue(true) };

    service = new BudgetsService(
      budgetRepo,
      alertRepo,
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

  // ── Enforcement ──────────────────────────────────────────────────

  it('no budget → enforcement is a no-op', async () => {
    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(spend.periodToDateCents).not.toHaveBeenCalled();
    expect(alertStore).toHaveLength(0);
  });

  it('reject budget over limit → throws BudgetExceededException and logs a hard alert', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'reject' });
    spend.periodToDateCents.mockResolvedValue(1200);

    await expect(service.enforceForRun('org-1', 'agent-1')).rejects.toThrow(
      BudgetExceededException,
    );
    expect(alertStore).toHaveLength(1);
    expect(alertStore[0].level).toBe('hard');
    expect(alertStore[0].spentCents).toBe(1200);
  });

  it('warn_log budget over limit → records hard alert but proceeds', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'warn_log' });
    spend.periodToDateCents.mockResolvedValue(1500);

    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(alertStore).toHaveLength(1);
    expect(alertStore[0].level).toBe('hard');
  });

  it('soft threshold breach → records soft alert and proceeds', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'reject', softThresholdPct: 80 });
    spend.periodToDateCents.mockResolvedValue(850); // 85% > 80% soft, < 100%

    await expect(service.enforceForRun('org-1', 'agent-1')).resolves.toBeUndefined();
    expect(alertStore).toHaveLength(1);
    expect(alertStore[0].level).toBe('soft');
  });

  it('spend below soft threshold → no alert', async () => {
    await service.create('org-1', { limitCents: 1000 });
    spend.periodToDateCents.mockResolvedValue(500);

    await service.enforceForRun('org-1', 'agent-1');
    expect(alertStore).toHaveLength(0);
  });

  it('agent-scoped budget does not apply to a different agent', async () => {
    await service.create('org-1', { limitCents: 1000, agentId: 'agent-A', behavior: 'reject' });
    spend.periodToDateCents.mockResolvedValue(9999);

    await expect(service.enforceForRun('org-1', 'agent-B')).resolves.toBeUndefined();
    expect(spend.periodToDateCents).not.toHaveBeenCalled();
    expect(alertStore).toHaveLength(0);
  });

  // ── Alert dedup + email ──────────────────────────────────────────

  it('records an alert once per period and emails owners on the first breach', async () => {
    await service.create('org-1', { limitCents: 1000, behavior: 'warn_log' });
    spend.periodToDateCents.mockResolvedValue(1100);

    await service.enforceForRun('org-1', 'agent-1');
    await service.enforceForRun('org-1', 'agent-1'); // same period → deduped
    await flush();

    expect(alertStore).toHaveLength(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0].to).toBe('owner@example.com');
  });
});
