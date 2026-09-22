import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { AlmytyMcpService } from '../almyty-mcp.service';
import { ApisService } from '../../apis/apis.service';
import { ToolsService } from '../../tools/tools.service';
import { GatewaysService } from '../../gateways/gateways.service';
import { AgentsService } from '../../agents/agents.service';
import { AgentExecutionEngine } from '../../agents/agent-execution.engine';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { AgentAppsService } from '../../agent-apps/agent-apps.service';
import { AppBuildsService } from '../../agent-apps/app-builds.service';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { CanonicalMemoryService } from '../../memory/canonical/canonical-memory.service';
import { ConsolidationService } from '../../memory/canonical/consolidation.service';
import { MemoryRouter } from '../../memory/canonical/memory-router.service';
import { MemorySyncService } from '../../memory/canonical/memory-sync.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ModelCatalogService } from '../../model-catalog/model-catalog.service';
import { ModelRouterService } from '../../model-catalog/routing/model-router.service';
import { ModelDeploymentsService } from '../../model-deployments/model-deployments.service';
import { ModelVersionsService } from '../../model-registry/model-versions.service';
import { AgentExecution } from '../../../entities/agent-execution.entity';
import { ConnectionsService } from '../../connections/connections.service';
import { GrantsService } from '../../connections/grants/grants.service';
import { CredentialsService } from '../../credentials/credentials.service';
import { UsersService } from '../../users/users.service';
import { RunnerService } from '../../runner/runner.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import { BudgetsService } from '../../budgets/budgets.service';
import { SpendService } from '../../budgets/spend.service';
import { AnalyticsService } from '../../monitoring/analytics.service';
import { MonitoringService } from '../../monitoring/monitoring.service';
import { ToolHubService } from '../../tool-hub/tool-hub.service';
import { ApprovalsService } from '../../approvals/approvals.service';

// Mock axios for import_schema URL fetching
const mockAxiosGet = jest.fn().mockResolvedValue({ data: '{"openapi":"3.0.0","info":{"title":"Test","version":"1.0"},"paths":{}}' });
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...args: any[]) => mockAxiosGet(...args) },
  get: (...args: any[]) => mockAxiosGet(...args),
}));

