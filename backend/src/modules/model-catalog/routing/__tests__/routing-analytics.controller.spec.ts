import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AgentExecution } from '../../../../entities/agent-execution.entity';
import { RoutingAnalyticsController } from '../routing-analytics.controller';
import { MIN_COMPARABLE_REQUESTS } from '../co-failure';
import { RoutingAttemptRow } from '../attempt-records';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';

/**
 * The all-model failure rate, over the wire.
 *
 * The maths, the derivation and the labels can each be right while the
 * number never reaches a screen, which is what was true until now. The
 * case worth guarding is the binding: `allModelFailureRate` must carry
 * coFailureRate and not routingHeadroomRate. Swapped, it reads perfectly
 * plausibly and is wrong in the direction that matters.
 *
 * The second thing guarded here is the query shape. The endpoint used to
 * select `nodeResults` whole -- every node's full output, capped at 32KB
 * each -- for up to 5,000 runs, to read three fields off each node.
 */
describe('GET /analytics/routing/failure-rate', () => {
  let app: INestApplication;
  let rows: RoutingAttemptRow[] = [];
  let queryCalls: Array<[string, any[]]> = [];

  /**
   * The fixtures below are written as runs because that is how they read;
   * this flattens them into the per-node rows the SQL extraction returns,
   * so the behavioural assertions describe the same scenarios as before.
   */
  const asRows = (executions: Array<{ id: string; agentId: string; nodeResults: Record<string, any> }>) =>
    executions.flatMap((execution) =>
      Object.entries(execution.nodeResults).map(([nodeId, node]: [string, any]) => ({
        executionId: execution.id,
        agentId: execution.agentId,
        nodeId,
        modelId: node.routing?.modelId ?? null,
        tried: node.routing?.tried ?? null,
        triedModels: node.triedModels ?? null,
        hasError: Boolean(node.error),
      })),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RoutingAnalyticsController],
      providers: [
        {
          provide: getRepositoryToken(AgentExecution),
          useValue: {
            query: async (sql: string, params: any[]) => {
              queryCalls.push([sql, params]);
              return rows;
            },
            // Selecting rows at all is the defect: a `find` here would
            // drag every node output back into heap.
            find: async () => {
              throw new Error('nodeResults must not be selected whole');
            },
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { currentOrganizationId: 'org-1' };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    queryCalls = [];
  });

  const get = (qs = '') => request(app.getHttpServer()).get(`/analytics/routing/failure-rate${qs}`).expect(200);

  it('says nothing about an organization with no routed runs', async () => {
    rows = [];
    const { body } = await get();
    expect(body.data.perAgent).toEqual([]);
    expect(body.data.minimumRequests).toBe(MIN_COMPARABLE_REQUESTS);
  });

  it('binds the rate to co-failure and not to the recoverable share', async () => {
    // Deliberately asymmetric: one request where everything failed, two
    // where a fallback rescued it. Bound to the wrong field this reads as
    // 67% and looks entirely believable.
    rows = asRows([
      { id: 'e1', agentId: 'a', nodeResults: { n: { routing: { modelId: 'fast', tried: [{ modelId: 'cheap' }] } } } },
      { id: 'e2', agentId: 'a', nodeResults: { n: { routing: { modelId: 'fast', tried: [{ modelId: 'cheap' }] } } } },
      { id: 'e3', agentId: 'a', nodeResults: { n: { error: 'x', triedModels: [{ modelId: 'cheap' }, { modelId: 'fast' }] } } },
    ]);

    const { body } = await get();
    const agent = body.data.perAgent[0];
    expect(agent.allModelFailureRate).toBeCloseTo(1 / 3, 5);
    expect(agent.recoverableRate).toBeCloseTo(2 / 3, 5);
  });

  it('marks a thin sample unreportable rather than publishing noise', async () => {
    rows = asRows([{ id: 'e1', agentId: 'a', nodeResults: { n: { routing: { modelId: 'm1', tried: [{ modelId: 'm0' }] } } } }]);
    const { body } = await get();
    expect(body.data.perAgent[0].reportable).toBe(false);
    expect(body.data.perAgent[0].comparableRequests).toBe(1);
  });

  it('still returns the thin classes, so a surface can say why an agent is missing', async () => {
    rows = asRows([{ id: 'e1', agentId: 'a', nodeResults: { n: { routing: { modelId: 'm1', tried: [{ modelId: 'm0' }] } } } }]);
    const { body } = await get();
    expect(body.data.perAgent).toHaveLength(1);
  });

  it('clamps the window rather than scanning whatever a caller asks for', async () => {
    rows = [];
    expect((await get('?days=9999')).body.data.windowDays).toBe(90);
    expect((await get('?days=-5')).body.data.windowDays).toBe(30);
    expect((await get('?days=7')).body.data.windowDays).toBe(7);
  });

  it('never selects nodeResults whole — only the routing stamp crosses the wire', async () => {
    rows = [];
    await get();

    expect(queryCalls).toHaveLength(1);
    const [sql] = queryCalls[0];

    // The three fields the co-failure maths reads, extracted server-side.
    expect(sql).toContain("n.value -> 'routing' ->> 'modelId'");
    expect(sql).toContain("n.value -> 'routing' -> 'tried'");
    expect(sql).toContain("n.value -> 'triedModels'");
    // The blob itself is expanded by json_each and never projected.
    expect(sql).toContain('json_each');
    expect(sql).not.toMatch(/SELECT[^;]*r\."nodeResults"\s+AS/i);
  });

  it('takes a deterministic, ordered sample rather than an arbitrary 5,000', async () => {
    rows = [];
    await get('?days=7');

    const [sql, params] = queryCalls[0];
    expect(sql).toMatch(/ORDER BY\s+e\."createdAt"\s+DESC,\s*e\."id"\s+DESC\s+LIMIT \$3/);
    expect(params[0]).toBe('org-1');
    expect(params[1]).toBeInstanceOf(Date);
    expect(params[2]).toBe(5000);
  });
});
