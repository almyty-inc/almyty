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
