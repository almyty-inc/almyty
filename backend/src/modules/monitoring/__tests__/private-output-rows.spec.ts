import { FindOperator } from 'typeorm';

import { AnalyticsService } from '../analytics.service';
import { AnalyticsExportHelper } from '../analytics-export.helper';
import {
  notOthersPrivateAgent,
  notOthersPrivateAgentRun,
  notOthersPrivateGateway,
  notOthersPrivateProvider,
  notOthersPrivateTool,
} from '../private-rows';

/**
 * Wiring of the private-row filters into the request log and the analytics
 * export: which predicates each query carries and what viewer they bind.
 * The SQL itself runs against Postgres in
 * test/integration/private-output-leaks.integration.spec.ts.
 */

type Clause = { sql: string; params: Record<string, unknown> };

/** A query builder double that records every where clause and its params. */
function recordingQb(rows: unknown[] = []) {
  const clauses: Clause[] = [];
  const qb: any = {};
  for (const m of ['select', 'innerJoin', 'orderBy', 'skip', 'take']) qb[m] = jest.fn(() => qb);
  qb.where = qb.andWhere = jest.fn((sql: string, params: Record<string, unknown> = {}) => {
    clauses.push({ sql, params });
    return qb;
  });
  qb.getMany = jest.fn().mockResolvedValue(rows);
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, rows.length]);
  return { qb, clauses };
}

const toolClause = (clauses: Clause[]) => clauses.find((c) => c.sql.includes('FROM tools pt'));
const gatewayClause = (clauses: Clause[]) => clauses.find((c) => c.sql.includes('FROM gateways pg'));

describe('private-rows fragments', () => {
  it.each([
    ['gateway', notOthersPrivateGateway, 'gateways pg', 'pg."ownerUserId"'],
    ['provider', notOthersPrivateProvider, 'llm_providers pp', 'pp."ownerUserId"'],
    ['tool', notOthersPrivateTool, 'tools pt', 'pt."createdBy"'],
    ['agent', notOthersPrivateAgent, 'agents pa', 'pa."createdBy"'],
    ['agent run', notOthersPrivateAgentRun, 'agent_runs pr JOIN agents pra', 'pra."createdBy"'],
  ])('%s: compares the owner as text so uuid and varchar owners mix in one query', (_n, fragment, table, owner) => {
    const sql = fragment('x."id"');
    expect(sql).toContain(`FROM ${table}`);
    // `(owner = viewer) IS NOT TRUE`: a null owner or a null viewer never
    // matches as "the viewer's own" (IS DISTINCT FROM matched null to null).
    expect(sql).toContain(`(${owner}::text = CAST(:privateViewerId AS text)) IS NOT TRUE`);
    expect(sql).not.toContain('IS DISTINCT FROM');
    expect(sql).toContain("visibility = 'private'");
  });
});

describe('AnalyticsService.getRequestLogs private rows', () => {
  const serviceWith = (qb: any) =>
    new AnalyticsService(
      { createQueryBuilder: jest.fn(() => qb) } as any,
      null as any, null as any, null as any, null as any, null as any, null as any, null as any, null as any,
    );

  it("filters another member's private gateway and private tool, bound to the caller", async () => {
    const { qb, clauses } = recordingQb();
    await serviceWith(qb).getRequestLogs({ organizationId: 'org-1', page: 1, limit: 50, callerId: 'user-1' });

    expect(gatewayClause(clauses)?.params).toEqual({ privateViewerId: 'user-1' });
    expect(toolClause(clauses)?.sql).toContain('log.toolId IS NULL OR');
    expect(toolClause(clauses)?.params).toEqual({ privateViewerId: 'user-1' });
  });

  it('keeps the tool filter when the caller narrows to one tool (a tool log page)', async () => {
    const { qb, clauses } = recordingQb();
    await serviceWith(qb).getRequestLogs({ organizationId: 'org-1', page: 1, limit: 50, callerId: 'user-1', toolId: 't-1' });

    expect(toolClause(clauses)).toBeDefined();
    expect(clauses.some((c) => c.sql === 'log.toolId = :toolId')).toBe(true);
  });

  it('binds null (no private rows at all) when there is no known caller', async () => {
    const { qb, clauses } = recordingQb();
    await serviceWith(qb).getRequestLogs({ organizationId: 'org-1', page: 1, limit: 50, callerId: undefined as any });

    expect(gatewayClause(clauses)?.params).toEqual({ privateViewerId: null });
    expect(toolClause(clauses)?.params).toEqual({ privateViewerId: null });
  });
});

describe('AnalyticsExportHelper private rows', () => {
  const rawOn = (where: any, key: string) => {
    const op = where[key] as FindOperator<unknown>;
    expect(op).toBeInstanceOf(FindOperator);
    expect(op.type).toBe('raw');
    return { sql: (op as any).getSql(`"T"."${key}"`) as string, params: op.objectLiteralParameters };
  };

  const build = () => {
    const { qb, clauses } = recordingQb();
    const execs = { find: jest.fn().mockResolvedValue([]) };
    const sessions = { find: jest.fn().mockResolvedValue([]) };
    const helper = new AnalyticsExportHelper({ createQueryBuilder: jest.fn(() => qb) } as any, execs as any, sessions as any);
    return { helper, clauses, execs, sessions };
  };

  it("requests: drops another member's private gateway and private tool rows", async () => {
    const { helper, clauses } = build();
    await helper.exportData({ organizationId: 'org-1', type: 'requests', callerId: 'admin-1' });

    expect(gatewayClause(clauses)?.params).toEqual({ privateViewerId: 'admin-1' });
    expect(toolClause(clauses)?.params).toEqual({ privateViewerId: 'admin-1' });
  });

  it('tool executions: filters private tool, private gateway and private agent runs', async () => {
    const { helper, execs } = build();
    await helper.exportData({ organizationId: 'org-1', type: 'tool-executions', callerId: 'admin-1' });

    const where = execs.find.mock.calls[0][0].where;
    expect(rawOn(where, 'toolId').sql).toContain('FROM tools pt');
    expect(rawOn(where, 'gatewayId').sql).toContain('FROM gateways pg');
    expect(rawOn(where, 'runId').sql).toContain('FROM agent_runs pr');
    for (const key of ['toolId', 'gatewayId', 'runId']) {
      expect(rawOn(where, key).params).toEqual({ privateViewerId: 'admin-1' });
    }
  });

  it('LLM sessions: filters private provider, private agent and private gateway', async () => {
    const { helper, sessions } = build();
    await helper.exportData({ organizationId: 'org-1', type: 'llm-sessions', callerId: 'admin-1' });

    const where = sessions.find.mock.calls[0][0].where;
    expect(rawOn(where, 'providerId').sql).toContain('FROM llm_providers pp');
    expect(rawOn(where, 'agentId').sql).toContain('FROM agents pa');
    expect(rawOn(where, 'gatewayId').sql).toContain('FROM gateways pg');
  });

  it('fails closed: no caller binds a null viewer on every row set', async () => {
    const { helper, clauses, execs, sessions } = build();
    for (const type of ['requests', 'tool-executions', 'llm-sessions'] as const) {
      await helper.exportData({ organizationId: 'org-1', type, callerId: undefined as any });
    }
    expect(toolClause(clauses)?.params).toEqual({ privateViewerId: null });
    expect(rawOn(execs.find.mock.calls[0][0].where, 'toolId').params).toEqual({ privateViewerId: null });
    expect(rawOn(sessions.find.mock.calls[0][0].where, 'agentId').params).toEqual({ privateViewerId: null });
  });
});
