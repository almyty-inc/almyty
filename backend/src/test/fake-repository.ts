/**
 * A truthful in-memory TypeORM repository for unit specs.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 *
 * A repository double earns its place only if it can say no. The shapes
 * that cannot -- and that let a guard be deleted with its suite green --
 * are the ones this replaces:
 *
 *  - `save` storing the caller's own object, so an in-memory mutation is
 *    already "the row" and the write itself is never exercised;
 *  - `update`/`delete` ignoring their criteria and answering
 *    `{ affected: 1 }`, so a compare-and-set can only ever be seen
 *    winning;
 *  - `findOne` answering a canned row whatever the `where` says, so an
 *    organization predicate can go missing without a test noticing.
 *
 * Here every read and write evaluates its criteria against a table, rows
 * are deep-copied in and out (prototype kept, so entity methods still
 * work), and `update`/`delete` report how many rows they really touched.
 *
 * It is strict where TypeORM is strict. TypeORM 1.x refuses `null` and
 * `undefined` in a `where` by default (`invalidWhereValuesBehavior`), so
 * this does too; a criteria shape or operator it does not model throws
 * rather than matching, because a double that quietly matched would prove
 * nothing about the query.
 *
 * `select` and `relations` are not modelled: rows come back whole, with
 * whatever nested objects they were seeded with.
 */
import { FindOperator } from 'typeorm';

/** Thrown for a query shape this fake does not model. Never a silent match. */
export class UnmodelledQueryError extends Error {
  constructor(message: string) {
    super(`fake repository: ${message}`);
    this.name = 'UnmodelledQueryError';
  }
}

const isPlainObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v);

/**
 * A deep copy that keeps prototypes, so a copied entity keeps its
 * methods, and that never shares a nested object with the original.
 */
export function cloneRow<T>(value: T, seen = new WeakMap<object, any>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as any;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as any;
  if (value instanceof FindOperator) return value;
  if (seen.has(value as any)) return seen.get(value as any);
  if (Array.isArray(value)) {
    const out: any[] = [];
    seen.set(value, out);
    for (const item of value) out.push(cloneRow(item, seen));
    return out as any;
  }
  if (value instanceof Map || value instanceof Set) {
    throw new UnmodelledQueryError('a Map or Set column is not modelled');
  }
  const out = Object.create(Object.getPrototypeOf(value));
  seen.set(value as any, out);
  for (const key of Object.keys(value as any)) out[key] = cloneRow((value as any)[key], seen);
  return out;
}

const time = (v: any): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

function scalarEquals(cell: any, expected: any): boolean {
  if (expected instanceof Date) return cell != null && time(cell) === expected.getTime();
  if (cell instanceof Date) return expected != null && time(expected) === cell.getTime();
  return cell === expected;
}

function compare(cell: any, bound: any): number {
  if (bound instanceof Date || cell instanceof Date) return time(cell) - time(bound);
  return cell < bound ? -1 : cell > bound ? 1 : 0;
}

function likeToRegExp(pattern: string, flags: string): RegExp {
  const body = pattern
    .split('')
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, flags);
}

/** A table a `Raw` predicate may read: anything that can list its rows now. */
export interface RawTable {
  rows(): any[];
}

/** What a match may consult beyond the row itself. */
export interface MatchContext {
  tables?: Record<string, RawTable>;
}

/**
 * `Raw` predicates are SQL, so the fake cannot run them in general. It
 * renders the SQL with a placeholder for the column and evaluates only
 * the exact shapes listed below; any other SQL throws, because a Raw the
 * fake guessed at would be a silent match.
 *
 *  - `<col> IS NULL`
 *  - `(<col> IS NULL OR <shape>)`
 *  - the "not someone else's private resource" fragment the helpers in
 *    `monitoring/private-rows.ts` build for gateways, providers, tools and
 *    agents:
 *      NOT EXISTS (SELECT 1 FROM <table> <a> WHERE <a>.id = <col>
 *        AND <a>.visibility = 'private'
 *        AND (<a>."<owner>"::text = CAST(:<param> AS text)) IS NOT TRUE)
 *    evaluated against `tables[<table>]` with Postgres null semantics
 *    (`=` is null when either side is null, and null IS NOT TRUE: a null
 *    owner or a null viewer never counts as the viewer's own row).
 */
