import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { Agent } from '../../../entities/agent.entity';
import { Strategy } from '../../../entities/strategy.entity';
import { AgentRole } from '../../../entities/agent-role.entity';
import { AgentExecutionSettingsController } from '../agent-execution-settings.controller';
import { StrategyPipelineResolver } from '../strategies/strategy-pipeline.resolver';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';

/**
 * The Execution tab's choices, over the wire.
 *
 * This exists because the tab shipped with the strategy and the
 * orchestrator held in component state and nothing behind them: both were
 * forgotten on leaving the tab, while the UI read as configured. Every
 * test at the time passed, because they rendered the components with
 * props. Only a round trip shows whether a choice survives.
 */
describe('agent execution settings', () => {
  let app: INestApplication;
  let agent: Partial<Agent>;
  const strategyRows = { count: jest.fn().mockResolvedValue(0), find: jest.fn().mockResolvedValue([]) };
  const roleRows = { find: jest.fn().mockResolvedValue([]) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentExecutionSettingsController],
      providers: [
        {
          provide: getRepositoryToken(Agent),
          useValue: {
            // Honours organizationId, so the cross-tenant case proves the
            // controller scopes the query rather than proving the mock does.
            findOne: jest.fn(async ({ where }: any) =>
              where.id === agent.id && where.organizationId === agent.organizationId ? agent : null,
            ),
            save: jest.fn(async (row: any) => Object.assign(agent, row)),
          },
        },
        { provide: getRepositoryToken(Strategy), useValue: strategyRows },
        { provide: getRepositoryToken(AgentRole), useValue: roleRows },
        // The real resolver, so ejecting exercises the actual compiler
        // rather than a stub that always returns a graph.
        StrategyPipelineResolver,
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

  const id = '3f1b6a24-6c1e-4f77-9a1a-0f2f0a1d9c11';
  beforeEach(() => {
    agent = { id, organizationId: 'org-1', settings: undefined as any };
    strategyRows.count.mockResolvedValue(0);
    strategyRows.find.mockResolvedValue([]);
    roleRows.find.mockResolvedValue([]);
  });

  const put = (body: unknown) => request(app.getHttpServer()).put(`/agents/${id}/execution`).send(body as object);
  const get = () => request(app.getHttpServer()).get(`/agents/${id}/execution`);

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
    strategyRows.count.mockResolvedValue(1);
    await put({ strategyKey: 'house_style' }).expect(200);
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
    agent.settings = { somethingElse: 'kept' } as any;
    await put({ strategyKey: 'single' }).expect(200);
    expect((agent.settings as any).somethingElse).toBe('kept');
  });

  it('does not serve another organization an agent', async () => {
    agent.organizationId = 'someone-else';
    await get().expect(404);
  });

  /**
   * An autonomous agent runs the ReAct loop, not a compiled pipeline, and
   * that loop never reads settings.execution. A strategy saved on one
   * looked configured and did nothing, so it is refused at the door.
   */
  it('refuses a strategy on an autonomous agent, which would ignore it', async () => {
    agent.mode = 'autonomous' as any;
    const { body } = await put({ strategyKey: 'cascade' }).expect(400);
    expect(body.code).toBe('STRATEGY_WORKFLOW_ONLY');
    expect(agent.settings).toBeUndefined();
  });

  it('refuses turning the orchestrator on for an autonomous agent', async () => {
    agent.mode = 'autonomous' as any;
    const { body } = await put({
      orchestrator: { enabled: true, roleKey: 'orchestrator', timeoutMs: 2000, fallbackStrategyKey: 'single' },
    }).expect(400);
    expect(body.code).toBe('STRATEGY_WORKFLOW_ONLY');
  });

  it('still lets an autonomous agent shed a leftover strategy', async () => {
    agent.mode = 'autonomous' as any;
    agent.settings = { execution: { strategyKey: 'cascade' } } as any;
    await put({ strategyKey: null }).expect(200);
    expect((agent.settings as any).execution.strategyKey).toBeNull();
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
    const eject = () => request(app.getHttpServer()).post(`/agents/${id}/execution/eject`).send({});

    it('compiles the chosen strategy onto the agent and clears the strategy', async () => {
      agent.settings = { execution: { strategyKey: 'single' } } as any;
      roleRows.find.mockResolvedValue([{ key: 'principal' }]);

      const { body } = await eject().expect(201);

      expect(body.data.pipeline.nodes.length).toBeGreaterThan(0);
      expect(body.data.execution.strategyKey).toBeNull();
      expect(agent.pipeline?.nodes?.length).toBeGreaterThan(0);
    });

    it('names a role on each compiled node, never a model', async () => {
      agent.settings = { execution: { strategyKey: 'single' } } as any;
      roleRows.find.mockResolvedValue([{ key: 'principal' }]);

      const { body } = await eject().expect(201);

      const llmNodes = body.data.pipeline.nodes.filter((n: any) => n.type === 'llm_call');
      expect(llmNodes.length).toBeGreaterThan(0);
      for (const node of llmNodes) {
        expect(node.data?.modelId ?? null).toBeNull();
      }
    });

    it('refuses to overwrite a graph somebody drew by hand', async () => {
      agent.settings = { execution: { strategyKey: 'single' } } as any;
      agent.pipeline = { nodes: [{ id: 'mine', type: 'input' }], edges: [] } as any;

      const { body } = await eject().expect(409);

      expect(body.code).toBe('PIPELINE_NOT_EMPTY');
    });

    it('says so when the agent runs no strategy at all', async () => {
      const { body } = await eject().expect(400);
      expect(body.code).toBe('STRATEGY_NOT_COMPILABLE');
      expect(body.message).toMatch(/nothing to eject/i);
    });

    it('says which roles are missing rather than compiling a broken graph', async () => {
      agent.settings = { execution: { strategyKey: 'cascade' } } as any;
      roleRows.find.mockResolvedValue([]);

      const { body } = await eject().expect(400);

      expect(body.code).toBe('STRATEGY_NOT_COMPILABLE');
      expect(body.message).toMatch(/not bound/i);
    });

    it('does not eject another organization\'s agent', async () => {
      agent.organizationId = 'someone-else';
      await eject().expect(404);
    });
  });
});
