import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { Agent } from '../../../entities/agent.entity';
import { Strategy } from '../../../entities/strategy.entity';
import { AgentExecutionSettingsController } from '../agent-execution-settings.controller';
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
  const strategyRows = { count: jest.fn().mockResolvedValue(0) };

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
});