const RAW_COLUMN = '"__fake_raw_column__"';
const RAW_COLUMN_RE = RAW_COLUMN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RAW_OR_NULL = new RegExp(`^\\(${RAW_COLUMN_RE} IS NULL OR (.+)\\)$`);
const RAW_IS_NULL = new RegExp(`^${RAW_COLUMN_RE} IS NULL$`);
const RAW_NOT_OTHERS_PRIVATE = new RegExp(
  `^NOT EXISTS \\(SELECT 1 FROM ([a-z_]+) ([a-z_]+) WHERE \\2\\.id = ${RAW_COLUMN_RE} ` +
    `AND \\2\\.visibility = 'private' ` +
    `AND \\(\\2\\."([A-Za-z_]+)"::text = CAST\\(:([A-Za-z_]+) AS text\\)\\) IS NOT TRUE\\)$`,
);

const asText = (v: any): string | null => (v === null || v === undefined ? null : String(v));

function rawExpressionMatches(sql: string, cell: any, params: Record<string, any>, ctx: MatchContext): boolean {
  const orNull = RAW_OR_NULL.exec(sql);
  if (orNull) return cell === null || cell === undefined || rawExpressionMatches(orNull[1], cell, params, ctx);
  if (RAW_IS_NULL.test(sql)) return cell === null || cell === undefined;
  const priv = RAW_NOT_OTHERS_PRIVATE.exec(sql);
  if (priv) {
    const [, tableName, , ownerColumn, param] = priv;
    const table = ctx.tables?.[tableName];
    if (!table) {
      throw new UnmodelledQueryError(`a Raw predicate reads the '${tableName}' table, which was not given in tables`);
    }
    if (!Object.prototype.hasOwnProperty.call(params, param) || params[param] === undefined) {
      throw new UnmodelledQueryError(`a Raw predicate binds :${param}, which has no value`);
    }
    const viewer = asText(params[param]);
    // `<a>.id = <col>` is never true for a null column, so nothing exists.
    if (cell === null || cell === undefined) return true;
    const exists = table
      .rows()
      .some((r) => {
        if (!scalarEquals(r.id, cell) || r.visibility !== 'private') return false;
        const owner = asText(r[ownerColumn]);
        // (owner = viewer) IS NOT TRUE: only a present owner equal to a
        // present viewer is the viewer's own; a null on either side is not.
        const ownersOwn = owner !== null && viewer !== null && owner === viewer;
        return !ownersOwn;
      });
    return !exists;
  }
  throw new UnmodelledQueryError(`the Raw SQL "${sql}" is not modelled`);
}

function rawMatches(cell: any, op: FindOperator<any>, ctx: MatchContext): boolean {
  const getSql = (op as any)._getSql;
  if (typeof getSql !== 'function') throw new UnmodelledQueryError('a Raw with a literal value is not modelled');
  const sql = String(getSql(RAW_COLUMN)).replace(/\s+/g, ' ').trim();
  return rawExpressionMatches(sql, cell, (op as any)._objectLiteralParameters ?? {}, ctx);
}

function operatorMatches(cell: any, op: FindOperator<any>, ctx: MatchContext): boolean {
  // `_value`, not `value`: the public getter unwraps a nested operator,
  // which would turn Not(In([...])) into Not([...]).
  const value = (op as any)._value;
  switch (op.type) {
    case 'equal':
      return valueMatches(cell, value, ctx);
    case 'not':
      return !valueMatches(cell, value, ctx);
    case 'in':
    case 'any':
      return (value as any[]).some((v) => scalarEquals(cell, v));
    case 'isNull':
      return cell === null || cell === undefined;
    case 'lessThan':
      return cell != null && compare(cell, value) < 0;
    case 'lessThanOrEqual':
      return cell != null && compare(cell, value) <= 0;
    case 'moreThan':
      return cell != null && compare(cell, value) > 0;
    case 'moreThanOrEqual':
      return cell != null && compare(cell, value) >= 0;
    case 'between':
      return cell != null && compare(cell, value[0]) >= 0 && compare(cell, value[1]) <= 0;
    case 'like':
      return typeof cell === 'string' && likeToRegExp(value, '').test(cell);
    case 'ilike':
      return typeof cell === 'string' && likeToRegExp(value, 'i').test(cell);
    case 'and':
      return (value as any[]).every((v) => valueMatches(cell, v, ctx));
    case 'or':
      return (value as any[]).some((v) => valueMatches(cell, v, ctx));
    case 'arrayContains':
      return Array.isArray(cell) && (value as any[]).every((v) => cell.includes(v));
    case 'raw':
      return rawMatches(cell, op, ctx);
    default:
      throw new UnmodelledQueryError(`the '${op.type}' operator is not modelled`);
  }
}

