import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';

import { Agent } from '../../../entities/agent.entity';
import { Strategy } from '../../../entities/strategy.entity';
import { AgentRole } from '../../../entities/agent-role.entity';
import { AgentExecutionSettingsController } from '../agent-execution-settings.controller';
import { StrategyPipelineResolver } from '../strategies/strategy-pipeline.resolver';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { fakeRepository, FakeRepository } from '../../../test/fake-repository';

/**
 * The Execution tab's choices, over the wire.
 *
 * This exists because the tab shipped with the strategy and the
 * orchestrator held in component state and nothing behind them: both were
 * forgotten on leaving the tab, while the UI read as configured. Every
 * test at the time passed, because they rendered the components with
 * props. Only a round trip shows whether a choice survives.
 *
 * Why it is built the way it is (it used to flake):
 *
 *  - Every test gets its own organization and agent id. The repository
 *    double used to hand back one module-level `agent` object, read at
 *    call time, and supertest was given the unlistened server, so each
 *    request listened on a fresh port and closed the server behind it.
 *    When one test ran past jest's 5s budget on a loaded machine, jest
 *    moved on while its request was still in flight: the late request
 *    then read and wrote the NEXT test's agent (a refusal answered 200)
 *    or closed the server under the next test's request (ECONNRESET).
 *    A stale request now names an agent and an organization no later
 *    test uses, so it cannot touch anything another test looks at.
 *  - The app listens once, on 127.0.0.1, for the whole file. No request
 *    opens or closes the server, and binding the loopback address (not
 *    the wildcard) means no other process on the host can hold the same
 *    127.0.0.1 port and answer requests meant for this app.
 *  - Booting the Nest app gets its own budget: under a full parallel run
 *    it can take longer than a unit test's 5s.
 */
