import { BadRequestException } from '@nestjs/common';

import { Agent } from '../../../entities/agent.entity';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Tool } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { AgentsService } from '../agents.service';
import { AgentModels, agentModelsProblems, missingSlots, syncMainRole, unusedPurposes } from '../autonomous-models';
import { teamOf } from '../autonomous-team';
import { withholdsCandidateAnswers, composesFinalAnswer } from '../final-answer';

const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p1', model: 'claude-sonnet-5', temperature: 0.2 } as const;
const DRAFTER = { key: 'drafter', name: 'Drafter', purpose: 'drafter', kind: 'model', providerId: 'p1', model: 'gpt-4o-mini' } as const;
const CHECKER = { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', routing: { objective: 'cheapest' } } as const;

describe('agentModelsProblems', () => {
  it('accepts every strategy once its slots are filled, and no models at all', () => {
    expect(agentModelsProblems(null)).toEqual([]);
    expect(agentModelsProblems(undefined)).toEqual([]);
    expect(agentModelsProblems({ strategy: 'single', roles: [MAIN] })).toEqual([]);
    expect(agentModelsProblems({ strategy: 'cascade', roles: [MAIN, DRAFTER, CHECKER] })).toEqual([]);
    expect(agentModelsProblems({ strategy: 'best_of_n', roles: [MAIN, CHECKER], candidates: 4 })).toEqual([]);
    expect(
      agentModelsProblems({
        strategy: 'panel',
        roles: [
          MAIN,
          { key: 'p1', name: 'A', purpose: 'panelist', kind: 'model', providerId: 'p1' },
          { key: 'p2', name: 'B', purpose: 'panelist', kind: 'agent', agentId: 'agent-2' },
        ],
      }),
    ).toEqual([]);
    expect(
      agentModelsProblems({
        strategy: 'explore_extract_patch',
        roles: [
          MAIN,
          CHECKER,
          { key: 'explorer', name: 'Explorer', purpose: 'explorer', kind: 'model', providerId: 'p1' },
          { key: 'summariser', name: 'Summariser', purpose: 'summariser', kind: 'model', providerId: 'p1' },
        ],
      }),
    ).toEqual([]);
  });

  it('names the slots a strategy is missing', () => {
    expect(agentModelsProblems({ strategy: 'cascade', roles: [MAIN] })).toEqual([
      'Cascade needs a drafter role',
      'Cascade needs a checker role',
    ]);
    expect(missingSlots({ strategy: 'panel', roles: [MAIN, { key: 'p', name: 'P', purpose: 'panelist', kind: 'model', providerId: 'p1' }] })).toEqual([
      'Panel needs at least 2 panelist roles (has 1)',
    ]);
    expect(agentModelsProblems({ strategy: 'single', roles: [] })).toEqual(['Single needs a main role']);
  });

  it('refuses an agent anywhere but a panelist or teammate', () => {
    expect(
      agentModelsProblems({ strategy: 'cascade', roles: [MAIN, DRAFTER, { key: 'checker', name: 'Critic', purpose: 'checker', kind: 'agent', agentId: 'a2' }] }),
    ).toEqual(['Critic is another agent, and a checker has to be a model: only panelists and teammates can be agents']);
  });

  it('refuses a model role with nothing to call, bad sampling, duplicate keys, two mains, and a bad N', () => {
    const problems = agentModelsProblems({
      strategy: 'best_of_n',
      candidates: 9,
      roles: [
        MAIN,
        { ...MAIN, name: 'Other main' },
        { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', model: 'o4-mini', temperature: 3, maxTokens: 0 },
      ],
    });
    expect(problems).toEqual([
      'models.roles[1].key "main" is used by another role',
      'Checker needs a provider or a routing policy',
      'Checker: temperature must be a number from 0 to 2',
      'Checker: max tokens must be a positive whole number',
      'There are 2 main roles; there can be one',
      'models.candidates must be a whole number from 2 to 5',
    ]);
  });

  it('refuses a strategy the engine does not run', () => {
    expect(agentModelsProblems({ strategy: 'debate', roles: [MAIN] })).toEqual([
      'models.strategy "debate" is not one of single, cascade, best_of_n, panel, explore_extract_patch',
    ]);
  });

  it('reports purposes the strategy does not read, without refusing them', () => {
    expect(unusedPurposes({ strategy: 'single', roles: [MAIN, DRAFTER, CHECKER] })).toEqual(['drafter', 'checker']);
    expect(unusedPurposes({ strategy: 'panel', roles: [MAIN, CHECKER] })).toEqual([]);
    expect(agentModelsProblems({ strategy: 'single', roles: [MAIN, DRAFTER] })).toEqual([]);
  });
});

describe('syncMainRole: the main role and modelConfig say the same thing', () => {
  it('a models write moves modelConfig, keeping its other keys and dropping a cleared field', () => {
    const { modelConfig } = syncMainRole({
      models: { strategy: 'single', roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p2', model: 'gpt-4o' }] },
      modelConfig: { providerId: 'p1', model: 'claude-sonnet-5', temperature: 0.2, compaction: { enabled: true } },
      modelsWritten: true,
    });
    expect(modelConfig).toEqual({ providerId: 'p2', model: 'gpt-4o', compaction: { enabled: true } });
  });

  it('a modelConfig-only write moves the main role and leaves the other roles alone', () => {
    const { models } = syncMainRole({
      models: { strategy: 'cascade', roles: [MAIN, DRAFTER, CHECKER] },
      modelConfig: { providerId: 'p9', model: 'claude-opus-5', maxTokens: 2000 },
      modelsWritten: false,
    });
    expect(models!.roles).toEqual([
      { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p9', model: 'claude-opus-5', maxTokens: 2000 },
      DRAFTER,
      CHECKER,
    ]);
    expect(models!.strategy).toBe('cascade');
  });

  it('an agent with no models gets Single on its modelConfig, and none without a model', () => {
    expect(syncMainRole({ models: null, modelConfig: { routing: { objective: 'fastest' } }, modelsWritten: false }).models).toEqual({
      strategy: 'single',
      roles: [{ key: 'main', name: 'Main', purpose: 'main', kind: 'model', routing: { objective: 'fastest' } }],
    });
    expect(syncMainRole({ models: null, modelConfig: { temperature: 1 }, modelsWritten: false }).models).toBeNull();
  });
});

describe('teamOf', () => {
  it('fills slots from the roles and the main role from modelConfig, so a per-request override applies', () => {
    const team = teamOf({
      models: { strategy: 'cascade', roles: [MAIN, DRAFTER, CHECKER, { key: 'helper', name: 'Helper', purpose: 'teammate', kind: 'agent', agentId: 'a2' }] },
      modelConfig: { providerId: 'p1', model: 'claude-sonnet-5', temperature: 0 },
    });
    expect(team.main).toMatchObject({ key: 'main', providerId: 'p1', model: 'claude-sonnet-5', temperature: 0 });
    expect(team.drafter).toMatchObject({ key: 'drafter', model: 'gpt-4o-mini' });
    expect(team.checker).toMatchObject({ key: 'checker', routing: { objective: 'cheapest' } });
    expect(team.teammates).toEqual([{ key: 'helper', name: 'Helper', purpose: 'teammate', kind: 'agent', agentId: 'a2' }]);
  });

  it('an explorer\'s own run acts as that role alone', () => {
    const team = teamOf(
      {
        models: {
          strategy: 'explore_extract_patch',
          roles: [MAIN, CHECKER, { key: 'explorer', name: 'Explorer', purpose: 'explorer', kind: 'model', providerId: 'p1', model: 'gpt-4o-mini' }, { key: 'summariser', name: 'S', purpose: 'summariser', kind: 'model', providerId: 'p1' }],
        },
        modelConfig: { providerId: 'p1', model: 'claude-sonnet-5' },
      },
      { metadata: { actAs: 'explorer' } },
    );
    expect(team).toMatchObject({ strategy: 'single', main: { key: 'explorer', model: 'gpt-4o-mini' }, teammates: [] });
  });
});

describe('a multi-model strategy holds candidate answers back from a visitor', () => {
  it('withholds for every strategy but Single, and so composes no streamed answer', () => {
    const composing = { metadata: { composeFinalAnswer: true } };
    expect(withholdsCandidateAnswers({ agentConfig: {}, models: { strategy: 'single', roles: [MAIN] } })).toBe(false);
    expect(composesFinalAnswer(composing, { agentConfig: {}, models: { strategy: 'single', roles: [MAIN] } })).toBe(true);
    for (const strategy of ['cascade', 'best_of_n', 'panel', 'explore_extract_patch'] as const) {
      expect(withholdsCandidateAnswers({ agentConfig: {}, models: { strategy, roles: [] } })).toBe(true);
      expect(composesFinalAnswer(composing, { agentConfig: {}, models: { strategy, roles: [] } })).toBe(false);
    }
  });
});

describe('AgentsService saves an autonomous agent\'s models', () => {
  const service = () => {
    const agents = fakeRepository<Agent>({
      make: () => new Agent(),
      idPrefix: 'agent',
      seed: [
        {
          id: 'ag-1',
          name: 'Support',
          organizationId: 'org-1',
          mode: 'autonomous',
          visibility: 'org',
          createdBy: 'user-1',
          metadata: {},
          pipeline: { nodes: [], edges: [] },
          toolIds: [],
          modelConfig: { providerId: 'p1', model: 'claude-sonnet-5', compaction: { enabled: true } },
          models: { strategy: 'cascade', roles: [MAIN, DRAFTER, CHECKER] },
        } as any,
        { id: 'ag-private', name: 'Mine', organizationId: 'org-1', mode: 'autonomous', visibility: 'private', createdBy: 'user-2', metadata: {} } as any,
      ],
    });
    const providers = fakeRepository<LlmProvider>([
      { id: 'p1', organizationId: 'org-1', visibility: 'org', ownerUserId: null },
      { id: 'p-theirs', organizationId: 'org-1', visibility: 'private', ownerUserId: 'user-2' },
    ] as any);
    const tools = fakeRepository<Tool>([]);
    (agents as any).manager = {
      getRepository: (entity: unknown) => (entity === LlmProvider ? providers : entity === Tool ? tools : fakeRepository([])),
    };
    const organizations = fakeRepository([{ id: 'org-1' }]);
    const svc = new AgentsService(
      agents as any,
      {} as any,
      organizations as any,
      {} as any,
      { log: async () => undefined } as any,
      { validatePipeline: () => undefined } as any,
      { assertCanScopeToTeam: async () => undefined } as any,
      { assertReady: async () => undefined } as any,
    );
    return { svc, agents };
  };

  const cascade: AgentModels = { strategy: 'cascade', roles: [MAIN as any, DRAFTER as any, CHECKER as any] };

  it('create: stores the models and mirrors the main role into modelConfig', async () => {
    const { svc, agents } = service();
    const saved = await svc.createAgent({ name: 'New', mode: 'autonomous', models: cascade }, 'org-1', 'user-1');
    const row = agents.row(saved.id)!;
    expect(row.models).toEqual(cascade);
    expect(row.modelConfig).toEqual({ providerId: 'p1', model: 'claude-sonnet-5', temperature: 0.2 });
  });

  it('create: refuses a strategy with an empty slot, naming it, and saves nothing', async () => {
    const { svc, agents } = service();
    const before = agents.rows().length;
    const err = await svc
      .createAgent({ name: 'New', mode: 'autonomous', models: { strategy: 'cascade', roles: [MAIN as any] } }, 'org-1', 'user-1')
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Invalid models: Cascade needs a drafter role; Cascade needs a checker role');
    expect(agents.rows()).toHaveLength(before);
  });

  it('create: a role naming another member\'s private provider is refused like a missing one', async () => {
    const { svc } = service();
    const refusal = async (providerId: string) => {
      const models = { strategy: 'cascade' as const, roles: [MAIN as any, { ...DRAFTER, providerId }, CHECKER as any] };
      const err = await svc.createAgent({ name: 'x', mode: 'autonomous', models }, 'org-1', 'user-1').catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      return String(err.message).replace(providerId, 'ID');
    };
    expect(await refusal('p-theirs')).toBe(await refusal('p-missing'));
  });

  it('create: an agent role pointing at another member\'s private agent is refused', async () => {
    const { svc } = service();
    const models = {
      strategy: 'single' as const,
      roles: [MAIN as any, { key: 'helper', name: 'Helper', purpose: 'teammate', kind: 'agent', agentId: 'ag-private' }],
    };
    const err = await svc.createAgent({ name: 'x', mode: 'autonomous', models } as any, 'org-1', 'user-1').catch((e) => e);
    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/private/i);
  });

  it('update: a client that only writes modelConfig moves the main role, and keeps the strategy', async () => {
    const { svc, agents } = service();
    await svc.updateAgent('ag-1', { modelConfig: { providerId: 'p1', model: 'claude-opus-5' } }, 'org-1', 'user-1');
    const row = agents.row('ag-1')!;
    expect(row.models!.strategy).toBe('cascade');
    expect(row.models!.roles[0]).toEqual({ key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p1', model: 'claude-opus-5' });
    expect(row.models!.roles.slice(1)).toEqual([DRAFTER, CHECKER]);
  });

  it('update: the page\'s models write keeps modelConfig\'s compaction', async () => {
    const { svc, agents } = service();
    await svc.updateAgent('ag-1', { models: { strategy: 'single', roles: [{ ...MAIN, model: 'claude-haiku-5' } as any] } }, 'org-1', 'user-1');
    expect(agents.row('ag-1')!.modelConfig).toEqual({ providerId: 'p1', model: 'claude-haiku-5', temperature: 0.2, compaction: { enabled: true } });
  });

  it('a workflow agent keeps no models: its multi-model shape is its graph', async () => {
    const { svc, agents } = service();
    const saved = await svc.createAgent({ name: 'Flow', mode: 'workflow', models: cascade }, 'org-1', 'user-1');
    expect(agents.row(saved.id)!.models).toBeNull();
  });
});
