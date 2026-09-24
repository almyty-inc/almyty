/**
 * Truthful in-memory doubles for the budgets module.
 *
 * Not a `.spec.ts`, deliberately: jest only collects spec files.
 *
 * Two properties matter here, and the hand-rolled doubles these replace
 * had neither:
 *
 *  - **Rows are clones.** `save()` stores a snapshot and hands back a
 *    snapshot, so the object a caller keeps is never the row. The old
 *    fake pushed the caller's entity itself, which meant
 *    `BudgetsService.update()` -- read the row, mutate it, save it --
 *    was already "persisted" by the mutation alone. Deleting the
 *    `save()` call entirely left the suite green.
 *  - **Criteria are evaluated.** `find`/`findOne`/`delete`/`update` run
 *    their `where` against the table, so an organization predicate that
 *    goes missing produces a different answer instead of the same one.
 */
import { SpendAlert } from '../../../entities/spend-alert.entity';
import { SpendBudget } from '../../../entities/spend-budget.entity';

/**
 * Enough of TypeORM's FindOperator to drive these queries, plus Date
 * equality: the alert dedup key is (budgetId, periodStart, level), and a
 * Date compared with === never matches a second Date of the same instant.
 */
function valueMatches(expected: any, actual: any): boolean {
  if (expected instanceof Date) {
    return actual != null && new Date(actual).getTime() === expected.getTime();
  }
  if (expected && typeof expected === 'object' && '_type' in expected) {
    switch (expected._type) {
      case 'in':
        return (expected._value as any[]).includes(actual);
      case 'isNull':
        return actual === null || actual === undefined;
      case 'not':
        return !valueMatches(expected._value, actual);
      default:
        return expected._value === actual;
    }
  }
  return expected === actual;
}

/** A `where` object, or an array of them (TypeORM reads an array as OR). */
export function whereMatches(row: Record<string, any>, where: any): boolean {
  if (!where) return true;
  if (Array.isArray(where)) return where.some((w) => whereMatches(row, w));
  return Object.entries(where).every(([k, v]) => valueMatches(v, row[k]));
}

export interface FakeTable<T> {
  /** Every row as the table holds it right now, as clones. */
  rows(): T[];
  /** One row as the table holds it right now, as a clone. */
  current(id: string): T | undefined;
  /** Insert a row directly, bypassing the service (for rows the API now refuses). */
  seed(row: Partial<T>): T;
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  delete: jest.Mock;
  update: jest.Mock;
}

function fakeTable<T extends { id?: string }>(prefix: string, make: () => T): FakeTable<T> {
  const store = new Map<string, T>();
  let seq = 0;
  const snapshot = (row: T): T => Object.assign(make(), row);

  const put = (row: T): T => {
    if (!row.id) (row as any).id = prefix + '-' + String(++seq);
    store.set(row.id!, snapshot(row));
    return snapshot(row);
  };

  return {
    rows: () => [...store.values()].map(snapshot),
    current: (id: string) => {
      const row = store.get(id);
      return row ? snapshot(row) : undefined;
    },
    seed: (row: Partial<T>) => put(Object.assign(make(), row)),
    create: jest.fn((partial: Partial<T>) => Object.assign(make(), partial)),
    save: jest.fn(async (row: T) => put(row)),
    find: jest.fn(async (opts: { where?: any } = {}) =>
      [...store.values()].filter((r) => whereMatches(r, opts.where)).map(snapshot),
    ),
    findOne: jest.fn(async (opts: { where?: any }) => {
      const hit = [...store.values()].find((r) => whereMatches(r, opts?.where));
      return hit ? snapshot(hit) : null;
    }),
    // Only rows the criteria actually selects are removed, so an
    // organization predicate that goes missing deletes another tenant's
    // row and the count it reports changes.
    delete: jest.fn(async (criteria: any) => {
      const doomed = [...store.values()].filter((r) => whereMatches(r, criteria));
      for (const row of doomed) store.delete(row.id!);
      return { affected: doomed.length };
    }),
    update: jest.fn(async (criteria: any, patch: Record<string, any>) => {
      const hits = [...store.values()].filter((r) => whereMatches(r, criteria));
      for (const row of hits) {
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) continue;
          (row as any)[k] = v;
        }
      }
      return { affected: hits.length };
    }),
  };
}

export const fakeBudgetTable = (): FakeTable<SpendBudget> =>
  fakeTable<SpendBudget>('b', () => new SpendBudget());

export const fakeAlertTable = (): FakeTable<SpendAlert> =>
  fakeTable<SpendAlert>('a', () => new SpendAlert());
