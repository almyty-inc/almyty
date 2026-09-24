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
