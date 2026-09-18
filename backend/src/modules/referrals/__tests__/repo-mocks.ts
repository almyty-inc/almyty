import { FindOperator } from 'typeorm';

/**
 * Minimal in-memory TypeORM repository mock for the referrals specs.
 * Supports the subset the referrals services use: findOne/find with plain
 * equality plus the IsNull / MoreThan / MoreThanOrEqual operators, create,
 * save (assigns `${prefix}-N` ids), count, and `take`.
 */
export function makeRepo(prefix: string, seed: any[] = []) {
  let idCounter = 0;
  const store: any[] = [...seed];

  const matchesWhere = (row: any, where: any): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      const actual = row[key];
      if (expected instanceof FindOperator) {
        const type = (expected as any).type ?? (expected as any)._type;
        const value = (expected as any).value ?? (expected as any)._value;
        switch (type) {
          case 'isNull':
            return actual === null || actual === undefined;
          case 'moreThan':
            return actual > value;
          case 'moreThanOrEqual':
            return actual >= value;
          case 'lessThan':
            return actual < value;
          case 'lessThanOrEqual':
            return actual <= value;
          default:
            throw new Error(`repo-mock: unsupported FindOperator "${type}"`);
        }
      }
      return actual === expected;
    });
  };

  const repo = {
    store,
    findOne: jest.fn(({ where }: any) =>
      Promise.resolve(store.find((row) => matchesWhere(row, where)) ?? null),
    ),
    find: jest.fn((options: any = {}) => {
      let rows = store.filter((row) => matchesWhere(row, options.where));
      if (options.order) {
        const [key, dir] = Object.entries(options.order)[0] as [string, string];
        rows = [...rows].sort((a, b) =>
          (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (dir === 'DESC' ? -1 : 1),
        );
      }
      if (options.take) rows = rows.slice(0, options.take);
      return Promise.resolve(rows);
    }),
    count: jest.fn(({ where }: any = {}) =>
      Promise.resolve(store.filter((row) => matchesWhere(row, where)).length),
    ),
    create: jest.fn((data: any) => ({ ...data })),
    /**
     * Column-scoped, predicate-guarded write — what the sweeps use to
     * claim a transition. `affected` is 0 when the stored row no longer
     * matches the criteria, which is how a second replica is turned
     * away. A SQL-expression value (`() => '"col" + 1'`) is the
     * database's business: the mock leaves the in-memory value the
     * caller already set.
     */
    update: jest.fn((criteria: any, patch: Record<string, any>) => {
      const where = typeof criteria === 'object' && criteria !== null ? criteria : { id: criteria };
      const row = store.find((r) => matchesWhere(r, where));
      if (!row) return Promise.resolve({ affected: 0 });
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value === 'function') continue;
        row[key] = value;
      }
      return Promise.resolve({ affected: 1 });
    }),
    save: jest.fn((entity: any) => {
      if (!entity.id) entity.id = `${prefix}-${++idCounter}`;
      const idx = store.findIndex((row) => row.id === entity.id);
      if (idx >= 0) store[idx] = entity;
      else store.push(entity);
      return Promise.resolve(entity);
    }),
  };
  return repo;
}

export function makeAudit() {
  return { log: jest.fn().mockResolvedValue(null) };
}