/** Evaluate one `where` value against one column. */
export function valueMatches(cell: any, expected: any, ctx: MatchContext = {}): boolean {
  if (expected === undefined || expected === null) {
    // TypeORM's default `invalidWhereValuesBehavior` is to throw on both.
    throw new UnmodelledQueryError(
      `a ${expected === null ? 'null' : 'undefined'} value in a where object is refused by ` +
        'TypeORM (use IsNull(), or leave the key out)',
    );
  }
  if (expected instanceof FindOperator) return operatorMatches(cell, expected, ctx);
  if (isPlainObject(expected)) {
    // A nested where: a relation or an embedded column. The fake has no
    // joins, so the row must carry the related object itself.
    if (!isPlainObject(cell)) {
      throw new UnmodelledQueryError(
        `nested where ${JSON.stringify(Object.keys(expected))} against a row that does not carry that relation`,
      );
    }
    return whereMatches(cell, expected, ctx);
  }
  if (Array.isArray(expected)) {
    throw new UnmodelledQueryError('a bare array in a where object (use In())');
  }
  return scalarEquals(cell, expected);
}

/** A `where` object, or an array of them (TypeORM reads an array as OR). */
export function whereMatches(row: any, where: any, ctx: MatchContext = {}): boolean {
  if (where === undefined) return true;
  if (Array.isArray(where)) {
    if (where.length === 0) throw new UnmodelledQueryError('an empty where array');
    return where.some((clause) => whereMatches(row, clause, ctx));
  }
  if (!isPlainObject(where)) throw new UnmodelledQueryError(`where of type ${typeof where}`);
  return Object.entries(where).every(([column, expected]) => valueMatches(row?.[column], expected, ctx));
}

/** `update`/`delete` criteria: an id, a list of ids, or a where object. */
function criteriaWhere(criteria: any): any {
  if (criteria === undefined || criteria === null || criteria === '') {
    throw new UnmodelledQueryError('empty criteria (TypeORM refuses these)');
  }
  if (typeof criteria === 'string' || typeof criteria === 'number') return { id: criteria };
  if (Array.isArray(criteria)) {
    if (criteria.every((c) => typeof c === 'string' || typeof c === 'number')) {
      return criteria.map((id) => ({ id }));
    }
    return criteria;
  }
  if (isPlainObject(criteria) && Object.keys(criteria).length === 0) {
    throw new UnmodelledQueryError('empty criteria (TypeORM refuses these)');
  }
  return criteria;
}

/**
 * One column of an UPDATE patch. A function value is a raw SQL
 * expression; the only one modelled is `"column" +/- n`, evaluated
 * against the STORED value -- which is the point of writing it that way.
 */
function applyColumn(row: any, key: string, value: any): void {
  if (value === undefined) return;
  if (typeof value !== 'function') {
    row[key] = cloneRow(value);
    return;
  }
  const expr = String(value()).trim();
  const m = /^"?([A-Za-z_][A-Za-z0-9_]*)"?\s*([+-])\s*(\d+(?:\.\d+)?)$/.exec(expr);
  if (!m) throw new UnmodelledQueryError(`the SQL expression "${expr}" is not modelled`);
  const [, column, sign, operand] = m;
  const base = Number(row[column] ?? 0);
  row[key] = sign === '+' ? base + Number(operand) : base - Number(operand);
}

