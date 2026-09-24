/**
 * Truthful repository fakes for the gateway specs.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`, so a
 * helper exported from a spec re-runs that whole suite inside every
 * importer.
 *
 * The point of these is that they can say NO. A double whose `findOne`
 * returns a fixed row whatever the `where` says, or whose query builder
 * chains fluently and hands back a canned list, proves that a code path
 * ran — never that the predicate it ran with was the right one. Every
 * cross-tenant hole this module has had was a missing predicate, and a
 * canned double is blind to exactly that.
 */

/**
 * Evaluate one column of a `where` against a row's value, including the
 * TypeORM operators the gateway queries actually use (`In`, `Not`,
 * `IsNull`, `LessThanOrEqual`).
 */
export function matchesValue(actual: any, expected: any): boolean {
  if (expected === undefined) return true;
  if (expected === null) return actual === null || actual === undefined;

  if (expected && typeof expected === 'object' && ('_type' in expected || 'type' in expected)) {
    const op: any = expected;
    const type = op._type ?? op.type;
    const value = '_value' in op ? op._value : op.value;
    switch (type) {
      case 'isNull':
        return actual === null || actual === undefined;
      case 'not':
        return !matchesValue(actual, value);
      case 'in':
        return Array.isArray(value) && value.some((v) => matchesValue(actual, v));
      case 'lessThanOrEqual':
        return actual != null && time(actual) <= time(value);
      case 'moreThanOrEqual':
        return actual != null && time(actual) >= time(value);
      default:
        // An operator this fake does not model must not silently pass:
        // a test written against it would prove nothing.
        throw new Error(`fake repository does not model the '${type}' operator`);
    }
  }

  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

const time = (v: any): number => (v instanceof Date ? v.getTime() : Number(v));

/**
 * Whole-`where` match, including the array form TypeORM reads as OR.
 */
export function matchesWhere(row: any, where: any): boolean {
  if (!where) return true;
  if (Array.isArray(where)) return where.some((clause) => matchesWhere(row, clause));
  return Object.entries(where).every(([column, expected]) => matchesValue(row[column], expected));
}

/** A shallow clone, so nothing the caller holds is the stored row. */
const clone = <T>(row: T): T => (row == null ? row : ({ ...(row as any) } as T));

/**
 * A repository backed by a little table of its own.
 *
 * Rows go in and come out as copies: caller-side mutation of something
 * this handed back is not a write, the same way it is not a write
 * against Postgres.
 */
export function fakeRepo<T extends Record<string, any>>(rows: T[] = []) {
  const table: T[] = rows.map(clone);

  const repo = {
    table,
    find: jest.fn(async (options: any = {}) =>
      table.filter((row) => matchesWhere(row, options?.where)).map(clone),
    ),
    findOne: jest.fn(async (options: any = {}) => {
      const hit = table.find((row) => matchesWhere(row, options?.where));
      return hit ? clone(hit) : null;
    }),
    count: jest.fn(async (options: any = {}) =>
      table.filter((row) => matchesWhere(row, options?.where)).length,
    ),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (entity: any) => {
      const index = table.findIndex((row) => row.id === entity.id);
      if (index >= 0) table[index] = clone(entity);
      else table.push(clone(entity));
      return clone(entity);
    }),
    update: jest.fn(async (criteria: any, patch: any) => {
      const where = typeof criteria === 'string' ? { id: criteria } : criteria;
      let affected = 0;
      for (const row of table) {
        if (!matchesWhere(row, where)) continue;
        Object.assign(row, patch);
        affected += 1;
      }
      return { affected };
    }),
    delete: jest.fn(async (criteria: any) => {
      const where = typeof criteria === 'string' ? { id: criteria } : criteria;
      const before = table.length;
      for (let i = table.length - 1; i >= 0; i--) {
        if (matchesWhere(table[i], where)) table.splice(i, 1);
      }
      return { affected: before - table.length };
    }),
    remove: jest.fn(async (entity: any) => {
      const index = table.findIndex((row) => row.id === entity.id);
      if (index >= 0) table.splice(index, 1);
      return entity;
    }),
  };
  return repo;
}
