import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AgentExecution } from '../../../../entities/agent-execution.entity';
import { RoutingAnalyticsController } from '../routing-analytics.controller';
import { MIN_COMPARABLE_REQUESTS } from '../co-failure';
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
 */
describe('GET /analytics/routing/failure-rate', () => {
  let app: INestApplication;
  let rows: any[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RoutingAnalyticsController],
      providers: [{ provide: getRepositoryToken(AgentExecution), useValue: { find: async () => rows } }],
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
    rows = [
      { id: 'e1', agentId: 'a', nodeResults: { n: { routing: { modelId: 'fast', tried: [{ modelId: 'cheap' }] } } } },
      { id: 'e2', agentId: 'a', nodeResults: { n: { routing: { modelId: 'fast', tried: [{ modelId: 'cheap' }] } } } },
      { id: 'e3', agentId: 'a', nodeResults: { n: { error: 'x', triedModels: [{ modelId: 'cheap' }, { modelId: 'fast' }] } } },
    ];

    const { body } = await get();
    const agent = body.data.perAgent[0];
    expect(agent.allModelFailureRate).toBeCloseTo(1 / 3, 5);
    expect(agent.recoverableRate).toBeCloseTo(2 / 3, 5);
  });

  it('marks a thin sample unreportable rather than publishing noise', async () => {
    rows = [{ id: 'e1', agentId: 'a', nodeResults: { n: { routing: { modelId: 'm1', tried: [{ modelId: 'm0' }] } } } }];
    const { body } = await get();
    expect(body.data.perAgent[0].reportable).toBe(false);
    expect(body.data.perAgent[0].comparableRequests).toBe(1);
  });

  it('still returns the thin classes, so a surface can say why an agent is missing', async () => {
    rows = [{ id: 'e1', agentId: 'a', nodeResults: { n: { routing: { modelId: 'm1', tried: [{ modelId: 'm0' }] } } } }];
    const { body } = await get();
    expect(body.data.perAgent).toHaveLength(1);
  });

  it('clamps the window rather than scanning whatever a caller asks for', async () => {
    rows = [];
    expect((await get('?days=9999')).body.data.windowDays).toBe(90);
    expect((await get('?days=-5')).body.data.windowDays).toBe(30);
    expect((await get('?days=7')).body.data.windowDays).toBe(7);
  });
});
