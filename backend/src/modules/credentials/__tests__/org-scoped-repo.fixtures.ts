/**
 * Truthful in-memory repository fakes for the tenancy specs.
 *
 * The doubles these replace were `findOne: jest.fn()` handing the same
 * canned row back whatever `where` they were given, so every
 * `where: { id, organizationId }` in a service could lose its
 * `organizationId` and no test would notice. These evaluate the
 * criteria instead, and hand out clones so a caller mutating what it
 * got back does not silently edit the stored row.
 *
 * Modelled on `modules/agents/__tests__/agent-execution.fixtures.ts`.
 */

/** Copy that keeps the entity prototype (and therefore its methods). */
export function cloneRow<T extends object>(row: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(row)), row);
}

/** Evaluate a TypeORM `where` (a plain object, or an array meaning OR). */
export function matchesWhere(row: any, where: any): boolean {
  if (where === undefined || where === null) return true;
  if (Array.isArray(where)) return where.some((w) => matchesWhere(row, w));
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    return row[key] === value;
  });
}

export interface FakeOrgScopedRepo<T> {
  /** The table itself — assert against this, not against the seeds. */
  rows: T[];
  find: jest.Mock;
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
  delete: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
}

/**
 * A repository backed by a little table of its own.
 *
 * `seed` rows are stored as clones, so the spec's own references are
 * never the table; `delete`/`update` compute `affected` from the
 * criteria rather than reporting an unconditional `{ affected: 1 }`.
 */
export function makeOrgScopedRepo<T extends { id?: string }>(
  seed: T[] = [],
  makeEntity: (partial: Partial<T>) => T = (p) => ({ ...(p as T) }),
): FakeOrgScopedRepo<T> {
  const rows: T[] = seed.map((r) => cloneRow(r as any));
  let idc = 0;

  return {
    rows,
    find: jest.fn(async (opts: any = {}) =>
      rows.filter((r) => matchesWhere(r, opts.where)).map((r) => cloneRow(r as any)),
    ),
    findOne: jest.fn(async (opts: any = {}) => {
      const hit = rows.find((r) => matchesWhere(r, opts.where));
      return hit ? cloneRow(hit as any) : null;
    }),
    create: jest.fn((partial: Partial<T> = {}) => makeEntity(partial)),
    save: jest.fn(async (entity: any) => {
      if (!entity.id) entity.id = `row-${++idc}`;
      const i = rows.findIndex((r: any) => r.id === entity.id);
      if (i >= 0) rows[i] = cloneRow(entity);
      else rows.push(cloneRow(entity));
      return cloneRow(entity);
    }),
    remove: jest.fn(async (entity: any) => {
      const i = rows.findIndex((r: any) => r.id === entity.id);
      if (i >= 0) rows.splice(i, 1);
      return entity;
    }),
    delete: jest.fn(async (criteria: any) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matchesWhere(rows[i], criteria)) rows.splice(i, 1);
      }
      return { affected: before - rows.length };
    }),
    update: jest.fn(async (criteria: any, patch: any) => {
      let affected = 0;
      for (const row of rows) {
        if (!matchesWhere(row, criteria)) continue;
        Object.assign(row as any, patch);
        affected += 1;
      }
      return { affected };
    }),
    count: jest.fn(async (opts: any = {}) => rows.filter((r) => matchesWhere(r, opts.where)).length),
  };
}
