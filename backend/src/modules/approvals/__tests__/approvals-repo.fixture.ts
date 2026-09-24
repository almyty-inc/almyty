import { ApprovalRequest } from '../../../entities/approval-request.entity';
import {
  fakeRepository,
  FakeRepository,
  UnmodelledQueryError,
} from '../../../test/fake-repository';

/**
 * The `approval_requests` table for approvals specs: the shared truthful
 * repository plus the two query-builder shapes `ApprovalsService` uses.
 *
 *  - the compare-and-set flip, `UPDATE ... SET ... WHERE id = :id AND
 *    status = :pending`, run through the table's own `update`, so it
 *    reports how many rows really moved;
 *  - the pending list, `WHERE a.status = :status ORDER BY a."createdAt"
 *    DESC LIMIT n`.
 *
 * Any other clause throws. Rows get `createdAt`/`updatedAt` on first save,
 * as the column defaults would give them.
 */
export type FakeApprovalsRepo = FakeRepository<ApprovalRequest> & {
  createQueryBuilder: jest.Mock;
};

const UPDATE_CLAUSES: Record<string, (p: any) => Record<string, any>> = {
  'id = :id': (p) => ({ id: p.id }),
  'status = :pending': (p) => ({ status: p.pending }),
};

const SELECT_CLAUSES: Record<string, (p: any) => Record<string, any>> = {
  'a.status = :status': (p) => ({ status: p.status }),
};

export function fakeApprovalsRepo(seed: Array<Partial<ApprovalRequest>> = []): FakeApprovalsRepo {
  const repo = fakeRepository<ApprovalRequest>({ seed, idPrefix: 'a' });
  let tick = 0;

  const store = repo.save.getMockImplementation()!;
  repo.save.mockImplementation(async (entity: any) => {
    if (!entity.createdAt) {
      entity.createdAt = new Date(1_700_000_000_000 + tick++);
      entity.updatedAt = entity.createdAt;
    }
    return store(entity);
  });

  const createQueryBuilder = jest.fn((alias?: string) => {
    let isUpdate = false;
    let patch: Record<string, any> = {};
    const where: Record<string, any> = {};
    let order: Record<string, 'ASC' | 'DESC'> | undefined;
    let take: number | undefined;

    const clause = (sql: string, params: any) => {
      const table = isUpdate ? UPDATE_CLAUSES : SELECT_CLAUSES;
      const map = table[sql];
      if (!map || (!isUpdate && alias !== 'a')) {
        throw new UnmodelledQueryError(`approvals query clause "${sql}"`);
      }
      Object.assign(where, map(params));
      return qb;
    };

    const qb: any = {
      update: () => {
        isUpdate = true;
        return qb;
      },
      set: (values: Record<string, any>) => {
        patch = values;
        return qb;
      },
      where: clause,
      andWhere: clause,
      orderBy: (column: string, direction: 'ASC' | 'DESC') => {
        if (column !== 'a."createdAt"') throw new UnmodelledQueryError(`approvals order "${column}"`);
        order = { createdAt: direction };
        return qb;
      },
      take: (n: number) => {
        take = n;
        return qb;
      },
      getMany: async () => repo.find({ where, order, take }),
      execute: async () => {
        if (!isUpdate) throw new UnmodelledQueryError('execute() on a select');
        return repo.update(where, patch);
      },
    };
    return qb;
  });

  return Object.assign(repo, { createQueryBuilder });
}