describe('AlmytyMcpService', () => {
  let service: AlmytyMcpService;

  const mockApisService: any = {
    findAllByOrganization: jest.fn().mockResolvedValue({ apis: [], total: 0 }),
    create: jest.fn().mockResolvedValue({ id: 'api-1', name: 'Test' }),
    importSchema: jest.fn().mockResolvedValue({ api: {}, schema: {}, operations: [], resources: [], tools: [] }),
    fetchSchemaFromUrl: jest.fn().mockResolvedValue('{"openapi":"3.0.0"}'),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const mockToolsService: any = {
    getTools: jest.fn().mockResolvedValue({ tools: [], total: 0 }),
    deleteTool: jest.fn().mockResolvedValue(undefined),
    activateTool: jest.fn().mockResolvedValue({ id: 'tool-1', name: 'one', status: 'active' }),
  };
  const mockGatewaysService: any = {
    getGateways: jest.fn().mockResolvedValue({ gateways: [], total: 0 }),
    createGateway: jest.fn().mockResolvedValue({ id: 'gw-1' }),
    deleteGateway: jest.fn().mockResolvedValue(undefined),
  };
  const mockAgentsService: any = {
    getAgents: jest.fn().mockResolvedValue({ agents: [], total: 0 }),
    createAgent: jest.fn().mockResolvedValue({ id: 'agent-1' }),
    getAgent: jest.fn().mockResolvedValue({ id: 'agent-1', name: 'Flow', mode: 'workflow', status: 'active' }),
    updateAgent: jest.fn().mockResolvedValue({ id: 'agent-1', name: 'Flow', mode: 'workflow', status: 'draft' }),
    deleteAgent: jest.fn().mockResolvedValue(undefined),
    activateAgent: jest.fn().mockResolvedValue({ id: 'agent-1', name: 'Flow', mode: 'workflow', status: 'active' }),
    deactivateAgent: jest.fn().mockResolvedValue({ id: 'agent-1', name: 'Flow', mode: 'workflow', status: 'inactive' }),
  };
  const mockExecutionEngine: any = {
    execute: jest.fn().mockResolvedValue({
      id: 'exec-1', status: 'completed', output: { answer: 42 }, error: null,
      nodeResults: {}, executionTime: 12, totalCost: 0, totalTokens: 7,
    }),
  };
  const mockRuntimeService: any = {
    startRun: jest.fn().mockResolvedValue({ id: 'run-1', status: 'running' }),
  };
  const mockLlmProvidersService = { getProviders: jest.fn().mockResolvedValue([]), createProvider: jest.fn().mockResolvedValue({ id: 'prov-1' }) };
  const mockSchemaImportQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
  const mockGatewayAuthService = { createGatewayAuth: jest.fn().mockResolvedValue({ id: 'auth-1', type: 'oauth2' }), deleteGatewayAuth: jest.fn().mockResolvedValue(undefined) };
  const mockGatewayToolService = { bulkAssociateTools: jest.fn().mockResolvedValue({ associated: [], skipped: [] }) };
  const mockMemoryService: any = {
    put: jest.fn().mockResolvedValue({
      id: 'mem-1', mode: 'memory', tier: 'short',
      embedding_status: 'pending', content_bytes: 11,
    }),
    search: jest.fn().mockResolvedValue([
      { item: { id: 'mem-1', content: 'hello', tier: 'short', tags: [], mode: 'memory' }, score: 0.9, signal: 'hybrid' },
    ]),
    list: jest.fn().mockResolvedValue({ items: [], total: 0, cursor: null }),
    get: jest.fn().mockResolvedValue({ id: 'mem-1', content: 'hello', mode: 'memory', scope_type: 'workspace', tier: 'short' }),
    delete: jest.fn().mockResolvedValue(true),
    supersede: jest.fn().mockResolvedValue({
      old: { id: 'mem-1', valid_until: new Date('2026-01-01') },
      new: { id: 'mem-2' },
    }),
  };
  const mockConsolidation: any = {
    run: jest.fn().mockResolvedValue({
      scope: { scope_type: 'workspace', scope_id: 'org-1' },
      scanned: 5, consolidated_facts: 2, superseded: 5, skipped: false,
    }),
  };
  const mockRouter: any = {
    transfer: jest.fn().mockResolvedValue({
      source: 'almyty-native', target: 'mem0',
      total_source: 5, succeeded: 5, failed: 0, warnings: [], errors: [],
    }),
    list_backends: jest.fn().mockReturnValue([
      { id: 'almyty-native', capabilities: ['vector_search'], modes: ['memory'] },
    ]),
    healthAll: jest.fn().mockResolvedValue({ 'almyty-native': { ok: true, latency_ms: 1 } }),
  };
  const mockMemorySync: any = {
    sync: jest.fn().mockResolvedValue({
      scope: { scope_type: 'workspace', scope_id: 'org-1' },
      primary: 'almyty-native', mirror: 'mem0',
      to_mirror: 1, to_primary: 0, reconciled: 0, errors: [], skipped: false,
    }),
  };

  const mockAgentAppsService: any = {
    list: jest.fn().mockResolvedValue([
      { slug: 'acme', name: 'Acme', authMode: 'public_link', isActive: true, agentIds: ['agent-1'] },
    ]),
    create: jest.fn().mockResolvedValue({ slug: 'acme', name: 'Acme', authMode: 'public_link', agentIds: ['agent-1'] }),
    findOne: jest.fn().mockResolvedValue({
      slug: 'acme', name: 'Acme', description: null, authMode: 'public_link', isActive: true,
      agentIds: ['agent-1'], branding: {}, limits: null,
      distributions: [{ target: 'slack', status: 'draft', gatewayId: null }],
    }),
    check: jest.fn().mockResolvedValue({ refusals: [{ code: 'PUBLIC_NEEDS_COST_CAP', message: 'A public product needs a cost cap.' }] }),
    update: jest.fn().mockResolvedValue({ slug: 'acme', name: 'Acme', authMode: 'public_link', limits: { costCapCents: 50 } }),
    remove: jest.fn().mockResolvedValue(undefined),
    addDistribution: jest.fn().mockResolvedValue({ target: 'slack', status: 'draft', gatewayId: null }),
    removeDistribution: jest.fn().mockResolvedValue(undefined),
    publishDistribution: jest.fn().mockResolvedValue({ target: 'slack', status: 'live', gatewayId: 'gw-1' }),
    unpublishDistribution: jest.fn().mockResolvedValue({ target: 'slack', status: 'draft' }),
  };
  const mockAppBuildsService: any = {
    request: jest.fn().mockResolvedValue({ id: 'build-1', status: 'queued', target: 'tui', platform: 'linux-x64', version: '1.0.0' }),
    list: jest.fn().mockResolvedValue([
      { id: 'build-1', target: 'tui', platform: 'linux-x64', version: '1.0.0', status: 'queued', signed: false },
    ]),
  };

  // A model card behaves like the entity: `selectable` is its own rule,
  // not a column, so the mock keeps the methods the service reads.
  const modelCard = (over: Record<string, any> = {}) => ({
    id: 'model-1',
    name: 'gpt-x',
    vendorModelId: 'gpt-x-2026',
    providerId: 'prov-1',
    providerType: 'openai',
    status: 'active',
    validationStatus: 'passed',
    lastValidatedAt: new Date('2026-01-01'),
    lastValidationError: null,
    privacyTier: 'public',
    region: null,
    contextLength: 128000,
    capabilities: { tools: true },
    ...over,
    isSelectable: () => over.selectable ?? true,
    effectivePricing: () => ({ inPerMTok: 1, outPerMTok: 2, currency: 'USD' }),
  });

  const mockModelCatalogService: any = {
    list: jest.fn().mockResolvedValue([modelCard()]),
    syncFromProvider: jest.fn().mockResolvedValue({ created: [modelCard()], skipped: 3, retired: [], reinstated: [] }),
    syncAll: jest.fn().mockResolvedValue({ created: [], skipped: 0, retired: [], reinstated: [], providers: ['prov-1'] }),
    validate: jest.fn().mockResolvedValue({ passed: true, error: undefined, latencyMs: 120, model: modelCard() }),
  };
  const mockModelRouterService: any = {
    preview: jest.fn().mockResolvedValue({
      candidates: [{ modelId: 'model-1', name: 'gpt-x', vendorModelId: 'gpt-x-2026', providerType: 'openai', rationale: 'cheapest', blendedPricePerMTok: 1.5, privacyTier: 'public', region: null }],
      rejected: [{ modelId: 'model-2', reason: 'privacy tier too public' }],
    }),
  };
  const mockModelDeploymentsService: any = {
    list: jest.fn().mockResolvedValue([
      { id: 'dep-1', toPublicView: () => ({ id: 'dep-1', providerType: 'modal', state: 'ready', providerConfig: { apiKey: '********' } }) },
    ]),
  };
  const mockModelVersionsService: any = {
    list: jest.fn().mockResolvedValue([
      { id: 'ver-1', name: 'llama-3-8b', registryUri: 'hf://org/repo@sha', base: 'llama3', quantizations: ['q4'], sizeBytes: '100', manifestSha: 'abc', createdAt: new Date('2026-01-01') },
    ]),
  };
  const mockConnectionsService: any = {
    describeConnectors: jest.fn().mockResolvedValue([
      {
        key: 'openai', kind: 'inference', displayName: 'OpenAI', description: 'OpenAI API',
        capabilities: ['chat'], scopesNeeded: [], keyPageUrl: 'https://platform.openai.com/api-keys', docsUrl: null,
        connect: [{ type: 'api_key', label: 'API key', schema: { type: 'object', properties: { apiKey: { type: 'string' } }, required: ['apiKey'] } }],
        validation: { kind: 'http', url: 'https://api.openai.com/v1/models' },
      },
    ]),
    list: jest.fn().mockResolvedValue([
      { id: 'conn-1', connectorKey: 'openai', connectorDisplayName: 'OpenAI', kind: 'inference', name: 'OpenAI', owner: 'org', ownerUserId: null, method: 'api_key', accountLabel: 'acct-1', health: { status: 'valid', checkedAt: null, error: null }, scopesGranted: [], expiresAt: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') },
    ]),
    connect: jest.fn().mockResolvedValue({
      pending: true, method: 'oauth2_pkce', mode: 'headless',
      authorizeUrl: 'https://github.com/login/oauth/authorize?x=1', state: 'st-1',
      expiresInSeconds: 600, completeWith: 'code',
    }),
    complete: jest.fn().mockResolvedValue({ id: 'conn-1', connectorKey: 'github', accountLabel: 'octocat', health: { status: 'valid', checkedAt: null, error: null } }),
  };
  const mockGrantsService: any = {
    list: jest.fn().mockResolvedValue([{ id: 'grant-1', connectionId: 'conn-1', principalType: 'agent', principalId: 'agent-1', permission: 'use' }]),
    grant: jest.fn().mockResolvedValue({ id: 'grant-1', connectionId: 'conn-1', principalType: 'agent', principalId: 'agent-1', permission: 'use' }),
  };
  const mockCredentialsService: any = {
    findAll: jest.fn().mockResolvedValue([
      { id: 'cred-1', name: 'OpenAI', type: 'api_key', isActive: true, connectorKey: 'openai', accountLabel: 'acct-1', healthStatus: 'valid', lastUsedAt: null, usedBy: [], config: { apiKey: '***masked***' } },
    ]),
  };
  const mockUsersService: any = {
    findOne: jest.fn().mockResolvedValue({
      id: 'user-1',
      organizationMemberships: [{ organizationId: 'org-1', role: 'admin' }],
    }),
  };
  const mockRunnerService: any = {
    listForOwner: jest.fn().mockResolvedValue([
      { id: 'runner-1', name: 'laptop', state: 'online', visibility: 'private', teamId: null, labels: [], runtimeInfo: { os: 'darwin' }, lastHeartbeatAt: new Date('2026-01-01'), registeredAt: new Date('2026-01-01') },
    ]),
  };
  const mockWorkspaceService: any = {
    listForOwner: jest.fn().mockResolvedValue([
      { id: 'ws-1', runnerId: 'runner-1', cwd: '/home/me/project', isolation: 'none', status: 'active', ttlAt: new Date('2026-01-02'), createdAt: new Date('2026-01-01'), closedAt: null },
    ]),
  };
  const mockOrganizationsService: any = {
    getMembers: jest.fn().mockResolvedValue([
      { id: 'mem-1', userId: 'user-1', email: 'me@example.com', firstName: 'Me', lastName: 'Myself', role: 'owner', joinedAt: new Date('2026-01-01'), isActive: true },
    ]),
  };
  const mockBudgetsService: any = {
    list: jest.fn().mockResolvedValue([
      { id: 'budget-1', agentId: null, llmProviderId: null, periodType: 'month', limitCents: 5000, behavior: 'reject', softThresholdPct: 80, active: true },
    ]),
  };
  const mockSpendService: any = {
    getSummary: jest.fn().mockResolvedValue({ totalCents: 1234, timeseries: [], byAgent: [] }),
  };
  const mockAnalyticsService: any = {
    getOverview: jest.fn().mockResolvedValue({ apis: 1, tools: 2 }),
    getToolUsage: jest.fn().mockResolvedValue({ tools: [] }),
    getGatewayUsage: jest.fn().mockResolvedValue({ gateways: [] }),
    getLlmUsage: jest.fn().mockResolvedValue({ models: [] }),
    getAgentRunsSummary: jest.fn().mockResolvedValue({ totalRuns: 3 }),
  };
  const mockMonitoringService: any = {
    getActiveAlerts: jest.fn().mockResolvedValue([{ id: 'alert-1', severity: 'warning', isResolved: false }]),
  };
  const mockToolHubService: any = {
    listTemplates: jest.fn().mockResolvedValue({
      templates: [{ id: 'tpl-1', name: 'Stripe charges', provider: 'stripe', category: 'payments', tags: ['payments'], isBuiltIn: true, installCount: 5, description: 'Charge a card' }],
      total: 1,
    }),
    installTemplate: jest.fn().mockResolvedValue({ api: { id: 'api-1' }, tools: [{ id: 'tool-1' }] }),
  };
  const mockApprovalsService: any = {
    listPending: jest.fn().mockResolvedValue([
      { id: 'appr-1', runId: 'run-1', agentId: 'agent-1', toolCallId: 'call-1', status: 'pending', reason: 'spend', teamId: null, expiresAt: null, createdAt: new Date('2026-01-01') },
    ]),
    approve: jest.fn().mockResolvedValue({ id: 'appr-1', status: 'approved', decidedBy: 'user-1', decidedAt: new Date('2026-01-01'), decisionReason: 'looks fine' }),
    reject: jest.fn().mockResolvedValue({ id: 'appr-1', status: 'rejected', decidedBy: 'user-1', decidedAt: new Date('2026-01-01'), decisionReason: null }),
  };
  // Two comparable requests on one agent: one recovered by a second
  // model, one where every model tried failed.
  const mockAgentExecutionRepo: any = {
    find: jest.fn().mockResolvedValue([
      { id: 'ex-1', agentId: 'agent-1', nodeResults: { n1: { routing: { modelId: 'm2', tried: [{ modelId: 'm1' }] } } } },
      { id: 'ex-2', agentId: 'agent-1', nodeResults: { n1: { error: 'boom', triedModels: [{ modelId: 'm1' }, { modelId: 'm2' }] } } },
    ]),
  };

  const mockModuleRef = {
    get: jest.fn((cls: any) => {
      if (cls === ApisService) return mockApisService;
      if (cls === ToolsService) return mockToolsService;
      if (cls === GatewaysService) return mockGatewaysService;
      if (cls === AgentsService) return mockAgentsService;
      if (cls === AgentExecutionEngine) return mockExecutionEngine;
      if (cls === AgentRuntimeService) return mockRuntimeService;
      if (cls === LlmProvidersService) return mockLlmProvidersService;
      if (cls === CanonicalMemoryService) return mockMemoryService;
      if (cls === ConsolidationService) return mockConsolidation;
      if (cls === MemoryRouter) return mockRouter;
      if (cls === MemorySyncService) return mockMemorySync;
      if (cls === AgentAppsService) return mockAgentAppsService;
      if (cls === AppBuildsService) return mockAppBuildsService;
      if (typeof cls === 'string' && cls === 'BullQueue_schema-import') return mockSchemaImportQueue;
      // Dynamic require() imports resolve by class name
      if (cls?.name === 'GatewayAuthService') return mockGatewayAuthService;
      if (cls?.name === 'GatewayToolService') return mockGatewayToolService;
      if (cls === ModelCatalogService) return mockModelCatalogService;
      if (cls === ModelRouterService) return mockModelRouterService;
      if (cls === ModelDeploymentsService) return mockModelDeploymentsService;
      if (cls === ModelVersionsService) return mockModelVersionsService;
      if (cls === ConnectionsService) return mockConnectionsService;
      if (cls === GrantsService) return mockGrantsService;
      if (cls === CredentialsService) return mockCredentialsService;
      if (cls === UsersService) return mockUsersService;
      if (cls === RunnerService) return mockRunnerService;
      if (cls === WorkspaceService) return mockWorkspaceService;
      if (cls === OrganizationsService) return mockOrganizationsService;
      if (cls === BudgetsService) return mockBudgetsService;
      if (cls === SpendService) return mockSpendService;
      if (cls === AnalyticsService) return mockAnalyticsService;
      if (cls === MonitoringService) return mockMonitoringService;
      if (cls === ToolHubService) return mockToolHubService;
      if (cls === ApprovalsService) return mockApprovalsService;
      if (cls === getRepositoryToken(AgentExecution)) return mockAgentExecutionRepo;
      throw new Error(`Unknown service: ${typeof cls === 'string' ? cls : cls?.name}`);
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlmytyMcpService,
        { provide: ModuleRef, useValue: mockModuleRef },
      ],
    }).compile();

    service = module.get(AlmytyMcpService);
  });

  // handleJsonRpc's return type now covers a batch (array) and a
  // notification (null) too; every call here sends one request with an id,
  // so narrow it back down for the assertions.
  const call = (method: string, params?: any): Promise<any> =>
    service.handleJsonRpc({ jsonrpc: '2.0', id: 1, method, params }, 'org-1', 'user-1') as Promise<any>;

  describe('initialize', () => {
    it('returns server info and capabilities', async () => {
      const res = await call('initialize');
      expect(res.result.serverInfo.name).toBe('almyty');
      expect(res.result.capabilities.tools).toBeDefined();
      expect(res.result.protocolVersion).toBe('2024-11-05');
    });
  });

  describe('tools/list', () => {
    it('returns all built-in tools', async () => {
      const res = await call('tools/list');
      expect(res.result.tools.length).toBeGreaterThan(0);
      expect(res.result.tools[0]).toHaveProperty('name');
      expect(res.result.tools[0]).toHaveProperty('description');
      expect(res.result.tools[0]).toHaveProperty('inputSchema');
    });

    it('includes expected tool names', async () => {
      const res = await call('tools/list');
      const names = res.result.tools.map((t: any) => t.name);
      expect(names).toContain('list_apis');
      expect(names).toContain('list_tools');
      expect(names).toContain('list_gateways');
      expect(names).toContain('list_agents');
      expect(names).toContain('create_agent');
    });
  });

  describe('resources/list', () => {
    it('returns empty resources array', async () => {
      const res = await call('resources/list');
      expect(res.result.resources).toEqual([]);
    });
  });

  describe('resources/read', () => {
    it('returns error for any resource', async () => {
      const res = await call('resources/read', { uri: 'test://foo' });
      expect(res.error.code).toBe(-32602);
    });
  });

  describe('prompts/list', () => {
    it('returns empty prompts array', async () => {
      const res = await call('prompts/list');
      expect(res.result.prompts).toEqual([]);
    });
  });

  describe('prompts/get', () => {
    it('returns valid message response', async () => {
      const res = await call('prompts/get', { name: 'test-prompt' });
      expect(res.result.messages).toBeDefined();
      expect(res.result.messages[0].role).toBe('user');
    });
  });

  describe('ping', () => {
    it('returns empty result', async () => {
      const res = await call('ping');
      expect(res.result).toEqual({});
    });
  });

  describe('notifications/initialized', () => {
    // JSON-RPC 2.0 §4.1: a message with no `id` is a Notification and MUST
    // NOT be answered. This is the first thing Claude Code, Cursor and
    // Claude Desktop send after initialize; it used to come back as
    // `{"jsonrpc":"2.0","result":{}}` — no id, not a valid JSON-RPC message
    // of any kind — and both official SDKs raise on that.
    it('is never answered when it arrives as a real notification', async () => {
      const res = await service.handleJsonRpc(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        'org-1',
        'user-1',
      );
      expect(res).toBeNull();
    });

    it.each(['notifications/cancelled', 'notifications/progress', 'notifications/roots/list_changed'])(
      '%s is never answered either',
      async (method) => {
        expect(await service.handleJsonRpc({ jsonrpc: '2.0', method }, 'org-1', 'user-1')).toBeNull();
      },
    );

    it('drops the reply to any id-less message, not just notifications/*', async () => {
      expect(await service.handleJsonRpc({ jsonrpc: '2.0', method: 'ping' }, 'org-1', 'user-1')).toBeNull();
    });

    it('returns empty result', async () => {
      const res = await call('notifications/initialized');
      expect(res.result).toEqual({});
    });
  });

  describe('unknown method', () => {
    it('returns -32601 error', async () => {
      const res = await call('bogus/method');
      expect(res.error.code).toBe(-32601);
      expect(res.error.message).toContain('bogus/method');
    });
  });

  describe('tools/call', () => {
    it('returns error for unknown tool', async () => {
      const res = await call('tools/call', { name: 'nonexistent_tool', arguments: {} });
      expect(res.result.content[0].text).toContain('Unknown tool');
      expect(res.result.isError).toBe(true);
    });

    it('list_apis calls ApisService.findAllByOrganization', async () => {
      const res = await call('tools/call', { name: 'list_apis', arguments: {} });
      expect(mockApisService.findAllByOrganization).toHaveBeenCalledWith({ id: 'user-1' }, 'org-1', { limit: 50 });
      expect(res.result.isError).toBeUndefined();
    });

    it('import_schema fetches the URL through the SSRF-guarded helper', async () => {
      const res = await call('tools/call', {
        name: 'import_schema',
        arguments: { apiId: 'api-1', schemaUrl: 'https://example.com/openapi.json', generateTools: true },
      });
      // Two assertions merged. This one keeps the MCP half: the tool
      // delegates and never opens its own connection, so a second gate
      // cannot drift away from the first. The transport half that #696
      // asserted here (validateUrl + pinned agents + maxRedirects: 0)
      // moved with the transport, into the apis-import helper's own spec,
      // because that is where the axios call now lives.
      expect(mockAxiosGet).not.toHaveBeenCalled();
      expect(mockApisService.fetchSchemaFromUrl).toHaveBeenCalledWith('https://example.com/openapi.json');
      expect(mockSchemaImportQueue.add).toHaveBeenCalledWith(
        'import',
        expect.objectContaining({
          apiId: 'api-1',
          organizationId: 'org-1',
          schemaContent: expect.any(String),
          options: { generateTools: true },
        }),
        expect.any(Object),
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.jobId).toBe('job-1');
      expect(parsed.status).toBe('queued');
    });

    it('list_gateways calls GatewaysService.getGateways', async () => {
      await call('tools/call', { name: 'list_gateways', arguments: {} });
      expect(mockGatewaysService.getGateways).toHaveBeenCalledWith({ organizationId: 'org-1', limit: 50, caller: { id: 'user-1' } });
    });

    it('create_agent calls AgentsService.createAgent with correct args', async () => {
      await call('tools/call', { name: 'create_agent', arguments: { name: 'My Agent' } });
      expect(mockAgentsService.createAgent).toHaveBeenCalledWith(
        { name: 'My Agent' },
        'org-1',
        'user-1',
      );
    });

    it('assign_tools_to_gateway passes (gatewayId, {toolIds}, orgId, userId)', async () => {
      await call('tools/call', {
        name: 'assign_tools_to_gateway',
        arguments: { gatewayId: 'gw-1', toolIds: ['tool-1', 'tool-2'] },
      });
      expect(mockGatewayToolService.bulkAssociateTools).toHaveBeenCalledWith(
        'gw-1',
        { toolIds: ['tool-1', 'tool-2'] },
        'org-1',
        'user-1',
      );
    });

    it('add_auth_to_gateway passes (gatewayId, dto, orgId) not a single object', async () => {
      const res = await call('tools/call', {
        name: 'add_auth_to_gateway',
        arguments: { gatewayId: 'gw-1', type: 'oauth2' },
      });
      // Bug: was passing entire DTO as first arg, causing "invalid uuid" error
      expect(mockGatewayAuthService.createGatewayAuth).toHaveBeenCalledWith(
        'gw-1', // gatewayId as separate string arg
        { type: 'oauth2', configuration: {} },
        'org-1',
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.id).toBe('auth-1');
    });

    it('add_auth_to_gateway sets api_key config defaults', async () => {
      await call('tools/call', {
        name: 'add_auth_to_gateway',
        arguments: { gatewayId: 'gw-1', type: 'api_key' },
      });
      expect(mockGatewayAuthService.createGatewayAuth).toHaveBeenCalledWith(
        'gw-1',
        { type: 'api_key', configuration: { keyHeader: 'x-api-key', keyQuery: 'api_key' } },
        'org-1',
      );
    });

    it('update_api forwards (apiId, patch, orgId) to ApisService.update', async () => {
      mockApisService.update = jest.fn().mockResolvedValue({
        id: 'api-1',
        name: 'a',
        baseUrl: 'https://x',
        authentication: { type: 'api_key', config: {} },
      });
      await call('tools/call', {
        name: 'update_api',
        arguments: {
          apiId: 'api-1',
          authentication: { type: 'api_key', config: { parameter: 'X-Key' } },
        },
      });
      expect(mockApisService.update).toHaveBeenCalledWith(
        'api-1',
        { authentication: { type: 'api_key', config: { parameter: 'X-Key' } } },
        'org-1',
      );
    });

    it('import_schema accepts schemaContent inline (no URL needed)', async () => {
      const queueSpy = jest.fn().mockResolvedValue({ id: 'job-99' });
      (mockSchemaImportQueue as any).add = queueSpy;
      await call('tools/call', {
        name: 'import_schema',
        arguments: {
          apiId: 'api-1',
          schemaContent: '{"openapi":"3.0.0"}',
        },
      });
      expect(queueSpy).toHaveBeenCalledWith(
        'import',
        expect.objectContaining({
          apiId: 'api-1',
          schemaContent: '{"openapi":"3.0.0"}',
        }),
        expect.anything(),
      );
    });

    it('import_schema requires either schemaUrl or schemaContent', async () => {
      const res = await call('tools/call', {
        name: 'import_schema',
        arguments: { apiId: 'api-1' },
      });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/schemaUrl or schemaContent/);
    });

    it('delete_gateway returns a serializable {deleted, gatewayId} (void Promise was producing invalid MCP content)', async () => {
      mockGatewaysService.deleteGateway = jest.fn().mockResolvedValue(undefined);
      const res = await call('tools/call', {
        name: 'delete_gateway',
        arguments: { gatewayId: 'gw-99' },
      });
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed).toEqual({ deleted: true, gatewayId: 'gw-99' });
      expect(mockGatewaysService.deleteGateway).toHaveBeenCalledWith('gw-99', 'org-1', 'user-1');
    });

    it('delete_tool and delete_api also return serializable confirmations (not undefined)', async () => {
      mockToolsService.deleteTool = jest.fn().mockResolvedValue(undefined);
      mockApisService.remove = jest.fn().mockResolvedValue(undefined);

      const tRes = await call('tools/call', { name: 'delete_tool', arguments: { toolId: 't-1' } });
      expect(JSON.parse(tRes.result.content[0].text)).toEqual({ deleted: true, toolId: 't-1' });

      const aRes = await call('tools/call', { name: 'delete_api', arguments: { apiId: 'a-1' } });
      expect(JSON.parse(aRes.result.content[0].text)).toEqual({ deleted: true, apiId: 'a-1' });
    });

    it('create_gateway defaults UTCP configuration to {protocol: http}', async () => {
      await call('tools/call', {
        name: 'create_gateway',
        arguments: { name: 'My UTCP', type: 'utcp' },
      });
      expect(mockGatewaysService.createGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'utcp',
          configuration: { protocol: 'http' },
        }),
        'org-1',
        'user-1',
      );
    });

    it('create_gateway defaults MCP configuration to {transport: http}', async () => {
      await call('tools/call', {
        name: 'create_gateway',
        arguments: { name: 'My MCP', type: 'mcp' },
      });
      expect(mockGatewaysService.createGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp',
          configuration: { transport: 'http' },
        }),
        'org-1',
        'user-1',
      );
    });

    it('create_gateway respects explicit configuration override', async () => {
      await call('tools/call', {
        name: 'create_gateway',
        arguments: { name: 'TCP UTCP', type: 'utcp', configuration: { protocol: 'tcp' } },
      });
      expect(mockGatewaysService.createGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          configuration: { protocol: 'tcp' },
        }),
        'org-1',
        'user-1',
      );
    });

    it('remove_auth_from_gateway passes (authId, orgId)', async () => {
      const res = await call('tools/call', {
        name: 'remove_auth_from_gateway',
        arguments: { gatewayId: 'gw-1', authId: 'auth-99' },
      });
      expect(mockGatewayAuthService.deleteGatewayAuth).toHaveBeenCalledWith('auth-99', 'org-1');
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.deleted).toBe(true);
    });

    // ── Memory tools (canonical schema v1) ─────────────────────

    it('memory_put: defaults scope_type=workspace, scope_id=orgId; passes through to canonical service', async () => {
      const res = await call('tools/call', {
        name: 'memory_put',
        arguments: { mode: 'memory', content: 'a useful fact' },
      });
      expect(mockMemoryService.put).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'memory',
          content: 'a useful fact',
          scope: { scope_type: 'workspace', scope_id: 'org-1' },
          tier: 'short',
        }),
        { user_id: 'user-1' },
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.id).toBe('mem-1');
    });

    /**
     * This test used to assert that a caller-supplied scope_id was
     * honoured, which was the vulnerability rather than the feature:
     * scope_id IS the organization id, so any client authorized on one
     * org's gateway could name another org and read or write its memory.
     * The tool no longer accepts the field at all.
     */
    it('memory_put: forwards the tier but pins the scope to the caller\'s own org', async () => {
      await call('tools/call', {
        name: 'memory_put',
        arguments: {
          mode: 'memory',
          content: 'project note',
          scope_type: 'project',
          scope_id: 'proj_42',
          tier: 'project',
          tags: ['note'],
        },
      });
      expect(mockMemoryService.put).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { scope_type: 'project', scope_id: 'org-1' },
          tier: 'project',
          tags: ['note'],
        }),
        { user_id: 'user-1' },
      );
    });

    it('memory_search: passes query + scope to canonical service and returns ranked items', async () => {
      const res = await call('tools/call', {
        name: 'memory_search',
        arguments: { query: 'cosine similarity' },
      });
      expect(mockMemoryService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'cosine similarity',
          scope: { scope_type: 'workspace', scope_id: 'org-1' },
          top_k: 10,
        }),
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed[0]).toEqual(
        expect.objectContaining({ id: 'mem-1', score: 0.9, signal: 'hybrid' }),
      );
    });

    it('memory_list: pages with default limit + cursor null', async () => {
      await call('tools/call', { name: 'memory_list', arguments: { mode: 'memory' } });
      expect(mockMemoryService.list).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { scope_type: 'workspace', scope_id: 'org-1' },
          mode: 'memory',
          limit: 50,
          cursor: null,
        }),
      );
    });

    it('memory_get: returns the row when found', async () => {
      const res = await call('tools/call', {
        name: 'memory_get',
        arguments: { id: 'mem-1' },
      });
      // Scoped to the caller's organization: unscoped, this tool read any
      // tenant's memory by uuid.
      expect(mockMemoryService.get).toHaveBeenCalledWith('mem-1', 'org-1');
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.id).toBe('mem-1');
    });

    it('memory_delete: defaults to soft mode', async () => {
      await call('tools/call', {
        name: 'memory_delete',
        arguments: { id: 'mem-1' },
      });
      expect(mockMemoryService.delete).toHaveBeenCalledWith('mem-1', 'org-1', 'soft', {
        user_id: 'user-1',
      });
    });

    it('memory_supersede: forwards old_id + new content as memory mode write', async () => {
      const res = await call('tools/call', {
        name: 'memory_supersede',
        arguments: { old_id: 'mem-1', content: 'corrected fact' },
      });
      expect(mockMemoryService.supersede).toHaveBeenCalledWith(
        'mem-1',
        'org-1',
        expect.objectContaining({
          mode: 'memory',
          content: 'corrected fact',
          tier: 'long',
        }),
        { user_id: 'user-1' },
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.old_id).toBe('mem-1');
      expect(parsed.new_id).toBe('mem-2');
    });

    // ── Router-level memory tools ─────────────────────────────

    it('memory_consolidate: forwards force flag and scope, returns the consolidation report', async () => {
      const res = await call('tools/call', {
        name: 'memory_consolidate',
        arguments: { force: true },
      });
      expect(mockConsolidation.run).toHaveBeenCalledWith(
        { scope_type: 'workspace', scope_id: 'org-1' },
        { force: true },
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.consolidated_facts).toBe(2);
    });

    it('memory_transfer: forwards source/target/dry_run to the router', async () => {
      const res = await call('tools/call', {
        name: 'memory_transfer',
        arguments: { source: 'almyty-native', target: 'mem0', dry_run: true },
      });
      expect(mockRouter.transfer).toHaveBeenCalledWith(
        { scope_type: 'workspace', scope_id: 'org-1' },
        'almyty-native', 'mem0',
        expect.objectContaining({ dry_run: true }),
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.succeeded).toBe(5);
    });

    it('memory_sync: reconciles primary↔mirror for the calling org by default', async () => {
      const res = await call('tools/call', {
        name: 'memory_sync',
        arguments: {},
      });
      expect(mockMemorySync.sync).toHaveBeenCalledWith(
        { scope_type: 'workspace', scope_id: 'org-1' },
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.to_mirror).toBe(1);
    });

    it('memory_list_backends: returns the backend roster', async () => {
      const res = await call('tools/call', { name: 'memory_list_backends', arguments: {} });
      expect(mockRouter.list_backends).toHaveBeenCalled();
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed[0].id).toBe('almyty-native');
    });

    it('memory_backends_health: returns per-backend health', async () => {
      const res = await call('tools/call', { name: 'memory_backends_health', arguments: {} });
      expect(mockRouter.healthAll).toHaveBeenCalled();
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed['almyty-native'].ok).toBe(true);
    });
  });

  describe('Agent Factory (/apps) tools', () => {
    const callTool = (name: string, args: any = {}) =>
      call('tools/call', { name, arguments: args });
    const parse = (res: any) => JSON.parse(res.result.content[0].text);

    it('advertises the Agent Factory tools', async () => {
      const res = await call('tools/list');
      const names = res.result.tools.map((t: any) => t.name);
      for (const n of ['list_apps', 'create_app', 'get_app', 'check_app', 'update_app',
        'delete_app', 'add_distribution', 'remove_distribution', 'publish_distribution',
        'unpublish_distribution', 'build_app', 'list_builds']) {
        expect(names).toContain(n);
      }
    });

    it('create_app forwards name + slug to the service', async () => {
      const res = await callTool('create_app', { name: 'Acme', slug: 'acme', agentIds: ['agent-1'] });
      expect(mockAgentAppsService.create).toHaveBeenCalledWith('org-1', { name: 'Acme', slug: 'acme', agentIds: ['agent-1'] });
      expect(parse(res).slug).toBe('acme');
    });

    it('list_apps summarises the org apps', async () => {
      const res = await callTool('list_apps');
      expect(mockAgentAppsService.list).toHaveBeenCalledWith('org-1');
      expect(parse(res).total).toBe(1);
      expect(parse(res).apps[0].slug).toBe('acme');
    });

    it('check_app surfaces what blocks shipping', async () => {
      const res = await callTool('check_app', { slug: 'acme' });
      expect(mockAgentAppsService.check).toHaveBeenCalledWith('org-1', 'acme');
      expect(parse(res).refusals[0].code).toBe('PUBLIC_NEEDS_COST_CAP');
    });

    it('update_app passes the patch without the slug', async () => {
      await callTool('update_app', { slug: 'acme', limits: { costCapCents: 50 } });
      expect(mockAgentAppsService.update).toHaveBeenCalledWith('org-1', 'acme', { limits: { costCapCents: 50 } });
    });

    it('add_distribution forwards target, configuration and gatewayId', async () => {
      await callTool('add_distribution', { slug: 'acme', target: 'slack', configuration: { botToken: 'x' } });
      expect(mockAgentAppsService.addDistribution).toHaveBeenCalledWith('org-1', 'acme', 'slack', { botToken: 'x' }, null);
    });

    it('publish_distribution passes the calling user id', async () => {
      const res = await callTool('publish_distribution', { slug: 'acme', target: 'slack' });
      expect(mockAgentAppsService.publishDistribution).toHaveBeenCalledWith('org-1', 'acme', 'slack', 'user-1');
      expect(parse(res).status).toBe('live');
    });

    it('unpublish_distribution passes the calling user id', async () => {
      await callTool('unpublish_distribution', { slug: 'acme', target: 'slack' });
      expect(mockAgentAppsService.unpublishDistribution).toHaveBeenCalledWith('org-1', 'acme', 'slack', 'user-1');
    });

    it('build_app queues a server build for a platform', async () => {
      const res = await callTool('build_app', { slug: 'acme', target: 'tui', platform: 'linux-x64' });
      expect(mockAppBuildsService.request).toHaveBeenCalledWith('org-1', 'acme', { target: 'tui', platform: 'linux-x64' }, 'user-1');
      expect(parse(res).id).toBe('build-1');
    });

    it('list_builds returns the build history', async () => {
      const res = await callTool('list_builds', { slug: 'acme' });
      expect(mockAppBuildsService.list).toHaveBeenCalledWith('org-1', 'acme');
      expect(parse(res).builds[0].id).toBe('build-1');
    });

    it('delete_app removes the app', async () => {
      const res = await callTool('delete_app', { slug: 'acme' });
      expect(mockAgentAppsService.remove).toHaveBeenCalledWith('org-1', 'acme');
      expect(parse(res).deleted).toBe(true);
    });

    it('surfaces a service error as an MCP tool error', async () => {
      mockAgentAppsService.publishDistribution.mockRejectedValueOnce(new Error('A public product needs a cost cap.'));
      const res = await callTool('publish_distribution', { slug: 'acme', target: 'slack' });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('cost cap');
    });
  });


  // ── Agent lifecycle + invocation over MCP ──────────────────────
  //
  // Before these, an MCP client could create an agent and wire tools to it
  // but never run it: there was no invoke_agent, no activate_agent, and
  // invoke refuses anything that is not ACTIVE — so the flow dead-ended at
  // a DRAFT agent.
  describe('agent lifecycle + invoke', () => {
    const callTool = (name: string, args: any = {}) =>
      call('tools/call', { name, arguments: args });
    const parse = (res: any) => JSON.parse(res.result.content[0].text);

    it('advertises the agent lifecycle + invoke tools', async () => {
      const res = await call('tools/list');
      const names = res.result.tools.map((t: any) => t.name);
      for (const n of ['invoke_agent', 'activate_agent', 'deactivate_agent', 'update_agent', 'delete_agent']) {
        expect(names).toContain(n);
      }
    });

    it('invoke_agent runs a workflow agent through the same engine as POST /agents/:id/invoke and returns the execution id', async () => {
      const res = await callTool('invoke_agent', {
        agentId: 'agent-1',
        input: { q: 'hello' },
        variables: { v: 1 },
        metadata: { source: 'mcp' },
      });
      expect(mockExecutionEngine.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-1', status: 'active', mode: 'workflow' }),
        'org-1',
        'user-1',
        { input: { q: 'hello' }, variables: { v: 1 }, metadata: { source: 'mcp' } },
      );
      // Autonomous runtime must NOT be involved for a workflow agent.
      expect(mockRuntimeService.startRun).not.toHaveBeenCalled();
      const parsed = parse(res);
      expect(parsed.executionId).toBe('exec-1');
      expect(parsed.status).toBe('completed');
      expect(parsed.success).toBe(true);
      expect(parsed.output).toEqual({ answer: 42 });
    });

    it('invoke_agent routes an autonomous agent to the runtime, not the pipeline engine', async () => {
      mockAgentsService.getAgent.mockResolvedValueOnce({ id: 'agent-2', name: 'Auto', mode: 'autonomous', status: 'active' });
      const res = await callTool('invoke_agent', { agentId: 'agent-2', input: { message: 'go' } });
      expect(mockRuntimeService.startRun).toHaveBeenCalledWith('agent-2', 'org-1', 'user-1', { message: 'go' });
      expect(mockExecutionEngine.execute).not.toHaveBeenCalled();
      const parsed = parse(res);
      expect(parsed.mode).toBe('autonomous');
      expect(parsed.runId).toBe('run-1');
    });

    it('invoke_agent refuses a DRAFT agent and names activate_agent', async () => {
      mockAgentsService.getAgent.mockResolvedValueOnce({ id: 'agent-3', name: 'Draft', mode: 'workflow', status: 'draft' });
      const res = await callTool('invoke_agent', { agentId: 'agent-3' });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/only an active agent can be invoked/i);
      expect(res.result.content[0].text).toMatch(/activate_agent/);
      expect(res.result.content[0].text).toMatch(/activate_agent/);
      expect(mockExecutionEngine.execute).not.toHaveBeenCalled();
    });

    it('activate_agent and deactivate_agent call the same service methods as the UI buttons', async () => {
      const on = await callTool('activate_agent', { agentId: 'agent-1' });
      expect(mockAgentsService.activateAgent).toHaveBeenCalledWith('agent-1', 'org-1', 'user-1');
      expect(parse(on).status).toBe('active');

      const off = await callTool('deactivate_agent', { agentId: 'agent-1' });
      expect(mockAgentsService.deactivateAgent).toHaveBeenCalledWith('agent-1', 'org-1', 'user-1');
      expect(parse(off).status).toBe('inactive');
    });

    it('update_agent forwards the patch without agentId and delete_agent confirms', async () => {
      await callTool('update_agent', {
        agentId: 'agent-1',
        instructions: 'be terse',
        toolIds: ['t-1'],
        modelConfig: { model: 'x' },
      });
      expect(mockAgentsService.updateAgent).toHaveBeenCalledWith(
        'agent-1',
        { instructions: 'be terse', toolIds: ['t-1'], modelConfig: { model: 'x' } },
        'org-1',
        'user-1',
      );

      const del = await callTool('delete_agent', { agentId: 'agent-1' });
      expect(mockAgentsService.deleteAgent).toHaveBeenCalledWith('agent-1', 'org-1', 'user-1');
      expect(parse(del)).toEqual({ deleted: true, agentId: 'agent-1' });
    });

    it('create_agent tells the caller the new agent is not active yet', async () => {
      mockAgentsService.createAgent.mockResolvedValueOnce({ id: 'agent-9', name: 'New', mode: 'workflow', status: 'draft' });
      const res = await callTool('create_agent', { name: 'New' });
      expect(parse(res).status).toBe('draft');
      expect(parse(res).nextStep).toMatch(/activate_agent/);
    });

    it('create_agent exposes the fields that actually make an agent work (mirrors CreateAgentDto)', async () => {
      const res = await call('tools/list');
      const schema = res.result.tools.find((t: any) => t.name === 'create_agent').inputSchema;
      // Only name/description/mode/instructions used to be reachable, so an
      // MCP-built agent had no graph, no tools and no model.
      for (const field of ['pipeline', 'toolIds', 'modelConfig', 'memoryConfig', 'agentConfig', 'collaboration', 'variables', 'personality', 'heartbeat', 'webhookUrl']) {
        expect(Object.keys(schema.properties)).toContain(field);
      }
      expect(schema.properties.pipeline.properties.nodes).toBeDefined();
      expect(schema.properties.pipeline.properties.edges).toBeDefined();
    });
  });

  // ── Tool activation + honest gateway assignment counts ─────────
  describe('tool activation and gateway assignment honesty', () => {
    const callTool = (name: string, args: any = {}) =>
      call('tools/call', { name, arguments: args });
    const parse = (res: any) => JSON.parse(res.result.content[0].text);

    it('advertises activate_tool', async () => {
      const res = await call('tools/list');
      expect(res.result.tools.map((t: any) => t.name)).toContain('activate_tool');
    });

    it('activate_tool activates every id and reports failures per id instead of failing the batch', async () => {
      mockToolsService.activateTool
        .mockResolvedValueOnce({ id: 't-1', name: 'one', status: 'active' })
        .mockRejectedValueOnce(new Error('Tool not found'));
      const res = await callTool('activate_tool', { toolIds: ['t-1', 't-2'] });
      expect(mockToolsService.activateTool).toHaveBeenCalledWith('t-1', 'org-1', 'user-1');
      expect(mockToolsService.activateTool).toHaveBeenCalledWith('t-2', 'org-1', 'user-1');
      const parsed = parse(res);
      expect(parsed.activatedCount).toBe(1);
      expect(parsed.activated[0].id).toBe('t-1');
      expect(parsed.failed).toEqual([{ toolId: 't-2', reason: 'Tool not found' }]);
    });

    it('activate_tool accepts a single toolId', async () => {
      mockToolsService.activateTool.mockResolvedValueOnce({ id: 't-7', name: 'seven', status: 'active' });
      const res = await callTool('activate_tool', { toolId: 't-7' });
      expect(mockToolsService.activateTool).toHaveBeenCalledWith('t-7', 'org-1', 'user-1');
      expect(parse(res).activatedCount).toBe(1);
    });

    it('activate_tool refuses with no ids', async () => {
      const res = await callTool('activate_tool', {});
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/requires toolId or toolIds/);
    });

    // The headline honesty bug: toolsAssigned was toolIds.length, the
    // number REQUESTED. bulkAssociateTools only attaches ACTIVE tools, so
    // an agent was told "2 tools assigned" about a gateway serving 1.
    it('create_gateway reports the tools that actually attached, not the ones requested', async () => {
      mockToolsService.getTools.mockResolvedValueOnce({
        tools: [{ id: 't-1', status: 'active' }, { id: 't-2', status: 'draft' }],
        total: 2,
      });
      mockGatewayToolService.bulkAssociateTools.mockResolvedValueOnce({
        associated: [{ id: 'gt-1', toolId: 't-1' }],
        skipped: [{ toolId: 't-2', reason: 'Tool not found or not active' }],
      });
      const res = await callTool('create_gateway', { name: 'My MCP', type: 'mcp' });
      const parsed = parse(res);
      expect(parsed.toolsRequested).toBe(2);
      expect(parsed.toolsAssigned).toBe(1);
      expect(parsed.toolsSkipped).toEqual([{ toolId: 't-2', reason: 'Tool not found or not active' }]);
      expect(parsed.hint).toMatch(/activate_tool/);
    });

    it('create_gateway surfaces a failed tool assignment instead of silently reporting zero', async () => {
      mockToolsService.getTools.mockResolvedValueOnce({ tools: [{ id: 't-1' }], total: 1 });
      mockGatewayToolService.bulkAssociateTools.mockRejectedValueOnce(new Error('no permission'));
      const res = await callTool('create_gateway', { name: 'Broken', type: 'mcp' });
      const parsed = parse(res);
      expect(parsed.toolsAssigned).toBe(0);
      expect(parsed.toolAssignmentError).toBe('no permission');
    });

    it('assign_tools_to_gateway reports the real count and exactly which ids were skipped and why', async () => {
      mockGatewayToolService.bulkAssociateTools.mockResolvedValueOnce({
        associated: [{ id: 'gt-1', toolId: 'tool-1' }],
        skipped: [{ toolId: 'tool-2', reason: 'Tool not found or not active' }],
      });
      const res = await callTool('assign_tools_to_gateway', {
        gatewayId: 'gw-1',
        toolIds: ['tool-1', 'tool-2'],
      });
      const parsed = parse(res);
      expect(parsed.requested).toBe(2);
      expect(parsed.toolsAssigned).toBe(1);
      expect(parsed.toolsSkipped[0]).toEqual({ toolId: 'tool-2', reason: 'Tool not found or not active' });
      expect(parsed.hint).toMatch(/activate_tool/);
    });

    it('assign_tools_to_gateway leaves no hint when everything attached', async () => {
      mockGatewayToolService.bulkAssociateTools.mockResolvedValueOnce({
        associated: [{ id: 'gt-1', toolId: 'tool-1' }],
        skipped: [],
      });
      const res = await callTool('assign_tools_to_gateway', { gatewayId: 'gw-1', toolIds: ['tool-1'] });
      const parsed = parse(res);
      expect(parsed.toolsAssigned).toBe(1);
      expect(parsed.hint).toBeUndefined();
    });
  });

  describe('create_api requires a baseUrl', () => {
    const callTool = (name: string, args: any = {}) =>
      call('tools/call', { name, arguments: args });

    // Every generated tool builds its URL from api.baseUrl; without one,
    // validateUrl(undefined) fails and every call is blocked at run time.
    it('refuses an API with no baseUrl and says why', async () => {
      const res = await callTool('create_api', { name: 'Acme', type: 'openapi' });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/baseUrl/);
      expect(mockApisService.create).not.toHaveBeenCalled();
    });

    it('refuses a baseUrl that is not http(s)', async () => {
      const res = await callTool('create_api', { name: 'Acme', type: 'openapi', baseUrl: 'ftp://acme.test' });
      expect(res.result.isError).toBe(true);
      expect(mockApisService.create).not.toHaveBeenCalled();
    });

    it('creates the API when a baseUrl is given', async () => {
      const res = await callTool('create_api', { name: 'Acme', type: 'openapi', baseUrl: 'https://api.acme.test' });
      expect(res.result.isError).toBeUndefined();
      // `userId` is the SECOND argument, not a field on the data object.
      // Inside the object it was silently ignored and
      // `assertCanScopeToTeam` never ran, so an MCP-created API could be
      // scoped to a team the caller does not belong to.
      expect(mockApisService.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Acme', baseUrl: 'https://api.acme.test', organizationId: 'org-1' }),
        'user-1',
      );
      expect(mockApisService.create.mock.calls[0][0]).not.toHaveProperty('userId');
    });

    it('marks baseUrl required in the advertised schema', async () => {
      const res = await call('tools/list');
      const schema = res.result.tools.find((t: any) => t.name === 'create_api').inputSchema;
      expect(schema.required).toContain('baseUrl');
    });
  });

  describe('add_auth_to_gateway configuration', () => {
    const callTool = (name: string, args: any = {}) =>
      call('tools/call', { name, arguments: args });

    // jwt requires configuration.secret (gateway-auth-utils.ts:114); with no
    // way to pass it, the enum advertised a type this tool could not create.
    it('forwards a jwt secret so the advertised jwt type is actually creatable', async () => {
      await callTool('add_auth_to_gateway', {
        gatewayId: 'gw-1',
        type: 'jwt',
        configuration: { secret: 'gateway-specific' },
      });
      expect(mockGatewayAuthService.createGatewayAuth).toHaveBeenCalledWith(
        'gw-1',
        { type: 'jwt', configuration: { secret: 'gateway-specific' } },
        'org-1',
      );
    });

    it('lets an explicit api_key configuration override the defaults', async () => {
      await callTool('add_auth_to_gateway', {
        gatewayId: 'gw-1',
        type: 'api_key',
        configuration: { keyHeader: 'x-acme-key' },
      });
      expect(mockGatewayAuthService.createGatewayAuth).toHaveBeenCalledWith(
        'gw-1',
        { type: 'api_key', configuration: { keyHeader: 'x-acme-key' } },
        'org-1',
      );
    });

    it('never echoes configuration values back, only the key names', async () => {
      const res = await callTool('add_auth_to_gateway', {
        gatewayId: 'gw-1',
        type: 'jwt',
        configuration: { secret: 'do-not-echo' },
      });
      expect(res.result.content[0].text).not.toContain('do-not-echo');
      expect(JSON.parse(res.result.content[0].text).configuredKeys).toEqual(['secret']);
    });

    it('advertises configuration on the tool schema', async () => {
      const res = await call('tools/list');
      const schema = res.result.tools.find((t: any) => t.name === 'add_auth_to_gateway').inputSchema;
      expect(schema.properties.configuration).toBeDefined();
    });
  });

  describe('memory_supersede keeps the old row scope', () => {
    const callTool = (name: string, args: any = {}) =>
      call('tools/call', { name, arguments: args });

    // supersede() finds the old row by (id, scope_id=orgId) only -- the id
    // does NOT pin scope_type -- so hardcoding 'workspace' for the new row
    // moved a user/project-scoped correction into a different scope.
    it('writes the replacement into the old row scope, not a hardcoded workspace', async () => {
      mockMemoryService.get.mockResolvedValueOnce({
        id: 'mem-1', mode: 'memory', scope_type: 'project', tier: 'project',
      });
      const res = await callTool('memory_supersede', { old_id: 'mem-1', content: 'corrected' });
      expect(mockMemoryService.get).toHaveBeenCalledWith('mem-1', 'org-1');
      expect(mockMemoryService.supersede).toHaveBeenCalledWith(
        'mem-1',
        'org-1',
        expect.objectContaining({ scope: { scope_type: 'project', scope_id: 'org-1' } }),
        { user_id: 'user-1' },
      );
      expect(JSON.parse(res.result.content[0].text).scope_type).toBe('project');
    });

    it('accepts a matching scope_type assertion', async () => {
      mockMemoryService.get.mockResolvedValueOnce({ id: 'mem-1', mode: 'memory', scope_type: 'user' });
      await callTool('memory_supersede', { old_id: 'mem-1', content: 'c', scope_type: 'user' });
      expect(mockMemoryService.supersede).toHaveBeenCalledWith(
        'mem-1',
        'org-1',
        expect.objectContaining({ scope: { scope_type: 'user', scope_id: 'org-1' } }),
        { user_id: 'user-1' },
      );
    });

    it('refuses a scope_type that disagrees with the old row rather than silently moving it', async () => {
      mockMemoryService.get.mockResolvedValueOnce({ id: 'mem-1', mode: 'memory', scope_type: 'project' });
      const res = await callTool('memory_supersede', { old_id: 'mem-1', content: 'c', scope_type: 'user' });
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.error.kind).toBe('scope_mismatch');
      expect(parsed.error.actual_scope_type).toBe('project');
      expect(parsed.error.requested_scope_type).toBe('user');
      expect(mockMemoryService.supersede).not.toHaveBeenCalled();
    });

    it('reports not_found when the old row is not in the callers org', async () => {
      mockMemoryService.get.mockResolvedValueOnce(null);
      const res = await callTool('memory_supersede', { old_id: 'mem-nope', content: 'c' });
      expect(JSON.parse(res.result.content[0].text).error.kind).toBe('not_found');
      expect(mockMemoryService.supersede).not.toHaveBeenCalled();
    });

    it('advertises scope_type on the tool schema', async () => {
      const res = await call('tools/list');
      const schema = res.result.tools.find((t: any) => t.name === 'memory_supersede').inputSchema;
      expect(schema.properties.scope_type).toBeDefined();
    });
  });

  // ── Surfaces the control plane used to be blind to: models,
  // connections, runners, org, cost, analytics, tool-hub, approvals ──
  describe('tools/call — models', () => {
    const callTool = (name: string, args: any = {}) => call('tools/call', { name, arguments: args });
    const parse = (res: any) => JSON.parse(res.result.content[0].text);

    it('list_models forwards every filter the DTO accepts', async () => {
      await callTool('list_models', { status: 'active', privacyTier: 'public', providerId: 'prov-1', selectable: true });
      expect(mockModelCatalogService.list).toHaveBeenCalledWith('org-1', {
        status: 'active', privacyTier: 'public', providerId: 'prov-1', selectable: true,
      });
    });

    it('list_models reports selectable from the card, not from its fields', async () => {
      const res = await callTool('list_models');
      const model = parse(res).models[0];
      expect(model.id).toBe('model-1');
      expect(model.selectable).toBe(true);
      expect(model.effectivePricing).toEqual({ inPerMTok: 1, outPerMTok: 2, currency: 'USD' });
      expect(model.validationStatus).toBe('passed');
    });

    it('sync_models syncs one provider when providerId is given', async () => {
      const res = await callTool('sync_models', { providerId: 'prov-1' });
      expect(mockModelCatalogService.syncFromProvider).toHaveBeenCalledWith('org-1', 'prov-1', 'user-1');
      expect(mockModelCatalogService.syncAll).not.toHaveBeenCalled();
      expect(parse(res).created[0].id).toBe('model-1');
      expect(parse(res).skipped).toBe(3);
    });

    it('sync_models syncs every active provider when providerId is omitted', async () => {
      const res = await callTool('sync_models');
      expect(mockModelCatalogService.syncAll).toHaveBeenCalledWith('org-1', 'user-1');
      expect(parse(res).providers).toEqual(['prov-1']);
    });

    it('validate_model runs the gate to selectability and returns the outcome', async () => {
      const res = await callTool('validate_model', { modelId: 'model-1' });
      expect(mockModelCatalogService.validate).toHaveBeenCalledWith('org-1', 'model-1', 'user-1');
      expect(parse(res).passed).toBe(true);
      expect(parse(res).latencyMs).toBe(120);
      expect(parse(res).model.selectable).toBe(true);
    });

    it('validate_model surfaces a failed run with the provider error', async () => {
      mockModelCatalogService.validate.mockResolvedValueOnce({
        passed: false, error: 'model not found', latencyMs: 40, model: modelCard({ validationStatus: 'failed', selectable: false }),
      });
      const res = await callTool('validate_model', { modelId: 'model-1' });
      expect(parse(res).passed).toBe(false);
      expect(parse(res).error).toBe('model not found');
      expect(parse(res).model.selectable).toBe(false);
    });

    it('preview_model_routing forwards the policy and the calling principal', async () => {
      const res = await callTool('preview_model_routing', {
        objective: 'cheapest', privacyTier: 'private_cloud', regions: ['eu'],
        capabilities: { tools: true }, connectionPreference: ['openai'],
      });
      expect(mockModelRouterService.preview).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({
          objective: 'cheapest', privacyTier: 'private_cloud', regions: ['eu'],
          capabilities: { tools: true }, connectionPreference: ['openai'],
        }),
        { id: 'user-1' },
      );
      expect(parse(res).rejected[0].reason).toBe('privacy tier too public');
    });

    it('list_model_deployments returns the masked public view, not the raw row', async () => {
      const res = await callTool('list_model_deployments');
      expect(mockModelDeploymentsService.list).toHaveBeenCalledWith('org-1');
      expect(parse(res).deployments[0].providerConfig).toEqual({ apiKey: '********' });
    });

    it('list_model_versions returns the pinned registry URI per version', async () => {
      const res = await callTool('list_model_versions');
      expect(mockModelVersionsService.list).toHaveBeenCalledWith('org-1');
      expect(parse(res).versions[0].registryUri).toBe('hf://org/repo@sha');
    });
  });

  describe('tools/call — connections and credentials', () => {
    const callTool = (name: string, args: any = {}) => call('tools/call', { name, arguments: args });
    const parse = (res: any) => JSON.parse(res.result.content[0].text);

    it('list_connectors returns field names only, never values or the raw schema', async () => {
      const res = await callTool('list_connectors', { kind: 'inference' });
      expect(mockConnectionsService.describeConnectors).toHaveBeenCalledWith('org-1', 'inference');
      const connector = parse(res).connectors[0];
      expect(connector.key).toBe('openai');
      expect(connector.connect[0]).toEqual({
        type: 'api_key', label: 'API key', fields: ['apiKey'], required: ['apiKey'],
      });
      expect(JSON.stringify(connector)).not.toContain('sk-live');
    });

    it('list_connections loads real memberships instead of forging a principal', async () => {
      const res = await callTool('list_connections');
      expect(mockUsersService.findOne).toHaveBeenCalledWith('user-1');
      expect(mockConnectionsService.list).toHaveBeenCalledWith(
        { id: 'user-1', organizationMemberships: [{ organizationId: 'org-1', role: 'admin' }] },
        'org-1',
      );
      expect(parse(res).connections[0].id).toBe('conn-1');
    });

    it('start_connection never forwards an input payload', async () => {
      const res = await callTool('start_connection', {
        connectorKey: 'github', method: 'oauth2_pkce', owner: 'org', mode: 'headless', name: 'GitHub',
        // Even if a caller invents one, the tool has no input parameter.
        input: { apiKey: 'sk-live-should-never-travel' },
      });
      expect(mockConnectionsService.connect).toHaveBeenCalledWith(
        { id: 'user-1', organizationMemberships: [{ organizationId: 'org-1', role: 'admin' }] },
        'org-1',
        'github',
        { method: 'oauth2_pkce', owner: 'org', mode: 'headless', name: 'GitHub' },
      );
      const forwarded = mockConnectionsService.connect.mock.calls[0][3];
      expect(forwarded).not.toHaveProperty('input');
      expect(parse(res).authorizeUrl).toBe('https://github.com/login/oauth/authorize?x=1');
    });

    it('start_connection surfaces the connector field list when a form method refuses', async () => {
      mockConnectionsService.connect.mockRejectedValueOnce(new Error('apiKey is required'));
      const res = await callTool('start_connection', { connectorKey: 'openai', method: 'api_key' });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('apiKey is required');
    });

    it('complete_connection exchanges the state and code and echoes no secret', async () => {
      const res = await callTool('complete_connection', { state: 'st-1', code: 'auth-code-1' });
      expect(mockConnectionsService.complete).toHaveBeenCalledWith('st-1', 'auth-code-1');
      expect(parse(res).id).toBe('conn-1');
      expect(JSON.stringify(parse(res))).not.toContain('auth-code-1');
    });

    it('list_connection_grants lists who may use a connection', async () => {
      const res = await callTool('list_connection_grants', { connectionId: 'conn-1' });
      expect(mockGrantsService.list).toHaveBeenCalledWith(
        'conn-1',
        { id: 'user-1', organizationMemberships: [{ organizationId: 'org-1', role: 'admin' }] },
        'org-1',
      );
      expect(parse(res).grants[0].principalType).toBe('agent');
    });

    it('grant_connection binds a principal with the DTO fields and defaults budget/expiry to null', async () => {
      const res = await callTool('grant_connection', {
        connectionId: 'conn-1', principalType: 'agent', principalId: 'agent-1',
      });
      expect(mockGrantsService.grant).toHaveBeenCalledWith(
        'conn-1',
        { principalType: 'agent', principalId: 'agent-1', permission: undefined, budgetId: null, expiresAt: null },
        { id: 'user-1', organizationMemberships: [{ organizationId: 'org-1', role: 'admin' }] },
        'org-1',
      );
      expect(parse(res).id).toBe('grant-1');
    });

    it('list_credentials returns masked rows and no secret value', async () => {
      const res = await callTool('list_credentials');
      expect(mockCredentialsService.findAll).toHaveBeenCalledWith({ id: 'user-1' }, 'org-1');
      const row = parse(res).credentials[0];
      expect(row.id).toBe('cred-1');
      expect(row.connectorKey).toBe('openai');
      expect(JSON.stringify(row)).not.toContain('sk-live');
    });
  });

  describe('tools/call — runners, organization, cost, analytics', () => {
    const callTool = (name: string, args: any = {}) => call('tools/call', { name, arguments: args });
    const parse = (res: any) => JSON.parse(res.result.content[0].text);

    it('list_runners returns the fleet and the workspaces open on it', async () => {
      const res = await callTool('list_runners');
      expect(mockRunnerService.listForOwner).toHaveBeenCalledWith('user-1', 'org-1');
      expect(mockWorkspaceService.listForOwner).toHaveBeenCalledWith('user-1', 'org-1');
      expect(parse(res).runners[0].state).toBe('online');
      expect(parse(res).workspaces[0].cwd).toBe('/home/me/project');
    });

    it('list_org_members returns roles for the calling org only', async () => {
      const res = await callTool('list_org_members');
      expect(mockOrganizationsService.getMembers).toHaveBeenCalledWith('org-1', 'user-1');
      expect(parse(res).members[0].role).toBe('owner');
    });

    it('list_budgets shows the ceiling and what a breach does', async () => {
      const res = await callTool('list_budgets');
      expect(mockBudgetsService.list).toHaveBeenCalledWith('org-1');
      expect(parse(res).budgets[0]).toMatchObject({ limitCents: 5000, behavior: 'reject' });
    });

    it('get_spend defaults to the month and the day bucket', async () => {
      const res = await callTool('get_spend');
      expect(mockSpendService.getSummary).toHaveBeenCalledWith('org-1', {
        from: expect.any(Date), granularity: 'day',
      });
      expect(parse(res).period).toBe('month');
      expect(parse(res).totalCents).toBe(1234);
    });

    it('get_spend honours period=day', async () => {
      await callTool('get_spend', { period: 'day', granularity: 'week' });
      const opts = mockSpendService.getSummary.mock.calls[0][1];
      expect(opts.granularity).toBe('week');
      expect(opts.from.getTime()).toBe(Date.UTC(
        opts.from.getUTCFullYear(), opts.from.getUTCMonth(), opts.from.getUTCDate(),
      ));
    });

    it('get_analytics routes each report to its own source', async () => {
      await callTool('get_analytics', { report: 'overview' });
      expect(mockAnalyticsService.getOverview).toHaveBeenCalledWith('org-1');

      await callTool('get_analytics', { report: 'tools', timeframe: '30d' });
      expect(mockAnalyticsService.getToolUsage).toHaveBeenCalledWith('org-1', '30d');

      await callTool('get_analytics', { report: 'gateways' });
      expect(mockAnalyticsService.getGatewayUsage).toHaveBeenCalledWith('org-1', '7d');

      await callTool('get_analytics', { report: 'models' });
      expect(mockAnalyticsService.getLlmUsage).toHaveBeenCalledWith('org-1', '7d');

      await callTool('get_analytics', { report: 'agent_runs' });
      expect(mockAnalyticsService.getAgentRunsSummary).toHaveBeenCalledWith('org-1');
    });

    it('get_analytics alerts returns the org-scoped alert roster', async () => {
      const res = await callTool('get_analytics', { report: 'alerts' });
      expect(mockMonitoringService.getActiveAlerts).toHaveBeenCalledWith('org-1');
      expect(parse(res).total).toBe(1);
    });

    it('get_analytics routing_failures reports the rate and flags a thin sample as not reportable', async () => {
      const res = await callTool('get_analytics', { report: 'routing_failures' });
      const parsed = parse(res);
      expect(parsed.windowDays).toBe(30);
      expect(parsed.minimumRequests).toBe(30);
      expect(parsed.perAgent[0]).toMatchObject({
        agentId: 'agent-1', comparableRequests: 2, allModelFailureRate: 0.5, reportable: false,
      });
    });

    it('get_analytics clamps a nonsense routing window to the default', async () => {
      const res = await callTool('get_analytics', { report: 'routing_failures', days: -5 });
      expect(parse(res).windowDays).toBe(30);
      const capped = await callTool('get_analytics', { report: 'routing_failures', days: 5000 });
      expect(parse(capped).windowDays).toBe(90);
    });

    it('get_analytics refuses an unknown report rather than answering something else', async () => {
      const res = await callTool('get_analytics', { report: 'made_up' });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('Unknown analytics report');
    });
  });

  describe('tools/call — tool hub and approvals', () => {
    const callTool = (name: string, args: any = {}) => call('tools/call', { name, arguments: args });
    const parse = (res: any) => JSON.parse(res.result.content[0].text);

    it('list_tool_templates forwards the catalog filters', async () => {
      const res = await callTool('list_tool_templates', { provider: 'stripe', search: 'charge', page: 2, limit: 5 });
      expect(mockToolHubService.listTemplates).toHaveBeenCalledWith(
        { category: undefined, provider: 'stripe', search: 'charge', page: 2, limit: 5 },
        'org-1',
      );
      expect(parse(res).templates[0].id).toBe('tpl-1');
    });

    it('install_tool_template binds a stored credential id, not a secret', async () => {
      const res = await callTool('install_tool_template', { templateId: 'tpl-1', credentialId: 'cred-1' });
      expect(mockToolHubService.installTemplate).toHaveBeenCalledWith('tpl-1', 'org-1', 'user-1', {
        existingApiId: undefined, credentialId: 'cred-1',
      });
      expect(parse(res).api.id).toBe('api-1');
    });

    it('list_approvals returns the runs waiting on a decision', async () => {
      const res = await callTool('list_approvals');
      expect(mockApprovalsService.listPending).toHaveBeenCalledWith({
        organizationId: 'org-1', caller: { id: 'user-1' },
      });
      expect(parse(res).approvals[0].runId).toBe('run-1');
    });

    it('decide_approval approves by default and records the caller as the decider', async () => {
      const res = await callTool('decide_approval', { approvalId: 'appr-1', decision: 'approve', reason: 'looks fine' });
      expect(mockApprovalsService.approve).toHaveBeenCalledWith(
        'appr-1', { decidedBy: 'user-1', decisionReason: 'looks fine' }, { id: 'user-1' }, 'org-1',
      );
      expect(mockApprovalsService.reject).not.toHaveBeenCalled();
      expect(parse(res).status).toBe('approved');
    });

    it('decide_approval rejects when asked to', async () => {
      const res = await callTool('decide_approval', { approvalId: 'appr-1', decision: 'reject' });
      expect(mockApprovalsService.reject).toHaveBeenCalledWith(
        'appr-1', { decidedBy: 'user-1', decisionReason: undefined }, { id: 'user-1' }, 'org-1',
      );
      expect(mockApprovalsService.approve).not.toHaveBeenCalled();
      expect(parse(res).status).toBe('rejected');
    });
  });

  describe('tools/list — the newly covered surfaces are advertised', () => {
    it('advertises one tool per surface that used to be invisible', async () => {
      const res = await call('tools/list');
      const names = res.result.tools.map((t: any) => t.name);
      for (const name of [
        'list_models', 'sync_models', 'validate_model', 'preview_model_routing',
        'list_model_deployments', 'list_model_versions',
        'list_connectors', 'list_connections', 'start_connection', 'complete_connection',
        'list_connection_grants', 'grant_connection', 'list_credentials',
        'list_runners', 'list_org_members', 'list_budgets', 'get_spend',
        'get_analytics', 'list_tool_templates', 'install_tool_template',
        'list_approvals', 'decide_approval',
      ]) {
        expect(names).toContain(name);
      }
    });

    it('never offers a raw secret as a tool parameter', async () => {
      const res = await call('tools/list');
      const secretish = /^(apiKey|api_key|secret|clientSecret|password|token|accessToken|refreshToken|botToken|signingSecret)$/;
      const offenders: string[] = [];
      for (const tool of res.result.tools) {
        // Tools that predate this pass and already take a platform
        // credential keep doing so; the surfaces added here must not.
        if (['add_provider', 'create_api', 'update_api', 'add_distribution'].includes(tool.name)) continue;
        for (const prop of Object.keys(tool.inputSchema?.properties ?? {})) {
          if (secretish.test(prop)) offenders.push(`${tool.name}.${prop}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
