import { NotFoundException, HttpException } from '@nestjs/common';

import { AgentTechDocHelper } from '../agent-tech-doc.helper';
import { AgentManagementController } from '../agent-management.controller';

describe('AgentTechDocHelper', () => {
  const ORG = 'org-1';

  const providers = [
    { id: 'p-anthropic', name: 'Anthropic prod', type: 'anthropic' },
    { id: 'p-openai', name: 'OpenAI prod', type: 'openai' },
  ];

  const tools = [
    {
      id: 't-weather',
      name: 'get_weather',
      type: 'api',
      description: 'Fetch a weather forecast',
      api: { name: 'Open-Meteo' },
    },
  ];

  const versionSnapshots = Array.from({ length: 12 }, (_, i) => ({
    version: `1.0.${i}`,
    pipeline: { nodes: [{ id: 'n1' }], edges: [] },
    savedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    changelog: `change ${i}`,
  }));

  const autonomousAgent = () => ({
    id: 'agent-1',
    name: 'Ops Copilot',
    description: 'Handles ops tickets',
    instructions: 'Triage and resolve ops tickets autonomously.',
    mode: 'autonomous',
    status: 'active',
    version: '2.0.0',
    visibility: 'org',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    lastExecutedAt: new Date('2026-06-20T00:00:00Z'),
    pipeline: { nodes: [], edges: [] },
    toolIds: ['t-weather', 't-deleted'],
    modelConfig: { providerId: 'p-anthropic', model: 'claude-sonnet-4', temperature: 0.2, maxTokens: 2048 },
    memoryConfig: { enabled: true, autoSave: true, scopes: ['workspace'] },
    agentConfig: {
      canCallAgents: true,
      canCreateAgents: true,
      verify: {
        enabled: true,
        policy: 'all_pass',
        triggers: ['on_final_output'],
        checkers: [{ name: 'reviewer', providerId: 'p-openai', model: 'gpt-4o', temperature: 0 }],
      },
      constraints: { enabled: true, autoLearn: true },
    },
    settings: { schedule: { enabled: true, intervalMinutes: 30 } },
    webhookUrl: 'https://hooks.example.com/agent-1',
    heartbeat: { enabled: true, intervalMinutes: 15, prompt: 'check queue' },
    metadata: { versions: versionSnapshots },
    totalExecutions: 10,
    successfulExecutions: 9,
    averageExecutionTime: 1200,
    totalCost: 1.23,
  });

  const workflowAgent = () => ({
    id: 'agent-2',
    name: 'Ticket Pipeline',
    description: 'Fixed DAG pipeline',
    instructions: null,
    mode: 'workflow',
    status: 'active',
    version: '1.0.0',
    visibility: 'org',
    createdAt: new Date('2026-02-01T00:00:00Z'),
    updatedAt: new Date('2026-02-02T00:00:00Z'),
    pipeline: {
      nodes: [
        { id: 'in', type: 'input' },
        {
          id: 'llm1',
          type: 'llm_call',
          data: { providerId: 'p-anthropic', model: 'claude-haiku-4', temperature: 0.7, toolIds: ['t-weather'] },
        },
        { id: 'tool1', type: 'tool_call', data: { toolId: 't-weather' } },
        { id: 'v1', type: 'verify', config: { checkers: [{ name: 'node checker', providerId: 'p-openai', model: 'gpt-4o-mini' }] } },
        { id: 'out', type: 'output' },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'llm1' },
        { id: 'e2', source: 'llm1', target: 'tool1' },
        { id: 'e3', source: 'tool1', target: 'v1' },
        { id: 'e4', source: 'v1', target: 'out' },
      ],
    },
    toolIds: [],
    modelConfig: null,
    memoryConfig: null,
    agentConfig: null,
    settings: null,
    webhookUrl: null,
    heartbeat: null,
    metadata: null,
    totalExecutions: 0,
    successfulExecutions: 0,
    averageExecutionTime: 0,
    totalCost: 0,
  });

  const approvalCounts: Record<string, number> = { pending: 1, approved: 2, rejected: 3, expired: 4 };

  let agentsService: { getAgent: jest.Mock };
  let constraintsService: { list: jest.Mock };
  let toolRepo: { find: jest.Mock };
  let providerRepo: { find: jest.Mock };
  let orgRepo: { findOne: jest.Mock };
  let runRepo: { count: jest.Mock };
  let approvalRepo: { count: jest.Mock };
  let fileRepo: { count: jest.Mock };
  let helper: AgentTechDocHelper;

  beforeEach(() => {
    agentsService = { getAgent: jest.fn() };
    constraintsService = {
      list: jest.fn().mockResolvedValue([
        { rule: 'Never delete production data', origin: 'learned', active: true, createdAt: new Date('2026-03-01') },
        { rule: 'Old rule', origin: 'manual', active: false, createdAt: new Date('2026-02-01') },
      ]),
    };
    toolRepo = { find: jest.fn().mockResolvedValue(tools) };
    providerRepo = { find: jest.fn().mockResolvedValue(providers) };
    orgRepo = { findOne: jest.fn().mockResolvedValue({ id: ORG, name: 'Acme Corp' }) };
    runRepo = { count: jest.fn().mockResolvedValue(7) };
    approvalRepo = {
      count: jest.fn().mockImplementation(({ where }) => Promise.resolve(approvalCounts[where.status] ?? 0)),
    };
    fileRepo = { count: jest.fn().mockResolvedValue(3) };

    helper = new AgentTechDocHelper(
      agentsService as any,
      constraintsService as any,
      toolRepo as any,
      providerRepo as any,
      orgRepo as any,
      runRepo as any,
      approvalRepo as any,
      fileRepo as any,
    );
  });

  describe('build — autonomous agent', () => {
    beforeEach(() => {
      agentsService.getAgent.mockResolvedValue(autonomousAgent());
    });

    it('assembles every Annex-IV section', async () => {
      const doc = await helper.build('agent-1', ORG);

      expect(doc.documentType).toBe('agent-technical-documentation');
      expect(doc.generalDescription).toBeDefined();
      expect(doc.modelAndProviders).toBeDefined();
      expect(doc.capabilitiesAndTools).toBeDefined();
      expect(doc.humanOversight).toBeDefined();
      expect(doc.dataGovernance).toBeDefined();
      expect(doc.loggingAndTraceability).toBeDefined();
      expect(doc.changeHistory).toBeDefined();
      expect(doc.disclaimer).toContain('deployer');
    });

    it('fills generalDescription from the agent and organization', async () => {
      const doc = await helper.build('agent-1', ORG);

      expect(doc.generalDescription.name).toBe('Ops Copilot');
      expect(doc.generalDescription.purpose).toBe('Triage and resolve ops tickets autonomously.');
      expect(doc.generalDescription.mode).toBe('autonomous');
      expect(doc.generalDescription.version).toBe('2.0.0');
      expect(doc.generalDescription.organization).toEqual({ id: ORG, name: 'Acme Corp' });
    });

    it('lists the agent-config model plus verify checkers with resolved providers', async () => {
      const doc = await helper.build('agent-1', ORG);

      const sources = doc.modelAndProviders.models.map((m) => m.source);
      expect(sources).toContain('agent config');
      expect(sources.some((s) => s.startsWith('verify checker'))).toBe(true);

      const main = doc.modelAndProviders.models.find((m) => m.source === 'agent config');
      expect(main).toMatchObject({
        providerId: 'p-anthropic',
        providerName: 'Anthropic prod',
        providerType: 'anthropic',
        model: 'claude-sonnet-4',
        temperature: 0.2,
        maxTokens: 2048,
      });
      expect(doc.modelAndProviders.providers).toEqual(
        expect.arrayContaining([
          { id: 'p-anthropic', name: 'Anthropic prod', type: 'anthropic' },
          { id: 'p-openai', name: 'OpenAI prod', type: 'openai' },
        ]),
      );
    });

    it('lists resolved tools with API source and flags unresolved tool ids', async () => {
      const doc = await helper.build('agent-1', ORG);

      expect(doc.capabilitiesAndTools.tools).toEqual([
        {
          id: 't-weather',
          name: 'get_weather',
          type: 'api',
          description: 'Fetch a weather forecast',
          apiSource: 'Open-Meteo',
          referencedBy: ['agent tool list'],
        },
      ]);
      expect(doc.capabilitiesAndTools.unresolvedToolIds).toEqual(['t-deleted']);
    });

    it('exposes built-in tools including request_approval, memory and agent-creation tools', async () => {
      const doc = await helper.build('agent-1', ORG);

      const names = doc.capabilitiesAndTools.builtInTools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(['wait', 'ask_user', 'request_approval', 'store_memory', 'recall_memory', 'create_agent', 'invoke_agent']),
      );
      expect(doc.capabilitiesAndTools.canCallAgents).toBe(true);
      expect(doc.capabilitiesAndTools.canCreateAgents).toBe(true);
      expect(doc.capabilitiesAndTools.pipelineSummary).toBeNull();
    });

    it('reports human oversight: approval availability, history counts, constraints, verification', async () => {
      const doc = await helper.build('agent-1', ORG);

      expect(doc.humanOversight.approvalGate.requestApprovalToolAvailable).toBe(true);
      expect(doc.humanOversight.approvalHistory).toEqual({
        total: 10,
        pending: 1,
        approved: 2,
        rejected: 3,
        expired: 4,
      });
      expect(doc.humanOversight.constraints).toMatchObject({
        promptInjectionEnabled: true,
        autoLearnEnabled: true,
        total: 2,
        active: 1,
      });
      expect(doc.humanOversight.verification).toMatchObject({
        enabled: true,
        policy: 'all_pass',
        checkerCount: 1,
        triggers: ['on_final_output'],
      });
    });

    it('reports data governance: memory, files, webhook, schedule and heartbeat inputs', async () => {
      const doc = await helper.build('agent-1', ORG);

      expect(doc.dataGovernance.memory).toEqual({ enabled: true, autoSave: true, scopes: ['workspace'] });
      expect(doc.dataGovernance.fileAttachments.count).toBe(3);
      expect(doc.dataGovernance.inputs.webhook.configured).toBe(true);
      expect(doc.dataGovernance.inputs.schedule).toEqual({ enabled: true, intervalMinutes: 30 });
      expect(doc.dataGovernance.inputs.heartbeat).toEqual({ enabled: true, intervalMinutes: 15 });
    });

    it('reports logging and traceability including run counts and versioning note', async () => {
      const doc = await helper.build('agent-1', ORG);

      expect(doc.loggingAndTraceability.executions).toMatchObject({
        total: 10,
        successful: 9,
        successRatePercent: 90,
        averageExecutionTimeMs: 1200,
        totalCostUsd: 1.23,
      });
      expect(doc.loggingAndTraceability.autonomousRuns.total).toBe(7);
      expect(doc.loggingAndTraceability.auditLog).toEqual({
        available: true,
        endpoint: '/agents/agent-1/audit-log',
      });
      expect(doc.loggingAndTraceability.entityVersioning.mechanism).toBe('typeorm-versions');
    });

    it('returns the last 10 version snapshots, newest first', async () => {
      const doc = await helper.build('agent-1', ORG);

      expect(doc.changeHistory).toHaveLength(10);
      expect(doc.changeHistory[0].version).toBe('1.0.11');
      expect(doc.changeHistory[9].version).toBe('1.0.2');
      expect(doc.changeHistory[0].nodeCount).toBe(1);
    });
  });

  describe('build — workflow agent', () => {
    beforeEach(() => {
      agentsService.getAgent.mockResolvedValue(workflowAgent());
      constraintsService.list.mockResolvedValue([]);
      runRepo.count.mockResolvedValue(0);
      fileRepo.count.mockResolvedValue(0);
      approvalRepo.count.mockResolvedValue(0);
    });

    it('extracts models from pipeline llm_call nodes and verify-node checkers', async () => {
      const doc = await helper.build('agent-2', ORG);

      const llmEntry = doc.modelAndProviders.models.find((m) => m.source === 'pipeline llm_call node llm1');
      expect(llmEntry).toMatchObject({
        providerId: 'p-anthropic',
        providerName: 'Anthropic prod',
        model: 'claude-haiku-4',
        temperature: 0.7,
      });
      const checkerEntry = doc.modelAndProviders.models.find((m) => m.source.startsWith('verify checker'));
      expect(checkerEntry).toMatchObject({ providerId: 'p-openai', model: 'gpt-4o-mini' });
    });

    it('collects tools from tool_call and llm_call nodes with node-level references', async () => {
      const doc = await helper.build('agent-2', ORG);

      expect(doc.capabilitiesAndTools.tools).toHaveLength(1);
      expect(doc.capabilitiesAndTools.tools[0].id).toBe('t-weather');
      expect(doc.capabilitiesAndTools.tools[0].referencedBy).toEqual(
        expect.arrayContaining(['pipeline tool_call node tool1', 'pipeline llm_call node llm1']),
      );
      expect(doc.capabilitiesAndTools.unresolvedToolIds).toEqual([]);
    });

    it('summarizes the pipeline and marks built-ins/approval gate as unavailable', async () => {
      const doc = await helper.build('agent-2', ORG);

      expect(doc.capabilitiesAndTools.builtInTools).toEqual([]);
      expect(doc.humanOversight.approvalGate.requestApprovalToolAvailable).toBe(false);
      expect(doc.capabilitiesAndTools.pipelineSummary).toEqual({
        nodeCount: 5,
        edgeCount: 4,
        nodeTypes: { input: 1, llm_call: 1, tool_call: 1, verify: 1, output: 1 },
      });
      expect(doc.humanOversight.verification.pipelineVerifyNodes).toBe(1);
      expect(doc.humanOversight.verification.enabled).toBe(true);
    });

    it('handles empty change history', async () => {
      const doc = await helper.build('agent-2', ORG);
      expect(doc.changeHistory).toEqual([]);
    });
  });

  describe('build — missing agent', () => {
    it('propagates NotFoundException from the agent lookup', async () => {
      agentsService.getAgent.mockRejectedValue(new NotFoundException('Agent not found: nope'));
      await expect(helper.build('nope', ORG)).rejects.toThrow(NotFoundException);
    });
  });

  describe('renderMarkdown', () => {
    it('renders every section heading and key facts', async () => {
      agentsService.getAgent.mockResolvedValue(autonomousAgent());
      const doc = await helper.build('agent-1', ORG);
      const md = helper.renderMarkdown(doc);

      expect(md).toContain('# Technical Documentation: Ops Copilot');
      expect(md).toContain('## 1. General Description');
      expect(md).toContain('## 2. Models and Providers');
      expect(md).toContain('## 3. Capabilities and Tools');
      expect(md).toContain('## 4. Human Oversight');
      expect(md).toContain('## 5. Data Governance');
      expect(md).toContain('## 6. Logging and Traceability');
      expect(md).toContain('## 7. Change History');
      expect(md).toContain('## Disclaimer');

      expect(md).toContain('claude-sonnet-4');
      expect(md).toContain('get_weather');
      expect(md).toContain('Open-Meteo');
      expect(md).toContain('request_approval');
      expect(md).toContain('Never delete production data');
    });
  });
});

