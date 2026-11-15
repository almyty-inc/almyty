import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { getMetadataArgsStorage } from 'typeorm';
import { AgentsService } from '../agents.service';
import { AgentAuditService } from '../agent-audit.service';
import { AgentValidationHelper } from '../agent-validation.helper';
import { AgentReadinessService } from '../agent-readiness.service';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution } from '../../../entities/agent-execution.entity';
import { Organization } from '../../../entities/organization.entity';
import { User } from '../../../entities/user.entity';
import { AgentChannelsService } from '../../agent-channels/agent-channels.service';
import { DUPLICATE_COPIED, DUPLICATE_NOT_COPIED, duplicateAgentFields } from '../agent-duplicate';

/**
 * POST /agents and PATCH /agents/:id keep every model setting the caller
 * sends, and POST /agents/:id/duplicate makes an agent that behaves like
 * its original. A staging model comparison (2026-11-13) found both wrong:
 * create dropped `modelConfig.maxTokens` when `models` came along, and a
 * duplicate lost its mode, instructions, model, memory, tools and check.
 */

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const TOOL_A = '22222222-2222-4222-8222-222222222222';
const TOOL_B = '33333333-3333-4333-8333-333333333333';

function setup() {
  const rows = new Map<string, any>();
  let n = 0;
  const agentRepo: any = {
    create: jest.fn((row: any) => ({ ...row })),
    save: jest.fn(async (row: any) => {
      const saved = { ...row, id: row.id ?? `agent-new-${++n}` };
      rows.set(saved.id, saved);
      return saved;
    }),
    findOne: jest.fn(async (opts: any) => (opts?.where?.id ? rows.get(opts.where.id) ?? null : null)),
    update: jest.fn(async (id: string, patch: any) => rows.set(id, { ...rows.get(id), ...patch })),
    manager: {
      getRepository: jest.fn(() => ({
        find: jest.fn(async (opts: any) => {
          const ids = opts?.where?.id?.value ?? [];
          return ids.map((id: string) => ({ id, organizationId: 'org-1', visibility: 'org', ownerUserId: null, createdBy: null, isActive: true }));
        }),
        findOne: jest.fn(async (opts: any) => ({ id: opts?.where?.id, organizationId: 'org-1', visibility: 'org', isActive: true })),
      })),
    },
  };
  return { rows, agentRepo };
}

async function serviceWith(agentRepo: any): Promise<AgentsService> {
  const module = await Test.createTestingModule({
    providers: [
      AgentsService,
      { provide: getRepositoryToken(Agent), useValue: agentRepo },
      { provide: getRepositoryToken(AgentExecution), useValue: {} },
      { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn(async () => ({ id: 'org-1' })) } },
      { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
      { provide: AgentAuditService, useValue: { log: jest.fn() } },
      AgentValidationHelper,
      { provide: AgentReadinessService, useValue: { assertReady: jest.fn(), inspect: jest.fn() } },
      {
        provide: AccessPolicyService,
        useValue: {
          canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
          assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: AgentChannelsService, useValue: { removeAllOf: jest.fn() } },
    ],
  }).compile();
  return module.get(AgentsService);
}

const ALL_MODEL_SETTINGS = {
  providerId: PROVIDER,
  model: 'claude-opus-5-5',
  temperature: 0.3,
  maxTokens: 16000,
  compaction: { enabled: true, maxContextTokens: 60000, keepRecentMessages: 6, strategy: 'summarize' as const },
};

describe('creating and updating an agent keeps every model setting sent', () => {
  it('create with models and modelConfig: maxTokens, temperature and compaction all land on the agent and its main role', async () => {
    const { agentRepo } = setup();
    const service = await serviceWith(agentRepo);
    const saved = await service.createAgent(
      {
        name: 'Digest',
        mode: 'autonomous',
        instructions: 'List new works.',
        // The main role names the model only, as the report's script sent it.
        models: { strategy: 'single', roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: PROVIDER, model: 'claude-opus-5-5' }] },
        modelConfig: ALL_MODEL_SETTINGS as any,
      },
      'org-1',
      'user-1',
    );
    expect(saved.modelConfig).toEqual(ALL_MODEL_SETTINGS);
    const main = saved.models!.roles.find((r) => r.purpose === 'main') as any;
    expect(main).toMatchObject({ providerId: PROVIDER, model: 'claude-opus-5-5', temperature: 0.3, maxTokens: 16000 });
  });

  it('create with modelConfig alone makes the main role from every setting', async () => {
    const { agentRepo } = setup();
    const service = await serviceWith(agentRepo);
    const saved = await service.createAgent({ name: 'Digest', mode: 'autonomous', modelConfig: ALL_MODEL_SETTINGS as any }, 'org-1', 'user-1');
    expect(saved.modelConfig).toEqual(ALL_MODEL_SETTINGS);
    expect(saved.models!.roles[0]).toMatchObject({ purpose: 'main', providerId: PROVIDER, model: 'claude-opus-5-5', temperature: 0.3, maxTokens: 16000 });
  });

  it('create with the same setting twice and two values is refused, naming it, rather than one of them dropped', async () => {
    const { agentRepo } = setup();
    const service = await serviceWith(agentRepo);
    const refusal = await service
      .createAgent(
        {
          name: 'Digest',
          mode: 'autonomous',
          models: { strategy: 'single', roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: PROVIDER, model: 'claude-opus-5-5', maxTokens: 4000 }] },
          modelConfig: { providerId: PROVIDER, model: 'claude-opus-5-5', maxTokens: 16000 },
        },
        'org-1',
        'user-1',
      )
      .catch((e) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect(refusal.message).toContain('maxTokens');
    expect(agentRepo.save).not.toHaveBeenCalled();
  });

  it('update with models and modelConfig behaves as create does', async () => {
    const { agentRepo, rows } = setup();
    const service = await serviceWith(agentRepo);
    rows.set('agent-1', {
      id: 'agent-1',
      name: 'Digest',
      organizationId: 'org-1',
      mode: 'autonomous',
      status: AgentStatus.DRAFT,
      version: '1.0.0',
      metadata: {},
      models: { strategy: 'single', roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: PROVIDER, model: 'gpt-4.1-mini' }] },
      modelConfig: { providerId: PROVIDER, model: 'gpt-4.1-mini' },
    });
    const saved = await service.updateAgent(
      'agent-1',
      {
        models: { strategy: 'single', roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: PROVIDER, model: 'claude-opus-5-5' }] },
        modelConfig: ALL_MODEL_SETTINGS as any,
      },
      'org-1',
    );
    expect(saved.modelConfig).toEqual(ALL_MODEL_SETTINGS);
    expect((saved.models!.roles[0] as any).maxTokens).toBe(16000);
  });

  it('update with models alone still moves modelConfig, a cleared setting included', async () => {
    const { agentRepo, rows } = setup();
    const service = await serviceWith(agentRepo);
    rows.set('agent-1', {
      id: 'agent-1',
      name: 'Digest',
      organizationId: 'org-1',
      mode: 'autonomous',
      status: AgentStatus.DRAFT,
      version: '1.0.0',
      metadata: {},
      models: { strategy: 'single', roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: PROVIDER, model: 'm', maxTokens: 900 }] },
      modelConfig: { providerId: PROVIDER, model: 'm', maxTokens: 900 },
    });
    const saved = await service.updateAgent(
      'agent-1',
      { models: { strategy: 'single', roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: PROVIDER, model: 'm' }] } },
      'org-1',
    );
    expect(saved.modelConfig).toEqual({ providerId: PROVIDER, model: 'm' });
  });
});

