import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { OnboardingService } from './onboarding.service';
import { Api } from '../../entities/api.entity';
import { Tool } from '../../entities/tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { User } from '../../entities/user.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';

/**
 * A chainable query-builder stub. Every builder method returns `this`;
 * the terminal `getCount` / `getOne` resolve to whatever the test sets.
 */
function makeQb(result: { count?: number; one?: any }) {
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(result.count ?? 0),
    getOne: jest.fn().mockResolvedValue(result.one ?? null),
  };
  return qb;
}

const ORG = 'org-1';
const USER = 'user-1';

describe('OnboardingService', () => {
  let service: OnboardingService;
  let providerRepo: any;
  let apiRepo: any;
  let gatewayRepo: any;
  let agentRepo: any;
  let requestLogRepo: any;
  let userRepo: any;

  beforeEach(async () => {
    providerRepo = { count: jest.fn().mockResolvedValue(0) };
    apiRepo = { count: jest.fn().mockResolvedValue(0), createQueryBuilder: jest.fn() };
    gatewayRepo = { createQueryBuilder: jest.fn() };
    agentRepo = {};
    requestLogRepo = { createQueryBuilder: jest.fn() };
    userRepo = { findOne: jest.fn().mockResolvedValue(null), update: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: getRepositoryToken(LlmProvider), useValue: providerRepo },
        { provide: getRepositoryToken(Api), useValue: apiRepo },
        { provide: getRepositoryToken(Gateway), useValue: gatewayRepo },
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: getRepositoryToken(RequestLog), useValue: requestLogRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();

    service = module.get(OnboardingService);
  });

  /** Wire the repos so every step evaluates to `false` by default. */
  function stubEmpty() {
    providerRepo.count.mockResolvedValue(0);
    apiRepo.count.mockResolvedValue(0);
    // apiRepo query builder is used for hasSampleWorkspace (count 0).
    apiRepo.createQueryBuilder.mockReturnValue(makeQb({ count: 0 }));
    gatewayRepo.createQueryBuilder.mockReturnValue(makeQb({ count: 0 }));
    requestLogRepo.createQueryBuilder.mockReturnValue(makeQb({ count: 0, one: null }));
  }

  describe('getState — each step false on an empty org', () => {
    it('reports every step false', async () => {
      stubEmpty();
      const state = await service.getState(ORG, USER);
      expect(state.steps).toEqual({
        provider: false,
        api: false,
        gateway: false,
        first_call: false,
        external_client: false,
      });
      expect(state.dismissed).toBe(false);
      expect(state.activatedRealAt).toBeNull();
      expect(state).not.toHaveProperty('sampleWorkspace');
      expect(state).not.toHaveProperty('activatedSampleAt');
    });
  });

  describe('provider step', () => {
    it('is true when a non-error provider exists', async () => {
      stubEmpty();
      providerRepo.count.mockResolvedValue(1);
      const state = await service.getState(ORG, USER);
      expect(state.steps.provider).toBe(true);
      // The count query excludes status='error'.
      expect(providerRepo.count).toHaveBeenCalled();
    });

    it('is false when only an errored provider exists', async () => {
      stubEmpty();
      providerRepo.count.mockResolvedValue(0); // Not(ERROR) filter yields 0
      const state = await service.getState(ORG, USER);
      expect(state.steps.provider).toBe(false);
    });
  });

  describe('api step', () => {
    it('is true when >=1 API exists', async () => {
      stubEmpty();
      apiRepo.count.mockResolvedValue(2);
      const state = await service.getState(ORG, USER);
      expect(state.steps.api).toBe(true);
    });
  });

  describe('gateway step', () => {
    it('is true when a non-system gateway has a tool assigned', async () => {
      stubEmpty();
      // hasGatewayWithTool + realActivationAt both use gatewayRepo.createQueryBuilder.
      gatewayRepo.createQueryBuilder.mockReturnValue(makeQb({ count: 1 }));
      const state = await service.getState(ORG, USER);
      expect(state.steps.gateway).toBe(true);
    });

    it('is false when no gateway has tools', async () => {
      stubEmpty();
      const state = await service.getState(ORG, USER);
      expect(state.steps.gateway).toBe(false);
    });
  });

  describe('first_call step', () => {
    it('is true when a successful request log exists', async () => {
      stubEmpty();
      const log = { timestamp: new Date('2026-01-01T00:00:00Z') };
      requestLogRepo.createQueryBuilder.mockReturnValue(makeQb({ count: 0, one: log }));
      const state = await service.getState(ORG, USER);
      expect(state.steps.first_call).toBe(true);
    });
  });

  describe('external_client step', () => {
    it('is true when a non-frontend client made a successful gateway call', async () => {
      stubEmpty();
      // getCount is used for external_client (and hasGatewayWithTool);
      // returning 1 for both is fine for this assertion.
      requestLogRepo.createQueryBuilder.mockReturnValue(makeQb({ count: 1, one: null }));
      const state = await service.getState(ORG, USER);
      expect(state.steps.external_client).toBe(true);
    });
  });

  describe('activatedRealAt', () => {
    it('is set once a non-sample gateway exists and a call succeeded', async () => {
      stubEmpty();
      const log = { timestamp: new Date('2026-02-02T00:00:00Z') };
      requestLogRepo.createQueryBuilder.mockReturnValue(makeQb({ count: 0, one: log }));
      // gatewayRepo QB used for hasGatewayWithTool (0) AND realActivationAt (1).
      gatewayRepo.createQueryBuilder
        .mockReturnValueOnce(makeQb({ count: 0 })) // hasGatewayWithTool
        .mockReturnValueOnce(makeQb({ count: 1 })); // realActivationAt (non-sample gateway)
      const state = await service.getState(ORG, USER);
      expect(state.activatedRealAt).toBe('2026-02-02T00:00:00.000Z');
    });
  });


  describe('dismissed (per-user)', () => {
    it('reflects the user preference', async () => {
      stubEmpty();
      userRepo.findOne.mockResolvedValue({ preferences: { onboardingDismissed: true } });
      const state = await service.getState(ORG, USER);
      expect(state.dismissed).toBe(true);
    });

    it('setDismissed persists onto user preferences', async () => {
      userRepo.findOne.mockResolvedValue({ id: USER, preferences: { theme: 'dark' } });
      await service.setDismissed(USER, true);
      expect(userRepo.update).toHaveBeenCalledWith(
        { id: USER },
        { preferences: { theme: 'dark', onboardingDismissed: true } },
      );
    });
  });

  /**
   * The checklist must not read every tenant's request logs.
   *
   * Both request_logs reads carried
   * `(gw.organizationId = :orgId OR log.metadata->>'organizationId' = :orgIdText)`,
   * an OR across `gateways` and `request_logs` that no index can serve --
   * and `firstSuccessfulCall` has no time bound at all, so the checklist
   * on the dashboard scanned the whole table. `request_logs` has carried
   * its own `organizationId` since 1750796000000-RequestLogOrganization,
   * covered by IDX(organizationId, timestamp).
   */
  describe('request_logs org scope is index-shaped', () => {
    const clausesFrom = (qb: any) => [
      ...qb.where.mock.calls.map((c: any[]) => c[0]),
      ...qb.andWhere.mock.calls.map((c: any[]) => c[0]),
    ];

    it('scopes both request-log reads on log.organizationId, with no gateway join', async () => {
      stubEmpty();
      const logQbs: any[] = [];
      requestLogRepo.createQueryBuilder.mockImplementation(() => {
        const qb = makeQb({ count: 0, one: null });
        logQbs.push(qb);
        return qb;
      });

      await service.getState(ORG, USER);

      expect(logQbs.length).toBeGreaterThanOrEqual(2);
      for (const qb of logQbs) {
        const clauses = clausesFrom(qb);
        expect(clauses).toContain('log.organizationId = :orgId');
        expect(
          clauses.some(
            (c: string) =>
              c.includes('gw.organizationId') || c.includes("metadata->>'organizationId'"),
          ),
        ).toBe(false);
        expect(qb.leftJoin).not.toHaveBeenCalled();
      }
    });

    it('binds the org id as a single parameter', async () => {
      stubEmpty();
      const qb = makeQb({ count: 0, one: null });
      requestLogRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getState(ORG, USER);

      expect(qb.where).toHaveBeenCalledWith('log.organizationId = :orgId', { orgId: ORG });
      // `orgIdText`, the text-typed twin the OR predicate needed, is gone.
      const params = qb.where.mock.calls.map((c: any[]) => c[1]);
      expect(params.every((p: any) => !p || !('orgIdText' in p))).toBe(true);
    });
  });
});
