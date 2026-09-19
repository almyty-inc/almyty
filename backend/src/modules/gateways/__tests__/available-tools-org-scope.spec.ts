import { GatewayToolQueriesHelper } from '../gateway-tool-queries.helper';
import { ToolStatus } from '../../../entities/tool.entity';

/**
 * `getAvailableTools` is the picker behind
 * `GET /gateways/:id/tools/available`. It proves the gateway belongs to
 * the caller's org and then queried `tools` on `status = 'active'` alone
 * — no org predicate at all — so the list it handed back was every
 * active tool on the instance: other tenants' tool names, descriptions
 * and ids, to any member of any organization.
 */
describe('GatewayToolQueriesHelper.getAvailableTools org scoping', () => {
  function build() {
    const conditions: Array<{ clause: string; params: any }> = [];
    const qb: any = {
      where: (clause: string, params: any) => {
        conditions.push({ clause, params });
        return qb;
      },
      andWhere: (clause: string, params: any) => {
        conditions.push({ clause, params });
        return qb;
      },
      orderBy: () => qb,
      getMany: async () => [],
    };
    const helper = new GatewayToolQueriesHelper(
      { find: jest.fn().mockResolvedValue([]) } as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'gateway-1', organizationId: 'org-a' }) } as any,
      { createQueryBuilder: () => qb } as any,
      {} as any,
      {} as any,
    );
    return { helper, conditions };
  }

  it('restricts the candidate tools to the caller organization', async () => {
    const { helper, conditions } = build();

    await helper.getAvailableTools('gateway-1', 'org-a');

    const orgClause = conditions.find((c) => c.clause.includes('tool.organizationId'));
    expect(orgClause).toBeDefined();
    expect(orgClause!.params).toEqual({ organizationId: 'org-a' });
    // The status filter stays: only active tools are offerable.
    expect(conditions.some((c) => c.params?.status === ToolStatus.ACTIVE)).toBe(true);
  });
});
