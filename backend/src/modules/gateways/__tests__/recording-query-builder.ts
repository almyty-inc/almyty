import { Brackets } from 'typeorm';

/**
 * A query builder double for the gateways specs that can say no.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 *
 * The chains it replaces were `where: jest.fn().mockReturnThis()` with a
 * terminal that answered a fixed array: the arguments were never looked
 * at, so an organization predicate, its bound parameter or the whole
 * access-policy filter could be deleted with the suite green.
 *
 * This one records every clause with its parameters and takes a snapshot
 * of the WHERE when a terminal runs, so a spec asserts on the query that
 * actually executed rather than on calls made to a mock. It is strict in
 * the places a quiet match would hide a widening:
 *
 *  - `where` replaces the clauses before it, as TypeORM's does, so a late
 *    `where` that wipes an earlier org predicate is visible;
 *  - a top-level `orWhere` throws (an OR at the top widens the scope);
 *    inside `Brackets` it is recorded;
 *  - rebinding a parameter name to a different value throws, since
 *    TypeORM keeps only the last binding and the earlier clause silently
 *    changes meaning;
 *  - a terminal the spec did not answer throws, and a method the class
 *    does not define is a TypeError.
 */

export type ClauseOp = 'where' | 'andWhere' | 'orWhere';

export type SqlClause = { op: ClauseOp; sql: string; params: Record<string, any> };

export type RecordedClause = SqlClause | { op: ClauseOp; brackets: RecordedClause[] };

export interface ExecutedQuery {
  terminal: string;
  clauses: RecordedClause[];
  parameters: Record<string, any>;
}

type Answer = unknown | ((query: ExecutedQuery) => unknown);

export class UnmodelledQueryBuilderCall extends Error {
  constructor(message: string) {
    super(`recording query builder: ${message}`);
    this.name = 'UnmodelledQueryBuilderCall';
  }
}

class ClauseRecorder {
  clauses: RecordedClause[] = [];
  readonly parameters: Record<string, any> = {};

  constructor(private readonly allowOr: boolean) {}

  protected bind(params: Record<string, any> | undefined): void {
    for (const [name, value] of Object.entries(params ?? {})) {
      if (name in this.parameters && this.parameters[name] !== value) {
        throw new UnmodelledQueryBuilderCall(
          `parameter :${name} rebound from ${JSON.stringify(this.parameters[name])} to ${JSON.stringify(value)}`,
        );
      }
      this.parameters[name] = value;
    }
  }

  protected record(op: ClauseOp, condition: unknown, params?: Record<string, any>): this {
    if (op === 'orWhere' && !this.allowOr) {
      throw new UnmodelledQueryBuilderCall('a top-level orWhere widens the scope and is not modelled');
    }
    let recorded: RecordedClause;
    if (condition instanceof Brackets) {
      const inner = new ClauseRecorder(true);
      condition.whereFactory(inner as any);
      this.bind(inner.parameters);
      recorded = { op, brackets: inner.clauses };
    } else if (typeof condition === 'string') {
      this.bind(params);
      recorded = { op, sql: condition, params: { ...(params ?? {}) } };
    } else {
      throw new UnmodelledQueryBuilderCall(`a where of type ${typeof condition} is not modelled`);
    }
    // TypeORM's `where` starts the condition over.
    if (op === 'where') this.clauses = [recorded];
    else this.clauses.push(recorded);
    return this;
  }

  where(condition: unknown, params?: Record<string, any>): this {
    return this.record('where', condition, params);
  }

  andWhere(condition: unknown, params?: Record<string, any>): this {
    return this.record('andWhere', condition, params);
  }

  orWhere(condition: unknown, params?: Record<string, any>): this {
    return this.record('orWhere', condition, params);
  }
}

export class RecordingQueryBuilder extends ClauseRecorder {
  /** Every non-WHERE builder call, in order, with its arguments. */
  readonly calls: Array<{ method: string; args: any[] }> = [];
  /** One entry per terminal that ran, with the WHERE as it stood then. */
  readonly executed: ExecutedQuery[] = [];

  constructor(
    readonly alias: string | undefined,
    private readonly answers: Partial<Record<string, Answer>> = {},
  ) {
    super(false);
  }

  private note(method: string, args: any[]): this {
    this.calls.push({ method, args });
    return this;
  }

