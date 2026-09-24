import * as fs from 'fs';
import * as path from 'path';

import { ApisService } from '../apis/apis.service';
import { FilesService } from '../files/files.service';

/**
 * A paginated list needs a total order.
 *
 * `ORDER BY "createdAt" DESC` alone is not one: `createdAt` is written to
 * millisecond precision, rows that share a value are returned in whatever
 * order the plan happens to produce, and that order is free to differ
 * between two executions of the same query. With `skip`/`take` layered on
 * top, a tied row can be returned on page 1 and again on page 2 while
 * another tied row is never returned at all — and nothing errors. Pairing
 * the timestamp with the primary key makes the sort key unique, which is
 * what makes paging reproducible.
 */
function recorder() {
  const orderBy: Array<[string, string]> = [];
  const qb: any = {
    orderByCalls: orderBy,
    where: () => qb,
    andWhere: () => qb,
    addSelect: () => qb,
    leftJoinAndSelect: () => qb,
    groupBy: () => qb,
    addGroupBy: () => qb,
    skip: () => qb,
    take: () => qb,
    orderBy: (field: string, dir: string) => {
      orderBy.length = 0;
      orderBy.push([field, dir]);
      return qb;
    },
    addOrderBy: (field: string, dir: string) => {
      orderBy.push([field, dir]);
      return qb;
    },
    getCount: async () => 0,
    getMany: async () => [],
    getManyAndCount: async () => [[], 0],
    getRawAndEntities: async () => ({ entities: [], raw: [] }),
  };
  return qb;
}

describe('paginated list queries order by a unique key', () => {
  it('FilesService.findAll breaks createdAt ties on the file id', async () => {
    const findAndCount = jest.fn(async () => [[], 0]);
    const service = new FilesService({ findAndCount } as any, {} as any, {} as any, {} as any);

    await service.findAll('org-1', { page: 2, limit: 10 });

    const [{ order, skip, take }] = findAndCount.mock.calls[0] as any;
    expect(Object.entries(order)).toEqual([
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ]);
    expect({ skip, take }).toEqual({ skip: 10, take: 10 });
  });

  it('ApisService.findAllByOrganization breaks createdAt ties on the api id', async () => {
    const qb = recorder();
    const service = new ApisService(
      { createQueryBuilder: () => qb } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { applyListFilter: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
    );

    await service.findAllByOrganization({ id: 'user-1' }, 'org-1', { page: 2, limit: 10 });

    expect(qb.orderByCalls[0]).toEqual(['api.createdAt', 'DESC']);
    expect(qb.orderByCalls).toContainEqual(['api.id', 'DESC']);
  });

  /**
   * `GatewaysService.getGateways` cannot be driven from a bare constructor
   * (it self-heals a system gateway first, through half a dozen
   * collaborators), so the guard is on the statement itself: the sort is
   * caller-selectable there, and `name` ties far more often than a
   * timestamp does.
   */
  it('GatewaysService.getGateways pairs the caller sort with the gateway id', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'gateways', 'gateways.service.ts'),
      'utf8',
    );
    expect(source).toContain(
      ".orderBy(`gateway.${sortBy}`, sortOrder).addOrderBy('gateway.id', 'ASC')",
    );
  });
});