function sortRows(rows: any[], order: Record<string, any> | undefined): any[] {
  if (!order) return rows;
  const keys = Object.entries(order);
  return [...rows].sort((a, b) => {
    for (const [key, dir] of keys) {
      if (isPlainObject(dir) && !('direction' in dir)) {
        throw new UnmodelledQueryError(`ordering by a relation (${key}) is not modelled`);
      }
      const direction = String(isPlainObject(dir) ? dir.direction : dir).toUpperCase();
      if (a[key] === b[key]) continue;
      if (a[key] == null) return 1;
      if (b[key] == null) return -1;
      const c = compare(a[key], b[key]);
      if (c !== 0) return direction === 'DESC' ? -c : c;
    }
    return 0;
  });
}

export interface FakeRepositoryOptions<T> {
  /** Rows the table starts with. They are copied in. */
  seed?: Array<Partial<T>>;
  /** Builds an empty entity for `create` and `seed`, so entity methods exist. */
  make?: () => T;
  /** Prefix for ids assigned to rows saved without one. */
  idPrefix?: string;
  /**
   * Other tables a modelled `Raw` predicate reads, by SQL table name (e.g.
   * `{ agents: agentsRepo }`). Read at query time, so later writes count.
   * A `Raw` naming a table not given here throws.
   */
  tables?: Record<string, RawTable>;
}

export interface FakeRepository<T> {
  /** Every row as the table holds it now, as copies. */
  rows(): T[];
  /** One row as the table holds it now, as a copy (undefined if absent). */
  row(id: string): T | undefined;
  /** Put a row straight into the table, bypassing the service. */
  seed(row: Partial<T>): T;
  create: jest.Mock;
  save: jest.Mock;
  insert: jest.Mock;
  find: jest.Mock;
  findBy: jest.Mock;
  findAndCount: jest.Mock;
  findOne: jest.Mock;
  findOneBy: jest.Mock;
  findOneOrFail: jest.Mock;
  count: jest.Mock;
  countBy: jest.Mock;
  exists: jest.Mock;
  existsBy: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  remove: jest.Mock;
  increment: jest.Mock;
  decrement: jest.Mock;
}

