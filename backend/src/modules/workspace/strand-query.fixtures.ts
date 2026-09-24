/**
 * The stranding fan-out's `UPDATE workspaces SET ... WHERE ...`, for the
 * workspace specs' in-memory stores.
 *
 * The builders this replaces read the runner ids and the required status
 * from the parameters and ignored the SQL, so the WHERE could be rewritten
 * to match every runner's workspaces, in any state, with the suites green.
 * This one evaluates the exact clauses it models against every row and
 * throws on anything else. Not a `.spec.ts`: jest would collect it.
 */
const CLAUSES: Record<string, (row: any, params: Record<string, any>) => boolean> = {
  '"runnerId" IN (:...runnerIds)': (row, p) => (p.runnerIds as string[]).includes(row.runnerId),
  'status = :active': (row, p) => row.status === p.active,
};

/** The one raw SQL value the fan-out sets: closeReason from the row's own runnerId. */
const EXPRESSIONS: Record<string, (row: any) => unknown> = {
  "json_build_object('kind', 'stranded', 'detail', \"runnerId\")": (row) => ({ kind: 'stranded', detail: row.runnerId }),
};

/** `rows` returns the stored rows themselves; matches are written in place. */
export function strandingQueryBuilder(rows: () => Iterable<any>) {
  let patch: Record<string, any> | undefined;
  const clauses: Array<{ sql: string; params: Record<string, any> }> = [];
  const qb: any = {
    update: () => qb,
    set: (values: Record<string, any>) => { patch = values; return qb; },
    where: (sql: string, params: Record<string, any> = {}) => { clauses.push({ sql, params }); return qb; },
    andWhere: (sql: string, params: Record<string, any> = {}) => { clauses.push({ sql, params }); return qb; },
    execute: async () => {
      if (!patch || clauses.length === 0) throw new Error('an UPDATE without SET or WHERE is not modelled');
      const params = Object.assign({}, ...clauses.map((c) => c.params));
      const predicates = clauses.map(({ sql }) => {
        const p = CLAUSES[sql];
        if (!p) throw new Error(`the clause "${sql}" is not modelled`);
        return p;
      });
      let affected = 0;
      for (const row of rows()) {
        if (!predicates.every((p) => p(row, params))) continue;
        for (const [k, v] of Object.entries(patch)) {
          if (typeof v !== 'function') { row[k] = v; continue; }
          const expr = EXPRESSIONS[String(v())];
          if (!expr) throw new Error(`the SQL expression ${String(v())} is not modelled`);
          row[k] = expr(row);
        }
        affected += 1;
      }
      return { affected };
    },
  };
  return qb;
}