describe('AgentManagementController — GET :id/technical-documentation', () => {
  const mockRequest = {
    user: { sub: 'user-1', id: 'user-1', currentOrganizationId: 'org-1' },
  };

  const makeController = (techDocHelper: any) =>
    new AgentManagementController(
      {} as any, // agentsService — unused by this endpoint
      {} as any, // runtimeService
      {} as any, // schedulerService
      {} as any, // auditService
      techDocHelper,
    );

  it('returns the structured JSON document', async () => {
    const doc = { documentType: 'agent-technical-documentation' };
    const techDocHelper = { build: jest.fn().mockResolvedValue(doc), renderMarkdown: jest.fn() };
    const controller = makeController(techDocHelper);
    const res = { setHeader: jest.fn() };

    const result = await controller.getTechnicalDocumentation('agent-1', undefined as any, mockRequest, res as any);

    expect(techDocHelper.build).toHaveBeenCalledWith('agent-1', 'org-1');
    expect(result).toEqual({ success: true, data: doc });
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('returns markdown with text/markdown content type when format=markdown', async () => {
    const doc = { documentType: 'agent-technical-documentation' };
    const techDocHelper = {
      build: jest.fn().mockResolvedValue(doc),
      renderMarkdown: jest.fn().mockReturnValue('# Technical Documentation: X'),
    };
    const controller = makeController(techDocHelper);
    const res = { setHeader: jest.fn() };

    const result = await controller.getTechnicalDocumentation('agent-1', 'markdown', mockRequest, res as any);

    expect(techDocHelper.renderMarkdown).toHaveBeenCalledWith(doc);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/markdown; charset=utf-8');
    expect(result).toBe('# Technical Documentation: X');
  });

  it('returns 404 for a missing agent', async () => {
    const techDocHelper = {
      build: jest.fn().mockRejectedValue(new NotFoundException('Agent not found: missing')),
      renderMarkdown: jest.fn(),
    };
    const controller = makeController(techDocHelper);
    const res = { setHeader: jest.fn() };

    await expect(
      controller.getTechnicalDocumentation('missing', undefined as any, mockRequest, res as any),
    ).rejects.toBeInstanceOf(HttpException);

    const err = await controller
      .getTechnicalDocumentation('missing', undefined as any, mockRequest, res as any)
      .then(
        () => null,
        (e: HttpException) => e,
      );
    expect(err).not.toBeNull();
    expect((err as HttpException).getStatus()).toBe(404);
  });

  it('rejects when no organization is on the request', async () => {
    const techDocHelper = { build: jest.fn(), renderMarkdown: jest.fn() };
    const controller = makeController(techDocHelper);
    const res = { setHeader: jest.fn() };

    await expect(
      controller.getTechnicalDocumentation('agent-1', undefined as any, { user: {} }, res as any),
    ).rejects.toMatchObject({ status: 400 });
    expect(techDocHelper.build).not.toHaveBeenCalled();
  });
});