export function fakeRepository<T extends { id?: any } = any>(
  options: FakeRepositoryOptions<T> | Array<Partial<T>> = {},
): FakeRepository<T> {
  const opts: FakeRepositoryOptions<T> = Array.isArray(options) ? { seed: options } : options;
  const make = opts.make ?? (() => ({}) as T);
  const prefix = opts.idPrefix ?? 'row';
  const table = new Map<string, any>();
  let counter = 0;

  const put = (entity: any): void => {
    if (entity.id === undefined || entity.id === null) entity.id = `${prefix}-${++counter}`;
    table.set(String(entity.id), cloneRow(entity));
  };

  const ctx: MatchContext = { tables: opts.tables };
  const select = (where: any): any[] => [...table.values()].filter((row) => whereMatches(row, where, ctx));

  const query = (findOptions: any = {}): any[] => {
    let out = sortRows(select(findOptions.where), findOptions.order);
    if (findOptions.skip) out = out.slice(findOptions.skip);
    if (findOptions.take) out = out.slice(0, findOptions.take);
    return out.map((row) => cloneRow(row));
  };

  for (const row of opts.seed ?? []) put(Object.assign(make(), cloneRow(row)));

  const findOne = async (findOptions: any = {}) => query({ ...findOptions, take: 1 })[0] ?? null;

  return {
    rows: () => [...table.values()].map((row) => cloneRow(row)),
    row: (id: string) => {
      const row = table.get(String(id));
      return row ? cloneRow(row) : undefined;
    },
    seed: (row: Partial<T>) => {
      const entity = Object.assign(make(), cloneRow(row));
      put(entity);
      return cloneRow(entity);
    },
    create: jest.fn((partial?: any) =>
      Array.isArray(partial)
        ? partial.map((p) => Object.assign(make(), p))
        : Object.assign(make(), partial ?? {}),
    ),
    // TypeORM writes the generated id onto the entity it was handed and
    // returns that same object; what it stores is a copy.
    save: jest.fn(async (entity: any) => {
      if (Array.isArray(entity)) entity.forEach(put);
      else put(entity);
      return entity;
    }),
    insert: jest.fn(async (entity: any) => {
      const list = Array.isArray(entity) ? entity : [entity];
      for (const e of list) {
        if (e.id != null && table.has(String(e.id))) {
          throw new Error(`duplicate key value violates unique constraint (id=${e.id})`);
        }
      }
      list.forEach(put);
      return { identifiers: list.map((e) => ({ id: e.id })), generatedMaps: [], raw: [] };
    }),
    find: jest.fn(async (findOptions?: any) => query(findOptions)),
    findBy: jest.fn(async (where: any) => query({ where })),
    findAndCount: jest.fn(async (findOptions: any = {}) => [
      query(findOptions),
      select(findOptions.where).length,
    ]),
    findOne: jest.fn(findOne),
    findOneBy: jest.fn(async (where: any) => findOne({ where })),
    findOneOrFail: jest.fn(async (findOptions: any) => {
      const row = await findOne(findOptions);
      if (!row) throw new Error('EntityNotFoundError');
      return row;
    }),
    count: jest.fn(async (findOptions: any = {}) => select(findOptions.where).length),
    countBy: jest.fn(async (where: any) => select(where).length),
    exists: jest.fn(async (findOptions: any = {}) => select(findOptions.where).length > 0),
    existsBy: jest.fn(async (where: any) => select(where).length > 0),
    // A compare-and-set the way Postgres runs one: only rows the criteria
    // still selects are written, and `affected` is how many that was.
    update: jest.fn(async (criteria: any, patch: Record<string, any>) => {
      const hits = select(criteriaWhere(criteria));
      for (const row of hits) {
        for (const [key, value] of Object.entries(patch)) applyColumn(row, key, value);
      }
      return { affected: hits.length, raw: [], generatedMaps: [] };
    }),
    delete: jest.fn(async (criteria: any) => {
      const hits = select(criteriaWhere(criteria));
      for (const row of hits) table.delete(String(row.id));
      return { affected: hits.length, raw: [] };
    }),
    // TypeORM clears the id on the entity it removed.
    remove: jest.fn(async (entity: any) => {
      const list = Array.isArray(entity) ? entity : [entity];
      for (const e of list) {
        table.delete(String(e.id));
        e.id = undefined;
      }
      return entity;
    }),
    increment: jest.fn(async (criteria: any, column: string, by: number) => {
      const hits = select(criteriaWhere(criteria));
      for (const row of hits) row[column] = Number(row[column] ?? 0) + Number(by);
      return { affected: hits.length, raw: [], generatedMaps: [] };
    }),
    decrement: jest.fn(async (criteria: any, column: string, by: number) => {
      const hits = select(criteriaWhere(criteria));
      for (const row of hits) row[column] = Number(row[column] ?? 0) - Number(by);
      return { affected: hits.length, raw: [], generatedMaps: [] };
    }),
  };
}

/**
 * An EntityManager over fake repositories, for code that reaches through
 * `repository.manager` (a transaction, or `getRepository(Entity)`).
 *
 * `transaction` runs the callback against this same manager and does NOT
 * model rollback: a spec that needs "neither happens alone" must assert it
 * some other way. Asking for an entity with no repository registered
 * throws, rather than handing back something that answers everything.
 */
export function fakeManager(
  repositories: Array<[Function, FakeRepository<any>]>,
): { getRepository: jest.Mock; transaction: jest.Mock } {
  const byEntity = new Map<Function, FakeRepository<any>>(repositories);
  const manager = {
    getRepository: jest.fn((entity: Function) => {
      const repo = byEntity.get(entity);
      if (!repo) throw new UnmodelledQueryError(`no fake repository for ${entity?.name ?? entity}`);
      return repo;
    }),
    transaction: jest.fn(async (...args: any[]) => {
      const work = args[args.length - 1];
      return work(manager);
    }),
  };
  for (const repo of byEntity.values()) (repo as any).manager = manager;
  return manager;
}
