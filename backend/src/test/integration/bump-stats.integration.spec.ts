/**
 * Real-Postgres integration spec for the atomic `bump*Stats` helpers
 * we introduced across agents, tools, LLM providers, and conversations.
 *
 * EVERY other spec in this repo mocks `createQueryBuilder()` and just
 * asserts the chain was called, which means a column-name typo, a bad
 * SQL fragment, a mismatched operator precedence, or an incompatible
 * column type would all pass the mocked tests and only surface at
 * runtime. This file closes that gap: it spins up a real Postgres
 * DataSource, `synchronize: true` to create the schema from the
 * entity decorators, seeds a row, calls the real helper, and reads
 * the row back to assert the post-update column values are what we
 * expect.
 *
 * Run locally against the docker-compose `postgres` service (port
 * 5433 with the default credentials) or any other reachable Postgres
 * via the standard `DATABASE_*` env vars. The suite is gated behind
 * `RUN_DB_INTEGRATION=1` so normal `npm test` runs (which would
 * otherwise flap in environments without a DB) stay mock-only.
 */
import { DataSource, Repository } from 'typeorm';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { LlmProvider, LlmProviderType, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { Conversation, ConversationStatus } from '../../entities/conversation.entity';
import { Organization } from '../../entities/organization.entity';

import { AgentExecutionEngine } from '../../modules/agents/agent-execution.engine';
import { AgentExecutionStateHelper } from '../../modules/agents/agent-execution-state.helper';
import { ToolExecutorService } from '../../modules/tools/tool-executor.service';
import { ToolStatsHelper } from '../../modules/tools/tool-stats.helper';
import { LlmProvidersService } from '../../modules/llm-providers/llm-providers.service';
import { LlmStatsHelper } from '../../modules/llm-providers/llm-stats.helper';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

// Smoke this quickly — these helpers are all small queries against a
// single row, nothing that needs multi-minute timeouts.
jest.setTimeout(30_000);

describeIfDb('bump*Stats helpers (real Postgres integration)', () => {
  let ds: DataSource;
  let orgId: string;

  beforeAll(async () => {
    // TypeORM's `dropSchema:true + synchronize:true` is "drop the named
    // schema then create tables in it", but synchronize tries to create
    // tables BEFORE the schema itself is recreated. On a fresh DB or
    // after a previous failed run that left the schema absent, this
    // explodes with `schema "bump_stats_test" does not exist`. Pre-
    // create it via a throwaway connection.
    const bootstrap = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres_test',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA IF NOT EXISTS bump_stats_test');
    await bootstrap.destroy();

    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres_test',
      password: process.env.DATABASE_PASSWORD || 'postgres',
      database: process.env.DATABASE_NAME || 'almyty_test',
      // Use a spec-specific Postgres schema so this spec can run
      // in parallel with other DB integration specs (e.g.
      // cross-tenant-isolation) without them stepping on each
      // other's DROP TABLE / CREATE TABLE cycles. TypeORM's
      // `synchronize + dropSchema` only affects the named schema.
      schema: 'bump_stats_test',
      synchronize: true,
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();

    // Every entity we touch has an FK to Organization, so seed one
    // and reuse its id across every test.
    const orgRepo = ds.getRepository(Organization);
    const org = orgRepo.create({
      name: 'bump-stats-integration',
      slug: 'bump-stats-integration',
      description: 'fixture',
      plan: 'free',
      isActive: true,
    });
    const saved = await orgRepo.save(org);
    orgId = saved.id;
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  // ── Agent.bumpAgentStats (via AgentExecutionEngine) ─────────────

  describe('AgentExecutionEngine.bumpAgentStats', () => {
    let agentRepo: Repository<Agent>;
    let engine: AgentExecutionEngine;

    beforeAll(() => {
      agentRepo = ds.getRepository(Agent);
      // Instantiate with only the repo we need — the bump helper
      // doesn't touch any other dependency. Cast everything else
      // to `as any` to bypass the constructor type-check.
      engine = new AgentExecutionEngine(
        agentRepo,
        {} as any, // agentExecutionRepository
        {} as any, // nodeExecutor
        {} as any, // webhookService
        new AgentExecutionStateHelper(agentRepo, {} as any),
      );
    });

    it('increments usageCount, updates averages, and sets lastExecutedAt on success', async () => {
      const agent = await agentRepo.save({
        name: 'fixture-agent',
        organizationId: orgId,
        
        status: AgentStatus.ACTIVE,
        pipeline: { nodes: [], edges: [] } as any,
      } as any) as Agent;

      await (engine as any).state.bumpAgentStats(agent.id, true, 1000, 0.05);

      const after = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(after.totalExecutions).toBe(1);
      expect(after.successfulExecutions).toBe(1);
      expect(Number(after.totalCost)).toBeCloseTo(0.05, 4);
      expect(after.averageExecutionTime).toBe(1000);
      expect(after.lastExecutedAt).toBeInstanceOf(Date);
    });

    it('increments totalExecutions but not successfulExecutions on failure', async () => {
      const agent = await agentRepo.save({
          name: 'fixture-agent-fail',
          organizationId: orgId,
          
          status: AgentStatus.ACTIVE,
          pipeline: { nodes: [], edges: [] } as any,
        } as any) as Agent;

      await (engine as any).state.bumpAgentStats(agent.id, false, 500, 0.02);

      const after = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(after.totalExecutions).toBe(1);
      expect(after.successfulExecutions).toBe(0);
      expect(Number(after.totalCost)).toBeCloseTo(0.02, 4);
    });

    it('computes a running average over two sequential executions', async () => {
      const agent = await agentRepo.save({
          name: 'fixture-agent-avg',
          organizationId: orgId,
          
          status: AgentStatus.ACTIVE,
          pipeline: { nodes: [], edges: [] } as any,
        } as any) as Agent;

      // First: 1000ms. Post-update running average should be 1000.
      await (engine as any).state.bumpAgentStats(agent.id, true, 1000, 0);
      // Second: 2000ms. The new_avg = old_avg + (x - old_avg) /
      // new_count = 1000 + (2000 - 1000) / 2 = 1500.
      await (engine as any).state.bumpAgentStats(agent.id, true, 2000, 0);

      const after = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(after.totalExecutions).toBe(2);
      expect(after.averageExecutionTime).toBe(1500);
    });

    it('is atomic under concurrent calls (no lost increment)', async () => {
      // The whole point of the refactor. Fire 50 concurrent bumps;
      // the final totalExecutions must be exactly 50.
      const agent = await agentRepo.save({
          name: 'fixture-agent-race',
          organizationId: orgId,
          
          status: AgentStatus.ACTIVE,
          pipeline: { nodes: [], edges: [] } as any,
        } as any) as Agent;

      await Promise.all(
        Array.from({ length: 50 }, () =>
          (engine as any).state.bumpAgentStats(agent.id, true, 100, 0.001),
        ),
      );

      const after = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(after.totalExecutions).toBe(50);
      expect(after.successfulExecutions).toBe(50);
      expect(Number(after.totalCost)).toBeCloseTo(0.05, 4);
    });
  });

  // ── ToolExecutorService.bumpToolStats ───────────────────────────

  describe('ToolExecutorService.bumpToolStats', () => {
    let toolRepo: Repository<Tool>;
    let executor: ToolExecutorService;

    beforeAll(() => {
      toolRepo = ds.getRepository(Tool);
      executor = new ToolExecutorService(
        toolRepo,
        {} as any, // toolExecutionRepository
        {} as any, // userRepository
        {} as any, // redis
        {} as any, // httpExecutor
        {} as any, // protocolExecutor
        {} as any, // scriptExecutor
        {} as any, // auditLogService
        {} as any, // cacheRateLimit
        new ToolStatsHelper(toolRepo, {} as any, {} as any),
        {} as any, // runnerCalls
        {} as any, // memoryService
        {} as any, // mcpSources
      );
    });

    it('increments usageCount, updates averageResponseTime, and bumps successRate on success', async () => {
      const tool = await toolRepo.save({
          name: 'fixture-tool',
          organizationId: orgId,
          type: ToolType.API,
          status: ToolStatus.ACTIVE,
          parameters: { type: 'object', properties: {} } as any,
        } as any) as Tool;

      await (executor as any).stats.bumpToolStats(tool.id, true, 250);

      const after = await toolRepo.findOneByOrFail({ id: tool.id });
      expect(after.usageCount).toBe(1);
      expect(after.averageResponseTime).toBe(250);
      // successRate EMA: 0 + (100 - 0) * 0.1 = 10
      expect(Number(after.successRate)).toBeCloseTo(10, 5);
      expect(after.lastUsedAt).toBeInstanceOf(Date);
    });

    it('decays successRate on failure via the EMA formula', async () => {
      const tool = await toolRepo.save({
          name: 'fixture-tool-decay',
          organizationId: orgId,
          type: ToolType.API,
          status: ToolStatus.ACTIVE,
          parameters: { type: 'object', properties: {} } as any,
          successRate: 50, // seed to a non-zero rate so decay is observable
        } as any) as Tool;

      await (executor as any).stats.bumpToolStats(tool.id, false, 500);

      const after = await toolRepo.findOneByOrFail({ id: tool.id });
      expect(after.usageCount).toBe(1);
      // successRate decay: max(0, 50 * 0.9) = 45
      expect(Number(after.successRate)).toBeCloseTo(45, 5);
    });

    it('handles the zero-count branch of the running average (first call)', async () => {
      const tool = await toolRepo.save({
          name: 'fixture-tool-first',
          organizationId: orgId,
          type: ToolType.API,
          status: ToolStatus.ACTIVE,
          parameters: { type: 'object', properties: {} } as any,
        } as any) as Tool;

      await (executor as any).stats.bumpToolStats(tool.id, true, 777);
      const after = await toolRepo.findOneByOrFail({ id: tool.id });
      expect(after.averageResponseTime).toBe(777);
    });

    it('computes an incremental running average across 3 sequential calls', async () => {
      const tool = await toolRepo.save({
          name: 'fixture-tool-avg',
          organizationId: orgId,
          type: ToolType.API,
          status: ToolStatus.ACTIVE,
          parameters: { type: 'object', properties: {} } as any,
        } as any) as Tool;

      // Sequential: 100, 200, 300. Running averages: 100, 150, 200.
      await (executor as any).stats.bumpToolStats(tool.id, true, 100);
      await (executor as any).stats.bumpToolStats(tool.id, true, 200);
      await (executor as any).stats.bumpToolStats(tool.id, true, 300);

      const after = await toolRepo.findOneByOrFail({ id: tool.id });
      expect(after.usageCount).toBe(3);
      expect(after.averageResponseTime).toBe(200);
    });

    it('is atomic under concurrent calls', async () => {
      const tool = await toolRepo.save({
          name: 'fixture-tool-race',
          organizationId: orgId,
          type: ToolType.API,
          status: ToolStatus.ACTIVE,
          parameters: { type: 'object', properties: {} } as any,
        } as any) as Tool;

      await Promise.all(
        Array.from({ length: 50 }, () =>
          (executor as any).stats.bumpToolStats(tool.id, true, 100),
        ),
      );

      const after = await toolRepo.findOneByOrFail({ id: tool.id });
      expect(after.usageCount).toBe(50);
    });
  });

  // ── LlmProvidersService.bumpSessionStats + bumpProviderStats ────

  describe('LlmProvidersService bump helpers', () => {
    let conversationRepo: Repository<Conversation>;
    let providerRepo: Repository<LlmProvider>;
    let service: LlmProvidersService;

    beforeAll(() => {
      conversationRepo = ds.getRepository(Conversation);
      providerRepo = ds.getRepository(LlmProvider);
      service = new LlmProvidersService(
        providerRepo,
        conversationRepo,
        {} as any, // messageRepository
        {} as any, // userRepository
        {} as any, // organizationRepository
        {} as any, // gatewayRepository
        {} as any, // toolRepository
        {} as any, // toolExecutorService
        {} as any, // auditLogService
        {} as any, // modelsHelper
        {} as any, // chatHelper
        new LlmStatsHelper(conversationRepo, providerRepo),
        {} as any, // runner
        { canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }) } as any, // accessPolicy
      );
    });

    it('bumpSessionStats increments every counter atomically', async () => {
      const provider = await providerRepo.save({
          name: 'fixture-provider',
          organizationId: orgId,
          type: LlmProviderType.OPENAI,
          status: LlmProviderStatus.ACTIVE,
          configuration: {} as any,
        } as any) as LlmProvider;
      const session = await conversationRepo.save({
          providerId: provider.id,
          organizationId: orgId,
          status: ConversationStatus.ACTIVE,
          title: 'fixture-session',
        } as any) as Conversation;

      await (service as any).bumpSessionStats(session.id, {
        inputTokens: 100,
        outputTokens: 50,
        cost: 25,
        toolCall: true,
        toolCallSuccess: true,
      });

      const after = await conversationRepo.findOneByOrFail({ id: session.id });
      expect(after.messageCount).toBe(1);
      expect(after.totalInputTokens).toBe(100);
      expect(after.totalOutputTokens).toBe(50);
      expect(Number(after.totalCost)).toBeCloseTo(25, 5);
      expect(after.toolCalls).toBe(1);
      expect(after.successfulToolCalls).toBe(1);
      expect(after.lastActivityAt).toBeInstanceOf(Date);
    });

    it('bumpSessionStats skips tool-call counters when toolCall is false', async () => {
      const provider = await providerRepo.save({
          name: 'fixture-provider-b',
          organizationId: orgId,
          type: LlmProviderType.OPENAI,
          status: LlmProviderStatus.ACTIVE,
          configuration: {} as any,
        } as any) as LlmProvider;
      const session = await conversationRepo.save({
          providerId: provider.id,
          organizationId: orgId,
          status: ConversationStatus.ACTIVE,
          title: 'fixture-session-no-tool',
        } as any) as Conversation;

      await (service as any).bumpSessionStats(session.id, {
        inputTokens: 10,
        outputTokens: 5,
        cost: 1,
        toolCall: false,
        toolCallSuccess: false,
      });

      const after = await conversationRepo.findOneByOrFail({ id: session.id });
      expect(after.messageCount).toBe(1);
      expect(after.toolCalls).toBe(0);
      expect(after.successfulToolCalls).toBe(0);
    });

    it('bumpProviderStats increments totalRequests + successfulRequests on success', async () => {
      const provider = await providerRepo.save({
          name: 'fixture-provider-success',
          organizationId: orgId,
          type: LlmProviderType.OPENAI,
          status: LlmProviderStatus.ACTIVE,
          configuration: {} as any,
        } as any) as LlmProvider;

      await (service as any).bumpProviderStats(provider.id, {
        tokens: 500,
        cost: 12,
        success: true,
      });

      const after = await providerRepo.findOneByOrFail({ id: provider.id });
      expect(after.totalRequests).toBe(1);
      expect(after.successfulRequests).toBe(1);
      expect(after.totalTokensUsed).toBe(500);
      expect(Number(after.totalCost)).toBeCloseTo(12, 5);
      expect(after.lastRequestAt).toBeInstanceOf(Date);
    });

    it('bumpProviderStats increments totalRequests but not successfulRequests on failure', async () => {
      const provider = await providerRepo.save({
          name: 'fixture-provider-failure',
          organizationId: orgId,
          type: LlmProviderType.OPENAI,
          status: LlmProviderStatus.ACTIVE,
          configuration: {} as any,
        } as any) as LlmProvider;

      await (service as any).bumpProviderStats(provider.id, {
        tokens: 0,
        cost: 0,
        success: false,
      });

      const after = await providerRepo.findOneByOrFail({ id: provider.id });
      expect(after.totalRequests).toBe(1);
      expect(after.successfulRequests).toBe(0);
    });

    it('bumpSessionStats is atomic under concurrent load', async () => {
      const provider = await providerRepo.save({
          name: 'fixture-provider-race',
          organizationId: orgId,
          type: LlmProviderType.OPENAI,
          status: LlmProviderStatus.ACTIVE,
          configuration: {} as any,
        } as any) as LlmProvider;
      const session = await conversationRepo.save({
          providerId: provider.id,
          organizationId: orgId,
          status: ConversationStatus.ACTIVE,
          title: 'fixture-session-race',
        } as any) as Conversation;

      await Promise.all(
        Array.from({ length: 50 }, () =>
          (service as any).bumpSessionStats(session.id, {
            inputTokens: 2,
            outputTokens: 1,
            cost: 1,
            toolCall: false,
            toolCallSuccess: false,
          }),
        ),
      );

      const after = await conversationRepo.findOneByOrFail({ id: session.id });
      expect(after.messageCount).toBe(50);
      expect(after.totalInputTokens).toBe(100);
      expect(after.totalOutputTokens).toBe(50);
      expect(Number(after.totalCost)).toBeCloseTo(50, 5);
    });

    it('bumpProviderStats is atomic under concurrent load', async () => {
      const provider = await providerRepo.save({
          name: 'fixture-provider-race-2',
          organizationId: orgId,
          type: LlmProviderType.OPENAI,
          status: LlmProviderStatus.ACTIVE,
          configuration: {} as any,
        } as any) as LlmProvider;

      await Promise.all(
        Array.from({ length: 50 }, () =>
          (service as any).bumpProviderStats(provider.id, {
            tokens: 10,
            cost: 1,
            success: true,
          }),
        ),
      );

      const after = await providerRepo.findOneByOrFail({ id: provider.id });
      expect(after.totalRequests).toBe(50);
      expect(after.successfulRequests).toBe(50);
      expect(after.totalTokensUsed).toBe(500);
      expect(Number(after.totalCost)).toBeCloseTo(50, 5);
    });
  });
});
