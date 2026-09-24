import { FindOperator } from 'typeorm';

/**
 * Minimal in-memory TypeORM repository mock for the referrals specs.
 * Supports the subset the referrals services use: findOne/find with plain
 * equality plus the IsNull / MoreThan / MoreThanOrEqual operators, create,
 * save (assigns `${prefix}-N` ids), count, and `take`.
 *
 * It hands out DETACHED COPIES and stores DETACHED COPIES, deliberately.
 *
 * An earlier version kept the caller's object: `save(entity)` pushed that
 * very reference into the store and `find()` handed it straight back, so
 * the service mutating `referral.rewardDays` in memory also mutated "the
 * row". Three separate writes in `awardReferrerDays` — the SQL increment
 * of `rewardDays`, `save(referrerOrg)` for the plan extension, and
 * `save(code)` for the accrual bank — could each be deleted outright with
 * the whole referrals suite still green, because the in-memory mutation
 * the service does alongside them was doing all the work the assertions
 * saw. Rewards are money; a write that nothing proves happens is the last
 * place to accept that.
 */
export function makeRepo(prefix: string, seed: any[] = []) {
  let idCounter = 0;
  const store: any[] = [...seed];

  /** A row as a caller would get it back from the database: detached. */
  const detach = <T>(row: T): T => {
    if (row === null || typeof row !== 'object') return row;
    const out: any = Array.isArray(row) ? [] : {};
    for (const [k, v] of Object.entries(row as any)) {
      out[k] = v instanceof Date ? new Date(v.getTime()) : v;
    }
    return out;
  };

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

  /**
   * Apply one column of an UPDATE patch to a stored row.
   *
   * A SQL-expression value (`() => '"rewardDays" + 14'`) is how the
   * service increments a counter without reading it first, and it is the
   * whole point of that write — so the mock evaluates the arithmetic
   * against the STORED value rather than shrugging and leaving whatever
   * the caller happened to set in memory.
   */
  const applyColumn = (row: any, key: string, value: any): void => {
    if (typeof value !== 'function') {
      row[key] = value;
      return;
    }
    const expr = String(value());
    const m = /^"([^"]+)"\s*([+-])\s*(\d+(?:\.\d+)?)$/.exec(expr.trim());
    if (!m) {
      throw new Error(`repo-mock: unsupported SQL expression "${expr}"`);
    }
    const [, column, op, operand] = m;
    const base = Number(row[column] ?? 0);
    row[key] = op === '+' ? base + Number(operand) : base - Number(operand);
  };

  const repo = {
    store,
    findOne: jest.fn(({ where }: any) =>
      Promise.resolve(detach(store.find((row) => matchesWhere(row, where)) ?? null)),
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
      return Promise.resolve(rows.map(detach));
    }),
    count: jest.fn(({ where }: any = {}) =>
      Promise.resolve(store.filter((row) => matchesWhere(row, where)).length),
    ),
    create: jest.fn((data: any) => ({ ...data })),
    /**
     * Column-scoped, predicate-guarded write — what the sweeps use to
     * claim a transition. `affected` is 0 when no stored row matches the
     * criteria, which is how a second replica is turned away.
     */
    update: jest.fn((criteria: any, patch: Record<string, any>) => {
      const where = typeof criteria === 'object' && criteria !== null ? criteria : { id: criteria };
      const rows = store.filter((r) => matchesWhere(r, where));
      for (const row of rows) {
        for (const [key, value] of Object.entries(patch)) {
          applyColumn(row, key, value);
        }
      }
      return Promise.resolve({ affected: rows.length });
    }),
    save: jest.fn((entity: any) => {
      if (!entity.id) entity.id = `${prefix}-${++idCounter}`;
      const idx = store.findIndex((row) => row.id === entity.id);
      if (idx >= 0) store[idx] = detach(entity);
      else store.push(detach(entity));
      return Promise.resolve(entity);
    }),
  };
  return repo;
}

export function makeAudit() {
  return { log: jest.fn().mockResolvedValue(null) };
}
