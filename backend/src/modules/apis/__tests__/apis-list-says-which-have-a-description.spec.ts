import { ApisService } from '../apis.service';

/**
 * A hand-made (Custom HTTP) API has no description, so no operations: its
 * tools each call a path set by hand. The APIs list showed such an API as
 * "1 tool, 0 operations". The list now says whether each API has a
 * description, so the page can tell "made by hand" from "nothing imported".
 */
describe('GET /apis says which APIs have a description', () => {
  const makeService = (raw: any[], entities: any[]) => {
    const qb: any = {
      andWhere: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(entities.length),
      getRawAndEntities: jest.fn().mockResolvedValue({ entities, raw }),
    };
    const service = Object.create(ApisService.prototype) as ApisService;
    (service as any).apiRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    (service as any).accessPolicy = { applyListFilter: jest.fn().mockResolvedValue(undefined) };
    return { service, qb };
  };

  it('selects whether a schema was imported for each API', async () => {
    const { service, qb } = makeService([], []);

    await service.findAllByOrganization({ id: 'u-1' }, 'org-1', {});

    const select = qb.addSelect.mock.calls.find((call: any[]) => call[1] === 'api_hasDescription');
    expect(select).toBeDefined();
    expect(select[0]).toMatch(/EXISTS\s*\(SELECT 1 FROM api_schemas s WHERE s\."apiId" = api\.id\)/);
  });

  it('sets hasDescription next to the counts, whatever form the driver returns the boolean in', async () => {
    const npm: any = { id: 'api-npm', name: 'npm registry', type: 'http' };
    const meteo: any = { id: 'api-om', name: 'Open-Meteo', type: 'openapi' };
    const graph: any = { id: 'api-g', name: 'Graph', type: 'openapi' };
    const { service } = makeService(
      [
        { api_operationCount: '0', api_toolCount: '1', api_hasDescription: false },
        { api_operationCount: '3', api_toolCount: '2', api_hasDescription: true },
        { api_operationCount: '9', api_toolCount: '0', api_hasDescription: 't' },
      ],
      [npm, meteo, graph],
    );

    const { apis } = await service.findAllByOrganization({ id: 'u-1' }, 'org-1', {});

    expect(apis.map((a) => [a.name, a.operationCount, a.toolCount, a.hasDescription])).toEqual([
      ['npm registry', 0, 1, false],
      ['Open-Meteo', 3, 2, true],
      ['Graph', 9, 0, true],
    ]);
  });
});