/** An agent with every setting a person can give it, and a history of its own. */
function fullyConfigured(): Agent {
  return Object.assign(new Agent(), {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Research digest',
    description: 'New works each morning',
    organizationId: 'org-1',
    visibility: 'team',
    teamId: 'team-1',
    apiGatewayId: 'gw-1',
    apiAccessScope: 'team',
    apiAccessTeamId: 'team-1',
    status: AgentStatus.ACTIVE,
    version: '1.4.0',
    pipeline: { nodes: [], edges: [] },
    variables: { topic: 'quantum chemistry' },
    settings: {
      execution: { strategyKey: 'single' },
      budgetLimit: 5,
      maxExecutionTime: 120,
      schedule: { enabled: true, kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin', input: { message: 'go' }, deliverTo: { channelId: 'ch-1' }, pausedReason: 'x', createdAt: '2026-11-01T00:00:00Z' },
      modelIssue: { code: 'MODEL_NOT_FOUND', message: 'gone', detectedAt: '2026-11-02T00:00:00Z' },
    },
    metadata: { versions: [{ version: '1.3.0' }], auditLog: [{ at: 'x' }] },
    mode: 'autonomous',
    instructions: 'Search OpenAlex. Leave out what you already reported.',
    personality: 'Terse.',
    alwaysOn: {
      enabled: true,
      brief: 'Watch for new works.',
      wakeOn: { timer: { everyMinutes: 60 }, channelIds: ['ch-1'], connectionEvents: [] },
      ownerChannel: { channelId: 'ch-1' },
      actMode: 'act',
      askFirstToolIds: [TOOL_B],
      reportTo: { channelId: 'ch-1' },
      report: 'when_news',
      maxWakesPerHour: 4,
      standingConversationId: 'conv-1',
      liveRunId: 'run-1',
      enabledAt: '2026-11-01T00:00:00Z',
    },
    toolIds: [TOOL_A, TOOL_B],
    modelConfig: { ...ALL_MODEL_SETTINGS },
    memoryConfig: { enabled: true, whose: 'agent', save: 'facts', neverSave: 'emails', retentionDays: 30 },
    agentConfig: {
      apiIds: [],
      toolMode: 'direct',
      verify: { enabled: true, checkers: [{ name: 'c', providerId: PROVIDER, model: 'claude-haiku-4-5', maxTokens: 2000 }], policy: 'all_pass', spec: 'Every item exists.' },
      constraints: { enabled: true, autoLearn: false },
    },
    isTemporary: false,
    parentRunId: null,
    collaboration: null,
    models: {
      strategy: 'single',
      roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: PROVIDER, model: 'claude-opus-5-5', temperature: 0.3, maxTokens: 16000 }],
    },
    branding: { name: 'Digest', primaryColor: '#7C3AED' },
    visitorRules: { signIn: 'required' },
    webhookUrl: 'https://hooks.example.com/digest',
    totalExecutions: 46,
    successfulExecutions: 40,
    checkedExecutions: 30,
    passedCheckExecutions: 20,
    totalCost: 3.2,
    averageExecutionTime: 20000,
    lastExecutedAt: new Date('2026-11-13T00:00:00Z'),
    createdBy: 'user-2',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-11-13T00:00:00Z'),
  } as any);
}

