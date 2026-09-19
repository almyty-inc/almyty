import { AgentReadinessService } from '../agent-readiness.service';
import { AgentValidationHelper } from '../agent-validation.helper';
import { AgentRolesService } from '../agent-roles.service';
import { Agent } from '../../../entities/agent.entity';
import { StrategyCompileError } from '../strategies/strategy-compiler';

const graph = (config: any) => ({
  nodes: [
    { id: 'input', type: 'input', config: {} },
    { id: 'answer', type: 'llm_call', config },
    { id: 'output', type: 'output', config: { mapping: '{{nodes.answer.output}}' } },
  ],
  edges: [{ source: 'input', target: 'answer' }, { source: 'answer', target: 'output' }],
});

describe('Agent model readiness (no provider calls)', () => {
  let service: AgentReadinessService;
  let agent: Agent;
  let router: any;
  let rolesRepo: any;
  let strategies: any;
  let providers: any;
  let organizations: any;
  beforeEach(() => {
    agent = { id: 'agent', organizationId: 'org', mode: 'workflow', settings: { execution: { strategyKey: 'single' } }, pipeline: graph({ routing: { objective: 'cheapest' } }) } as any;
    router = { plan: jest.fn().mockResolvedValue({ candidates: [], rejected: [] }), providerForModelId: jest.fn().mockResolvedValue({ provider: { status: 'active' } }) };
    rolesRepo = { find: jest.fn().mockResolvedValue([{ key: 'principal', binding: { mode: 'resolved', policy: { objective: 'cheapest' } } }]) };
    strategies = { compileStanding: jest.fn().mockResolvedValue(graph({ roleKey: 'principal' })) };
    providers = { findOne: jest.fn().mockResolvedValue({ id: 'provider', status: 'active' }) };
    organizations = { findOne: jest.fn().mockResolvedValue({ settings: {} }) };
    service = new AgentReadinessService(new AgentValidationHelper(), strategies, new AgentRolesService(rolesRepo, router), router, providers, organizations);
  });

  it('reports the empty-catalog screenshot case before activation', async () => {
    const result = await service.inspect(agent, 'user');
    expect(result.ready).toBe(false);
    expect(result.message).toMatch(/principal.*no models are registered/);
    expect(result.message).toContain('Execution tab');
    expect(router.plan).toHaveBeenCalledWith('org', { objective: 'cheapest' }, { id: 'user' });
  });

  it('refuses creating an already-active strategy before its roles can exist', async () => {
    agent.id = undefined as any;
    await expect(service.inspect(agent)).resolves.toMatchObject({ ready: false, message: expect.stringContaining('draft') });
    expect(strategies.compileStanding).not.toHaveBeenCalled();
  });

  it('validates the compiled strategy, not an unused empty saved graph', async () => {
    agent.pipeline = { nodes: [], edges: [] };
    router.plan.mockResolvedValue({ candidates: [{ modelId: 'model' }], rejected: [] });
    await expect(service.inspect(agent)).resolves.toEqual({ ready: true });
  });

  it('checks an orchestrator fallback without asking a model to choose', async () => {
    agent.settings.execution = { orchestrator: { enabled: true, fallbackStrategyKey: 'single' } };
    await service.inspect(agent);
    expect(strategies.compileStanding.mock.calls[0][0].settings.execution.strategyKey).toBe('single');
  });

  it('reports missing roles/invalid strategy with a configuration action', async () => {
    strategies.compileStanding.mockRejectedValue(new StrategyCompileError('Role principal is missing'));
    await expect(service.inspect(agent)).resolves.toMatchObject({ ready: false, message: expect.stringContaining('Execution tab') });
  });

  it('does not mistake an arbitrary pinned UUID for a callable model', async () => {
    rolesRepo.find.mockResolvedValue([{ key: 'principal', binding: { mode: 'pinned', modelId: 'foreign' } }]);
    router.providerForModelId.mockRejectedValue(new Error("Model foreign is not in this organization's catalog"));
    await expect(service.inspect(agent, 'user')).resolves.toMatchObject({ ready: false });
    expect(router.providerForModelId).toHaveBeenCalledWith('org', 'foreign', { id: 'user' });
    expect(router.plan).not.toHaveBeenCalled();
  });

  it('allows a valid pin without invoking routing', async () => {
    rolesRepo.find.mockResolvedValue([{ key: 'principal', binding: { mode: 'pinned', modelId: 'model' } }]);
    await expect(service.inspect(agent)).resolves.toEqual({ ready: true });
    expect(router.plan).not.toHaveBeenCalled();
  });

  it('keeps infrastructure errors distinct from missing setup', async () => {
    router.plan.mockRejectedValue(new Error('database unavailable'));
    await expect(service.inspect(agent)).rejects.toThrow('database unavailable');
  });

  it('checks a hand-drawn routing node against its current org catalog', async () => {
    agent.settings = {};
    await expect(service.inspect(agent)).resolves.toMatchObject({ ready: false, message: expect.stringContaining('routing policy') });
    expect(strategies.compileStanding).not.toHaveBeenCalled();
  });

  it('scopes direct provider lookup to the organization and refuses missing providers', async () => {
    agent.settings = {};
    agent.pipeline = graph({ providerId: 'foreign' }) as any;
    providers.findOne.mockResolvedValue(null);
    await expect(service.inspect(agent)).resolves.toMatchObject({ ready: false });
    expect(providers.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'foreign', organizationId: 'org' } }));
  });

  it('allows workflows which do not call a model', async () => {
    agent.settings = {};
    agent.pipeline = { nodes: [{ id: 'input', type: 'input', config: {} }, { id: 'output', type: 'output', config: { mapping: '{{input}}' } }], edges: [{ source: 'input', target: 'output' }] } as any;
    await expect(service.inspect(agent)).resolves.toEqual({ ready: true });
    expect(router.plan).not.toHaveBeenCalled();
  });
});
