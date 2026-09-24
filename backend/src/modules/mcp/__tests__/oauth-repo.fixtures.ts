/**
 * Truthful in-memory repositories for the MCP OAuth specs.
 *
 * The hand-written doubles in `mcp-oauth.service.spec.ts` are argument
 * recorders: `findOne` resolves a canned row whatever the `where` says and
 * `update` reports `{ affected: 1 }` whatever the criteria says. That shape
 * cannot exercise a compare-and-set, because the CAS is precisely the case
 * where the criteria stops matching. `mcp-oauth-tokens.helper.ts` has two of
 * them — one on the authorization code, one on refresh-token rotation — and
 * they are the only thing standing between a replayed code and a second
 * valid token pair.
 *
 * These fakes keep a table instead. Rows are cloned in and cloned out, so a
 * caller mutating the entity it was handed never edits "the row", and
 * `update` writes only the rows its criteria still selects and returns the
 * real count.
 *
 * Modelled on `modules/agents/__tests__/agent-execution.fixtures.ts`.
 */

/** Evaluate one criteria value against one column, TypeORM operators included. */
export function valueMatches(cell: any, op: any): boolean {
  if (op === undefined) return true;
  if (op === null) return cell === null || cell === undefined;
  if (op && typeof op === 'object' && typeof op.type === 'string') {
    const child = typeof op.child !== 'undefined' ? op.child : op.value;
    if (op.type === 'not') return !valueMatches(cell, child);
    if (op.type === 'in') return (op.value as any[]).includes(cell);
    if (op.type === 'isNull') return cell === null || cell === undefined;
    return true;
  }
  if (op instanceof Date && cell instanceof Date) return op.getTime() === cell.getTime();
  return cell === op;
}

/** Does this row satisfy every key of the criteria object? */
export function rowMatches(row: any, criteria: any): boolean {
  if (!criteria) return true;
  return Object.entries(criteria).every(([key, op]) => valueMatches(row?.[key], op));
}

export interface FakeRepo<T> {
  /** The table as it stands right now, cloned. */
  rows(): T[];
  /** One row by id, cloned — for asserting what a write actually did. */
  row(id: string): T | undefined;
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
}

/**
 * A repository over a little table of its own.
 *
 * `seed` rows are cloned in. Rows that arrive through `save` without an id
 * are named, so generated tokens land in the table like real ones.
 */
export function fakeRepo<T extends { id?: string }>(
  seed: T[] = [],
  idPrefix = 'row',
): FakeRepo<T> {
  const table = new Map<string, any>();
  let counter = 0;
  const clone = (row: any) => (row === null || row === undefined ? row : { ...row });

  for (const row of seed) {
    const id = row.id ?? `${idPrefix}-${++counter}`;
    table.set(id, { ...row, id });
  }

  const put = (entity: any) => {
    const id = entity.id ?? `${idPrefix}-generated-${++counter}`;
    const stored = { ...entity, id };
    table.set(id, stored);
    return clone(stored);
  };

  return {
    rows: () => [...table.values()].map(clone),
    row: (id: string) => clone(table.get(id)),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (entity: any) =>
      Array.isArray(entity) ? entity.map(put) : put(entity),
    ),
    findOne: jest.fn(async (options: any) => {
      for (const row of table.values()) {
        if (rowMatches(row, options?.where)) return clone(row);
      }
      return null;
    }),
    find: jest.fn(async (options: any) =>
      [...table.values()].filter((row) => rowMatches(row, options?.where)).map(clone),
    ),
    // Compare-and-set, the way Postgres would: rows whose columns no
    // longer satisfy the criteria are not written and are not counted.
    update: jest.fn(async (criteria: any, partial: any) => {
      let affected = 0;
      for (const row of table.values()) {
        if (!rowMatches(row, criteria)) continue;
        for (const [key, value] of Object.entries(partial)) {
          if (value === undefined) continue;
          row[key] = value;
        }
        affected += 1;
      }
      return { affected };
    }),
    count: jest.fn(async (options: any) =>
      [...table.values()].filter((row) => rowMatches(row, options?.where)).length,
    ),
  };
}