describe('duplicating an agent', () => {
  it('names every column of agents once: copied, or left behind with a reason', () => {
    const columns = getMetadataArgsStorage()
      .columns.filter((c) => c.target === Agent)
      .map((c) => c.propertyName)
      .sort();
    const decided = [...DUPLICATE_COPIED, ...DUPLICATE_NOT_COPIED].sort();
    expect(decided).toEqual(columns);
    expect(new Set(decided).size).toBe(decided.length);
  });

  it('copies every field that defines how it behaves, and none of its identity, keys, channels or history', async () => {
    const { agentRepo, rows } = setup();
    const service = await serviceWith(agentRepo);
    const original = fullyConfigured();
    const before = JSON.parse(JSON.stringify(original));

    const copy = await service.duplicateAgent(original, 'org-1', 'user-1');
    const stored = rows.get(copy.id);

    // The copy as returned and as stored say the same.
    for (const f of DUPLICATE_COPIED) expect(JSON.stringify(stored[f] ?? null)).toBe(JSON.stringify((copy as any)[f] ?? null));

    // Copied as they are.
    const same = ['description', 'visibility', 'teamId', 'pipeline', 'variables', 'mode', 'instructions', 'personality', 'toolIds', 'modelConfig', 'memoryConfig', 'agentConfig', 'collaboration', 'models', 'branding', 'visitorRules'] as const;
    for (const f of same) expect({ [f]: stored[f] }).toEqual({ [f]: (original as any)[f] });
    // The answer check and every model setting in particular.
    expect(stored.agentConfig.verify).toEqual(original.agentConfig.verify);
    expect(stored.modelConfig.maxTokens).toBe(16000);
    expect(stored.models.roles[0].maxTokens).toBe(16000);

    // Settings: the schedule's timing and input, off, without the original's delivery and history.
    expect(stored.settings).toEqual({
      execution: { strategyKey: 'single' },
      budgetLimit: 5,
      maxExecutionTime: 120,
      schedule: { enabled: false, kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin', input: { message: 'go' } },
    });
    // Always on: its brief and rules, off, without the original's channels and standing thread.
    expect(stored.alwaysOn).toMatchObject({
      enabled: false,
      brief: 'Watch for new works.',
      wakeOn: { timer: { everyMinutes: 60 }, channelIds: [], connectionEvents: [] },
      ownerChannel: null,
      actMode: 'act',
      askFirstToolIds: [TOOL_B],
      reportTo: null,
      report: 'when_news',
      maxWakesPerHour: 4,
    });
    for (const k of ['standingConversationId', 'liveRunId', 'enabledAt', 'pausedReason']) expect(stored.alwaysOn).not.toHaveProperty(k);

    // Not copied: a new name, a draft at 1.0.0 owned by the caller, no keys, webhook, statistics or history.
    expect(stored.name).toBe('Copy of Research digest');
    expect(stored.status).toBe(AgentStatus.DRAFT);
    expect(stored.version).toBe('1.0.0');
    expect(stored.createdBy).toBe('user-1');
    expect(stored.id).not.toBe(original.id);
    for (const f of ['apiGatewayId', 'apiAccessScope', 'apiAccessTeamId', 'webhookUrl', 'totalExecutions', 'successfulExecutions', 'checkedExecutions', 'passedCheckExecutions', 'totalCost', 'averageExecutionTime', 'lastExecutedAt']) {
      expect(stored[f] ?? null).not.toEqual((original as any)[f]);
    }
    expect(stored.metadata).toEqual({});

    // The original is untouched, and the copy shares no object with it.
    expect(JSON.parse(JSON.stringify(original))).toEqual(before);
    stored.agentConfig.verify.checkers[0].model = 'changed';
    expect(original.agentConfig.verify!.checkers[0].model).toBe('claude-haiku-4-5');
  });

  it('a workflow agent keeps its graph and has no models', () => {
    const original = Object.assign(fullyConfigured(), { mode: 'workflow', models: null, pipeline: { nodes: [{ id: 'input_1', type: 'input' }], edges: [] } });
    const fields = duplicateAgentFields(original, 'Copy of X');
    expect(fields.mode).toBe('workflow');
    expect(fields.pipeline).toEqual(original.pipeline);
    expect(fields.models).toBeNull();
  });
});
