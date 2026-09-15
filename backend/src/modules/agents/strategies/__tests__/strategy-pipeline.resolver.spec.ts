import { StrategyCompileError } from '../strategy-compiler';
import { StrategyPipelineResolver } from '../strategy-pipeline.resolver';
import { Agent } from '../../../../entities/agent.entity';

/**
 * The link that turns a chosen strategy into what actually runs.
 *
 * Everything else in L5 existed and was tested: the seeds, the compiler,
 * the picker, the endpoint that saves the choice. The engine still ran
 * `agent.pipeline`, so picking a shape changed nothing at run time and
 * every one of those tests stayed green. This file is the one that fails
 * if that is true again.
 */
describe('the chosen strategy becomes the pipeline', () => {
  const agent = (strategyKey?: string | null): Agent =>
    ({ id: 'a1', organizationId: 'org-1', settings: strategyKey === undefined ? {} : { execution: { strategyKey } } }) as any;

  const resolver = (roleKeys: string[], rows: any[] = []) =>
    new StrategyPipelineResolver(
      { find: jest.fn().mockResolvedValue(rows) } as any,
      { find: jest.fn().mockResolvedValue(roleKeys.map((key) => ({ key }))) } as any,
    );

  it('leaves an agent that chose nothing running its own graph', async () => {
    expect(await resolver([]).pipelineFor(agent())).toBeNull();
    expect(await resolver([]).pipelineFor(agent(null))).toBeNull();
  });

  it('compiles a built-in shape without the organization storing a row', async () => {
    const compiled = await resolver(['principal']).pipelineFor(agent('single'));
    expect(compiled?.strategyKey).toBe('single');
    expect(compiled?.pipeline.nodes.map((n) => n.id)).toEqual(['input', 'answer', 'output']);
  });

  it('names a role on the compiled node and never a model', async () => {
    const compiled = await resolver(['drafter', 'verifier', 'principal']).pipelineFor(agent('cascade'));
    const nodes = compiled!.pipeline.nodes;
    const draft = nodes.find((n) => n.id === 'draft')!;
    expect((draft.data as any).roleKey).toBe('drafter');
    expect(JSON.stringify(nodes)).not.toMatch(/modelId|providerId/);
  });

  it('refuses when a slot has no role, naming which, rather than running the wrong shape', async () => {
    await expect(resolver(['principal']).pipelineFor(agent('cascade'))).rejects.toBeInstanceOf(StrategyCompileError);
    await expect(resolver(['principal']).pipelineFor(agent('cascade'))).rejects.toThrow(/drafter/);
  });

  it('refuses a strategy that no longer exists instead of silently running the raw graph', async () => {
    await expect(resolver(['principal']).pipelineFor(agent('deleted_shape'))).rejects.toThrow(/no longer exists/);
  });

  it("prefers the organization's own row over the built-in of the same key", async () => {
    const own = {
      key: 'single',
      organizationId: 'org-1',
      roleSlots: ['principal'],
      shape: { entry: 'ours', steps: [{ id: 'ours', kind: 'call', roleSlot: 'principal' }] },
    };
    const compiled = await resolver(['principal'], [own]).pipelineFor(agent('single'));
    expect(compiled?.pipeline.nodes.map((n) => n.id)).toContain('ours');
  });

  it('lets the orchestrator override the standing choice, which is the point of it', async () => {
    const orchestrator = { choose: jest.fn().mockResolvedValue({ strategyKey: 'cascade', roleBindings: {}, via: 'orchestrator' }) };
    const r = new (StrategyPipelineResolver as any)(
      { find: jest.fn().mockResolvedValue([]) },
      { find: jest.fn().mockResolvedValue(['drafter', 'verifier', 'principal'].map((key) => ({ key }))) },
      orchestrator,
    );
    const compiled = await r.pipelineFor(agent('single'), 'do the thing');

    expect(orchestrator.choose).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), 'do the thing');
    expect(compiled.strategyKey).toBe('cascade');
    expect(compiled.chosenBy).toBe('orchestrator');
  });

  it('carries the fallback reason through, so a run can say why it got the fallback', async () => {
    const orchestrator = {
      choose: jest.fn().mockResolvedValue({ strategyKey: 'single', roleBindings: {}, via: 'fallback', fallbackReason: 'it did not answer within 2000ms' }),
    };
    const r = new (StrategyPipelineResolver as any)(
      { find: jest.fn().mockResolvedValue([]) },
      { find: jest.fn().mockResolvedValue([{ key: 'principal' }]) },
      orchestrator,
    );
    const compiled = await r.pipelineFor(agent(null), '');

    // No standing choice at all, and the run still gets a shape.
    expect(compiled.strategyKey).toBe('single');
    expect(compiled.chosenBy).toBe('fallback');
    expect(compiled.fallbackReason).toContain('2000ms');
  });
});
