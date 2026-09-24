import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';

import { OnboardingService } from './onboarding.service';
import { Api } from '../../entities/api.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { User } from '../../entities/user.entity';
import { RequestLog } from '../../entities/request-log.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { AgentApp } from '../../entities/agent-app.entity';
import { AppDistribution, DistributionStatus } from '../../entities/agent-app-distribution.entity';
import { Runner } from '../../entities/runner.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';

/**
 * A chainable query-builder stub. Every builder method returns `this`;
 * the terminal `getCount` / `getOne` resolve to whatever the test sets.
 */
function makeQb(result: { count?: number; one?: any }) {
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
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
  let toolRepo: any;
  let appRepo: any;
  let distributionRepo: any;
  let runnerRepo: any;
  let accessPolicy: any;

  beforeEach(async () => {
    providerRepo = { count: jest.fn().mockResolvedValue(0) };
    apiRepo = { count: jest.fn().mockResolvedValue(0), createQueryBuilder: jest.fn() };
    gatewayRepo = { createQueryBuilder: jest.fn() };
    agentRepo = { findOne: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) };
    requestLogRepo = { createQueryBuilder: jest.fn() };
    userRepo = { findOne: jest.fn().mockResolvedValue(null), update: jest.fn() };
    toolRepo = { count: jest.fn().mockResolvedValue(0) };
    appRepo = { findOne: jest.fn().mockResolvedValue(null) };
    distributionRepo = { count: jest.fn().mockResolvedValue(0) };
    runnerRepo = { count: jest.fn().mockResolvedValue(0) };
    accessPolicy = {
      visibleWhere: jest.fn(async (_user: any, org: string, base: any) => [{ ...base, organizationId: org }]),
      applyListFilter: jest.fn(async () => ({ bypass: false, teamIds: [] })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: getRepositoryToken(LlmProvider), useValue: providerRepo },
        { provide: getRepositoryToken(Api), useValue: apiRepo },
        { provide: getRepositoryToken(Gateway), useValue: gatewayRepo },
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: getRepositoryToken(RequestLog), useValue: requestLogRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(Tool), useValue: toolRepo },
        { provide: getRepositoryToken(AgentApp), useValue: appRepo },
        { provide: getRepositoryToken(AppDistribution), useValue: distributionRepo },
        { provide: getRepositoryToken(Runner), useValue: runnerRepo },
        { provide: AccessPolicyService, useValue: accessPolicy },
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

  /**
   * The `where` of the one call a count/findOne repo received. Visible-set
   * counts pass one where per visibility tier; the stub returns a single
   * tier, the base where plus the org.
   */
  const whereOf = (fn: jest.Mock) => {
    const where = fn.mock.calls[0][0].where;
    return Array.isArray(where) ? where[0] : where;
  };

  describe('getState — each step false on an empty org', () => {
    it('reports every step false and no links', async () => {
      stubEmpty();
      const state = await service.getState(ORG, USER);
      expect(state.steps).toEqual({
        provider: false,
        api: false,
        tools: false,
        gateway: false,
        first_call: false,
        external_client: false,
        agent: false,
        agent_run: false,
        app: false,
        distribution: false,
        runner: false,
      });
      expect(state.links).toEqual({ gateway: null, agent: null, app: null });
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

  describe('tools step', () => {
    it('is true when the org has a tool, and deleted tools do not count', async () => {
      stubEmpty();
      toolRepo.count.mockResolvedValue(3);
      const state = await service.getState(ORG, USER);
      expect(state.steps.tools).toBe(true);
      const where = whereOf(toolRepo.count);
      expect(where.organizationId).toBe(ORG);
      expect(where.status).toBeInstanceOf(FindOperator);
      expect(where.status.type).toBe('not');
      expect(where.status.value).toBe(ToolStatus.DELETED);
    });
  });

  describe('gateway step', () => {
    it('is true when a non-system gateway has a tool assigned, and links to it', async () => {
      stubEmpty();
      const gw = { id: 'gw-1', name: 'Weather', type: 'mcp', endpoint: '/weather', createdAt: new Date() };
      const qb = makeQb({ count: 1, one: gw });
      gatewayRepo.createQueryBuilder.mockReturnValue(qb);
      const state = await service.getState(ORG, USER);
      expect(state.steps.gateway).toBe(true);
      expect(state.links.gateway).toEqual({ id: 'gw-1', name: 'Weather', type: 'mcp', endpoint: '/weather' });
      // Gateways with tools only, never the system gateway, one row.
      expect(qb.innerJoin).toHaveBeenCalledWith('gw.tools', 'gt');
      expect(qb.andWhere).toHaveBeenCalledWith('gw.isSystem = false');
      expect(qb.limit).toHaveBeenCalledWith(1);
      // MCP first: it is the one a coding harness connects to in one command.
      expect(qb.orderBy.mock.calls[0][0]).toContain("gw.type = 'mcp'");
    });

    it('is false when no gateway has tools', async () => {
      stubEmpty();
      const state = await service.getState(ORG, USER);
      expect(state.steps.gateway).toBe(false);
      expect(state.links.gateway).toBeNull();
    });
  });

  describe('agent steps', () => {
    it('agent is true for a built agent, excludes temporary sub-agent copies, and links to it', async () => {
      stubEmpty();
      agentRepo.findOne.mockResolvedValue({ id: 'ag-1', name: 'Support' });
      const state = await service.getState(ORG, USER);
      expect(state.steps.agent).toBe(true);
      expect(state.links.agent).toEqual({ id: 'ag-1', name: 'Support' });
      expect(whereOf(agentRepo.findOne)).toEqual({ organizationId: ORG, isTemporary: false });
    });

    it('agent_run needs an agent with a successful execution, not merely an agent', async () => {
      stubEmpty();
      agentRepo.findOne.mockResolvedValue({ id: 'ag-1', name: 'Support' });
      agentRepo.count.mockResolvedValue(0);
      let state = await service.getState(ORG, USER);
      expect(state.steps.agent_run).toBe(false);

      agentRepo.count.mockResolvedValue(1);
      state = await service.getState(ORG, USER);
      expect(state.steps.agent_run).toBe(true);
      const where = whereOf(agentRepo.count);
      expect(where.organizationId).toBe(ORG);
      expect(where.isTemporary).toBe(false);
      expect(where.successfulExecutions.type).toBe('moreThan');
      expect(where.successfulExecutions.value).toBe(0);
    });
  });

  describe('app steps', () => {
    it('app is true once an app exists and links to it by slug', async () => {
      stubEmpty();
      appRepo.findOne.mockResolvedValue({ slug: 'helpdesk', name: 'Helpdesk' });
      const state = await service.getState(ORG, USER);
      expect(state.steps.app).toBe(true);
      expect(state.links.app).toEqual({ slug: 'helpdesk', name: 'Helpdesk' });
      expect(whereOf(appRepo.findOne)).toEqual({ organizationId: ORG });
    });

    it('distribution counts only live or built ones, not drafts', async () => {
      stubEmpty();
      distributionRepo.count.mockResolvedValue(1);
      const state = await service.getState(ORG, USER);
      expect(state.steps.distribution).toBe(true);
      const where = whereOf(distributionRepo.count);
      expect(where.organizationId).toBe(ORG);
      expect(where.status.type).toBe('in');
      expect([...where.status.value].sort()).toEqual(
        [DistributionStatus.BUILT, DistributionStatus.LIVE].sort(),
      );
      expect(where.status.value).not.toContain(DistributionStatus.DRAFT);
    });
  });

  describe('runner step', () => {
    it("is the requesting user's own runner, and only once it has sent a heartbeat", async () => {
      stubEmpty();
      runnerRepo.count.mockResolvedValue(1);
      const state = await service.getState(ORG, USER);
      expect(state.steps.runner).toBe(true);
      const where = whereOf(runnerRepo.count);
      expect(where.organizationId).toBe(ORG);
      expect(where.ownerUserId).toBe(USER);
      // Not(IsNull()): a registration that never connected does not count.
      expect(where.lastHeartbeatAt.type).toBe('not');
      expect(where.lastHeartbeatAt.child?.type ?? where.lastHeartbeatAt.value?.type).toBe('isNull');
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

  describe('page intros (per-user)', () => {
    it('reports the intros this user closed, dropping names that are not topics', async () => {
      stubEmpty();
      userRepo.findOne.mockResolvedValue({
        preferences: { onboardingDismissedIntros: ['apis', 'nonsense', 'runners'] },
      });
      const state = await service.getState(ORG, USER);
      expect(state.dismissedIntros).toEqual(['apis', 'runners']);
    });

    it('is empty when nothing was closed', async () => {
      stubEmpty();
      const state = await service.getState(ORG, USER);
      expect(state.dismissedIntros).toEqual([]);
    });

    it('dismissIntro appends once and keeps other preferences', async () => {
      userRepo.findOne.mockResolvedValue({
        id: USER,
        preferences: { theme: 'dark', onboardingDismissedIntros: ['apis'] },
      });
      await service.dismissIntro(USER, 'tools');
      expect(userRepo.update).toHaveBeenLastCalledWith(
        { id: USER },
        { preferences: { theme: 'dark', onboardingDismissedIntros: ['apis', 'tools'] } },
      );
      await service.dismissIntro(USER, 'apis');
      expect(userRepo.update).toHaveBeenLastCalledWith(
        { id: USER },
        { preferences: { theme: 'dark', onboardingDismissedIntros: ['apis'] } },
      );
    });

    it('resetIntros brings them all back', async () => {
      userRepo.findOne.mockResolvedValue({
        id: USER,
        preferences: { onboardingDismissed: true, onboardingDismissedIntros: ['apis'] },
      });
      await service.resetIntros(USER);
      expect(userRepo.update).toHaveBeenCalledWith(
        { id: USER },
        { preferences: { onboardingDismissed: true, onboardingDismissedIntros: [] } },
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

    it('reads one row for the first successful call, not every log the org wrote', async () => {
      stubEmpty();
      const qbs: any[] = [];
      requestLogRepo.createQueryBuilder.mockImplementation(() => {
        const qb = makeQb({ count: 0, one: null });
        qbs.push(qb);
        return qb;
      });

      await service.getState(ORG, USER);

      // getOne() adds no LIMIT on its own; the ordered read must bound itself.
      const ordered = qbs.filter((qb) => qb.orderBy.mock.calls.length > 0);
      expect(ordered).toHaveLength(1);
      expect(ordered[0].limit).toHaveBeenCalledWith(1);
    });
  });

  /**
   * A step counts what the caller can see. Another member's private
   * provider, API, tool, gateway or agent must not tick a step or become
   * the guide's link, for org admins too: the tick would tell them it
   * exists. The visible set itself is AccessPolicyService's (and is
   * exercised against Postgres in onboarding-private.integration.spec).
   */
  describe('counts the caller\'s visible set', () => {
    it('asks the access policy for every private-capable count, with the right owner column', async () => {
      stubEmpty();
      await service.getState(ORG, USER);

      const calls = accessPolicy.visibleWhere.mock.calls.map((c: any[]) => ({
        user: c[0],
        org: c[1],
        owner: c[3]?.ownerColumn,
      }));
      expect(calls).toEqual(
        expect.arrayContaining([
          { user: { id: USER }, org: ORG, owner: 'ownerUserId' }, // provider, api
          { user: { id: USER }, org: ORG, owner: 'createdBy' }, // tools, agents
        ]),
      );
      // provider + api + tools + first agent + agent run
      expect(accessPolicy.visibleWhere).toHaveBeenCalledTimes(5);
      for (const repoCall of [providerRepo.count, apiRepo.count, toolRepo.count, agentRepo.count, agentRepo.findOne]) {
        expect(Array.isArray(repoCall.mock.calls[0][0].where)).toBe(true);
      }
    });

    it('filters both gateway reads through the list filter', async () => {
      stubEmpty();
      const log = { timestamp: new Date('2026-02-02T00:00:00Z') };
      requestLogRepo.createQueryBuilder.mockReturnValue(makeQb({ count: 0, one: log }));
      const gwQbs: any[] = [];
      gatewayRepo.createQueryBuilder.mockImplementation(() => {
        const qb = makeQb({ count: 1, one: null });
        gwQbs.push(qb);
        return qb;
      });

      await service.getState(ORG, USER);

      expect(gwQbs).toHaveLength(2); // gatewayWithTool + realActivationAt
      for (const qb of gwQbs) {
        expect(accessPolicy.applyListFilter).toHaveBeenCalledWith(qb, { id: USER }, ORG, 'gw', { ownerColumn: 'ownerUserId' });
      }
    });

    it('leaves traffic through another member\'s private gateway or tool out of the call steps', async () => {
      stubEmpty();
      const qbs: any[] = [];
      requestLogRepo.createQueryBuilder.mockImplementation(() => {
        const qb = makeQb({ count: 0, one: null });
        qbs.push(qb);
        return qb;
      });

      await service.getState(ORG, USER);

      expect(qbs).toHaveLength(2);
      for (const qb of qbs) {
        const privateClause = qb.andWhere.mock.calls.find((c: any[]) => String(c[0]).includes("visibility = 'private'"));
        expect(privateClause).toBeDefined();
        expect(privateClause[0]).toContain('FROM gateways');
        expect(privateClause[0]).toContain('FROM tools');
        expect(privateClause[1]).toEqual({ privateViewerId: USER });
      }
    });
  });
});