describe('agent execution settings', () => {
  let app: INestApplication;
  let baseUrl: string;

  const agents: FakeRepository<Agent> = fakeRepository<Agent>({ make: () => new Agent() });
  const strategies: FakeRepository<Strategy> = fakeRepository<Strategy>({ idPrefix: 'strategy' });
  const roles: FakeRepository<AgentRole> = fakeRepository<AgentRole>({ idPrefix: 'role' });

  // The caller's organization, per test (see above).
  let orgId: string;
  let id: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentExecutionSettingsController],
      providers: [
        { provide: getRepositoryToken(Agent), useValue: agents },
        { provide: getRepositoryToken(Strategy), useValue: strategies },
        { provide: getRepositoryToken(AgentRole), useValue: roles },
        // The real resolver, so ejecting exercises the actual compiler
        // rather than a stub that always returns a graph.
        StrategyPipelineResolver,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { currentOrganizationId: orgId };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;

    // Warm the request path once, inside this hook's budget. The first
    // GET and the first validated PUT pay one-time costs (route and
    // validation setup, first-use module loading); under a loaded full run
    // those alone took the first two tests past jest's 5s. Charged here,
    // no test's outcome depends on being first.
    orgId = 'org-warmup';
    id = randomUUID();
    agents.seed({ id, organizationId: orgId });
    await request(baseUrl).get(`/agents/${id}/execution`).expect(200);
    await request(baseUrl).put(`/agents/${id}/execution`).send({ strategyKey: 'single' }).expect(200);
    await request(baseUrl).post(`/agents/${id}/execution/eject`).send({});
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  /** A fresh agent in a fresh organization, as the table holds it. */
  const seedAgent = (overrides: Partial<Agent> = {}) =>
    agents.seed({ id, organizationId: orgId, settings: undefined as any, ...overrides });
  /** The agent as the table holds it now. */
  const stored = () => agents.row(id)!;

  beforeEach(() => {
    orgId = `org-${randomUUID()}`;
    id = randomUUID();
    seedAgent();
  });

  const put = (body: unknown) => request(baseUrl).put(`/agents/${id}/execution`).send(body as object);
  const get = () => request(baseUrl).get(`/agents/${id}/execution`);

  it('has nothing to say about an agent that has chosen nothing', async () => {
    await get().expect(200).expect({ success: true, data: {} });
  });

  it('remembers a chosen strategy, which is the whole point', async () => {
    await put({ strategyKey: 'cascade' }).expect(200);
    const { body } = await get().expect(200);
    expect(body.data.strategyKey).toBe('cascade');
  });

  it('remembers the orchestrator settings too', async () => {
    const orchestrator = { enabled: true, roleKey: 'orchestrator', timeoutMs: 1500, fallbackStrategyKey: 'single' };
    await put({ orchestrator }).expect(200);
    const { body } = await get().expect(200);
    expect(body.data.orchestrator).toMatchObject(orchestrator);
  });

  it('changes one without clearing the other', async () => {
    await put({ strategyKey: 'panel' }).expect(200);
    await put({ orchestrator: { enabled: true, roleKey: 'orchestrator', timeoutMs: 2000, fallbackStrategyKey: 'single' } }).expect(200);
    const { body } = await get().expect(200);
    expect(body.data.strategyKey).toBe('panel');
    expect(body.data.orchestrator.enabled).toBe(true);
  });

  it('refuses a strategy that names nothing, rather than failing at run time', async () => {
    const { body } = await put({ strategyKey: 'does_not_exist' }).expect(400);
    expect(body.error).toBe('STRATEGY_NOT_FOUND');
    expect(body.message).toContain('does_not_exist');
  });

  it("accepts an organization's own strategy, not only the built-ins", async () => {
    strategies.seed({ key: 'house_style', organizationId: orgId } as Partial<Strategy>);
    await put({ strategyKey: 'house_style' }).expect(200);
  });

  it("does not accept another organization's own strategy", async () => {
    strategies.seed({ key: 'their_style', organizationId: `org-${randomUUID()}` } as Partial<Strategy>);
    await put({ strategyKey: 'their_style' }).expect(400);
  });

  it('clears the strategy when asked, back to a plain pipeline', async () => {
    await put({ strategyKey: 'cascade' }).expect(200);
    await put({ strategyKey: null }).expect(200);
    const { body } = await get().expect(200);
    expect(body.data.strategyKey).toBeNull();
  });

  it('refuses a timeout nobody could mean', async () => {
    await put({ orchestrator: { enabled: true, roleKey: 'o', timeoutMs: 5, fallbackStrategyKey: 'single' } }).expect(400);
  });

  it('leaves the rest of the agent settings alone', async () => {
    seedAgent({ settings: { somethingElse: 'kept' } as any });
    await put({ strategyKey: 'single' }).expect(200);
    expect((stored().settings as any).somethingElse).toBe('kept');
  });

  it('does not serve another organization an agent', async () => {
    seedAgent({ organizationId: 'someone-else' });
    await get().expect(404);
  });

  /**
   * An autonomous agent runs the ReAct loop, not a compiled pipeline, and
   * that loop never reads settings.execution. A strategy saved on one
   * looked configured and did nothing, so it is refused at the door.
   */
  it('refuses a strategy on an autonomous agent, which would ignore it', async () => {
    seedAgent({ mode: 'autonomous' });
    const { body } = await put({ strategyKey: 'cascade' }).expect(400);
    expect(body.code).toBe('STRATEGY_WORKFLOW_ONLY');
    expect(stored().settings).toBeUndefined();
  });

  it('refuses turning the orchestrator on for an autonomous agent', async () => {
    seedAgent({ mode: 'autonomous' });
    const { body } = await put({
      orchestrator: { enabled: true, roleKey: 'orchestrator', timeoutMs: 2000, fallbackStrategyKey: 'single' },
    }).expect(400);
    expect(body.code).toBe('STRATEGY_WORKFLOW_ONLY');
  });

  it('still lets an autonomous agent shed a leftover strategy', async () => {
    seedAgent({ mode: 'autonomous', settings: { execution: { strategyKey: 'cascade' } } as any });
    await put({ strategyKey: null }).expect(200);
    expect((stored().settings as any).execution.strategyKey).toBeNull();
  });
  /**
   * Ejecting: the strategy becomes the agent's own graph, and stops being
   * a strategy.
   *
   * The button for this shipped in the Execution tab behind an optional
   * prop nobody passed, because there was no endpoint to call. The
   * compiler that produces the graph had no caller outside its own tests.
   */
  describe('eject', () => {
    const eject = () => request(baseUrl).post(`/agents/${id}/execution/eject`).send({});
    const bindRole = (key: string) => roles.seed({ key, organizationId: orgId, agentId: id } as Partial<AgentRole>);

    it('compiles the chosen strategy onto the agent and clears the strategy', async () => {
      seedAgent({ settings: { execution: { strategyKey: 'single' } } as any });
      bindRole('principal');

      const { body } = await eject().expect(201);

      expect(body.data.pipeline.nodes.length).toBeGreaterThan(0);
      expect(body.data.execution.strategyKey).toBeNull();
      expect(stored().pipeline?.nodes?.length).toBeGreaterThan(0);
    });

    it('names a role on each compiled node, never a model', async () => {
      seedAgent({ settings: { execution: { strategyKey: 'single' } } as any });
      bindRole('principal');

      const { body } = await eject().expect(201);

      const llmNodes = body.data.pipeline.nodes.filter((n: any) => n.type === 'llm_call');
      expect(llmNodes.length).toBeGreaterThan(0);
      for (const node of llmNodes) {
        expect(node.data?.modelId ?? null).toBeNull();
      }
    });

    it('refuses to overwrite a graph somebody drew by hand', async () => {
      seedAgent({
        settings: { execution: { strategyKey: 'single' } } as any,
        pipeline: { nodes: [{ id: 'mine', type: 'input' }], edges: [] } as any,
      });

      const { body } = await eject().expect(409);

      expect(body.code).toBe('PIPELINE_NOT_EMPTY');
    });

    it('says so when the agent runs no strategy at all', async () => {
      const { body } = await eject().expect(400);
      expect(body.code).toBe('STRATEGY_NOT_COMPILABLE');
      expect(body.message).toMatch(/nothing to eject/i);
    });

    it('says which roles are missing rather than compiling a broken graph', async () => {
      seedAgent({ settings: { execution: { strategyKey: 'cascade' } } as any });

      const { body } = await eject().expect(400);

      expect(body.code).toBe('STRATEGY_NOT_COMPILABLE');
      expect(body.message).toMatch(/not bound/i);
    });

    it('does not eject another organization\'s agent', async () => {
      seedAgent({ organizationId: 'someone-else' });
      await eject().expect(404);
    });
  });
});