  argsOf(method: string): any[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  select(...args: any[]) { return this.note('select', args); }
  addSelect(...args: any[]) { return this.note('addSelect', args); }
  leftJoinAndSelect(...args: any[]) { return this.note('leftJoinAndSelect', args); }
  innerJoin(...args: any[]) { return this.note('innerJoin', args); }
  groupBy(...args: any[]) { return this.note('groupBy', args); }
  orderBy(...args: any[]) { return this.note('orderBy', args); }
  addOrderBy(...args: any[]) { return this.note('addOrderBy', args); }
  skip(...args: any[]) { return this.note('skip', args); }
  take(...args: any[]) { return this.note('take', args); }
  limit(...args: any[]) { return this.note('limit', args); }
  update(...args: any[]) { return this.note('update', args); }
  set(...args: any[]) { return this.note('set', args); }

  private async run(terminal: string): Promise<any> {
    const query: ExecutedQuery = {
      terminal,
      clauses: structuredClone(this.clauses),
      parameters: { ...this.parameters },
    };
    this.executed.push(query);
    if (!(terminal in this.answers)) {
      throw new UnmodelledQueryBuilderCall(`${terminal}() was not answered by the spec`);
    }
    const answer = this.answers[terminal];
    return typeof answer === 'function' ? (answer as (q: ExecutedQuery) => unknown)(query) : answer;
  }

  getMany() { return this.run('getMany'); }
  getCount() { return this.run('getCount'); }
  getRawMany() { return this.run('getRawMany'); }
  getRawOne() { return this.run('getRawOne'); }
  getRawAndEntities() { return this.run('getRawAndEntities'); }
  getOne() { return this.run('getOne'); }
  execute() { return this.run('execute'); }
}

/** SQL of a clause -> whether a row satisfies it under the bound parameters. */
export type ClauseModel = Record<string, (row: any, params: Record<string, any>) => boolean>;

/**
 * The rows that satisfy every top-level clause of `query`, each clause
 * evaluated by its exact SQL through `model`. A clause the model does not
 * list, or a bracketed group, throws: a double that guessed at SQL it was
 * not told about would be a silent match.
 */
export function matchingRows<T>(query: ExecutedQuery, rows: T[], model: ClauseModel): T[] {
  const tests = query.clauses.map((c) => {
    if (!('sql' in c)) throw new UnmodelledQueryBuilderCall('a bracketed clause is not modelled');
    const test = model[c.sql];
    if (!test) throw new UnmodelledQueryBuilderCall(`clause not modelled: ${c.sql}`);
    return test;
  });
  return rows.filter((row) => tests.every((test) => test(row, query.parameters)));
}

/**
 * The top-level clause with exactly this SQL, or undefined. Top-level
 * clauses are AND-ed: a top-level OR cannot be recorded.
 */
export function clause(query: ExecutedQuery, sql: string): SqlClause | undefined {
  return query.clauses.find((c): c is SqlClause => 'sql' in c && c.sql === sql);
}

/**
 * The organization a query is scoped to: the value bound to a top-level
 * `<alias>.organizationId = :param` (quoted or not). Undefined when the
 * query has no such predicate; throws if it has two that disagree.
 */
export function organizationScope(query: ExecutedQuery, alias: string): unknown {
  const pattern = new RegExp(`^${alias}\\."?organizationId"?\\s*=\\s*:(\\w+)$`);
  const bound = new Set<unknown>();
  for (const c of query.clauses) {
    if (!('sql' in c)) continue;
    const m = pattern.exec(c.sql.trim());
    if (m) bound.add(query.parameters[m[1]]);
  }
  if (bound.size > 1) {
    throw new UnmodelledQueryBuilderCall(`query binds two organizations: ${JSON.stringify([...bound])}`);
  }
  return bound.size ? [...bound][0] : undefined;
}

/**
 * Apply one `set()` to a row the way Postgres would. A value is written
 * as given; a function is a raw SQL expression, and only the column
 * copies the counter updates use are modelled: `"col"` and `"col" + 1`.
 */
function applySet(row: any, values: Record<string, any>): void {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'function') {
      row[key] = value;
      continue;
    }
    const sql = String(value()).trim();
    const m = /^"(\w+)"( \+ 1)?$/.exec(sql);
    if (!m) throw new UnmodelledQueryBuilderCall(`set expression not modelled: ${sql}`);
    row[key] = m[2] ? (row[m[1]] ?? 0) + 1 : row[m[1]];
  }
}

/**
 * A `createQueryBuilder` for `update().set().where().execute()` writes
 * against a table: the WHERE is evaluated through `model` (unmodelled
 * SQL throws), the one `set()` is applied to the rows it matched, and the
 * result reports how many that was. `builders` holds every builder made,
 * so a spec can read the write that ran. Any other terminal throws.
 */
export function tableUpdates(rows: any[] | (() => any[]), model: ClauseModel) {
  const builders: RecordingQueryBuilder[] = [];
  const createQueryBuilder = jest.fn((alias?: string) => {
    const qb: RecordingQueryBuilder = new RecordingQueryBuilder(alias, {
      execute: (query: ExecutedQuery) => {
        const sets = qb.argsOf('set');
        if (sets.length !== 1) {
          throw new UnmodelledQueryBuilderCall(`an update takes exactly one set(), got ${sets.length}`);
        }
        const hits = matchingRows(query, typeof rows === 'function' ? rows() : rows, model);
        for (const row of hits) applySet(row, sets[0][0]);
        return { affected: hits.length };
      },
    });
    builders.push(qb);
    return qb;
  });
  return { createQueryBuilder, builders };
}

/** The `id = :id` single-row update the gateway counter bumps use. */
export const BY_ID: ClauseModel = { 'id = :id': (row, p) => row.id === p.id };
/**
 * A `createQueryBuilder` for a path that must not build a query at all.
 * It throws synchronously, so a fire-and-forget write that would have
 * been swallowed by its own `.catch` still fails the request under test.
 */
export const refusingQueryBuilder = (why: string) =>
  jest.fn(() => {
    throw new UnmodelledQueryBuilderCall(`createQueryBuilder() was not expected: ${why}`);
  });