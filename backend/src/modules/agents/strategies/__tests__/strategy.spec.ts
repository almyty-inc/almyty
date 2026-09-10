import { strategyModelViolations } from '../../../../entities/strategy.entity';
import { STRATEGY_SEEDS } from '../strategy-seeds';
import { StrategyCompileError, compileStrategy, describeStrategy } from '../strategy-compiler';

/**
 * L5 gate:
 *   no strategy row contains a model id;
 *   eject produces an editable graph that behaves identically;
 *   explore_extract_patch compiles end to end.
 */
describe('no strategy names a concrete model', () => {
  it.each(STRATEGY_SEEDS.map((s) => [s.key, s] as const))('%s is clean', (_key, seed) => {
    expect(strategyModelViolations(seed)).toEqual([]);
  });

  it('catches a model named in a step parameter', () => {
    const problems = strategyModelViolations({
      roleSlots: ['principal'],
      shape: { entry: 'a', steps: [{ id: 'a', kind: 'call', params: { model: 'gpt-5' } }] },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('names a model or provider');
  });

  it('catches a provider id, which is the same mistake wearing a different name', () => {
    const problems = strategyModelViolations({
      roleSlots: ['principal'],
      shape: { entry: 'a', steps: [{ id: 'a', kind: 'call', params: { providerId: 'prov-1' } }] },
    });
    expect(problems).toHaveLength(1);
  });

  it('catches a model id hiding in a value rather than a key', () => {
    const problems = strategyModelViolations({
      roleSlots: ['principal'],
      shape: { entry: 'a', steps: [{ id: 'a', kind: 'call', params: { fallback: 'claude-opus-4-6' } }] },
    });
    expect(problems[0]).toContain('looks like a model id');
  });

  it('catches a role slot that is really a model', () => {
    const problems = strategyModelViolations({
      roleSlots: ['gpt-5'],
      shape: { entry: 'a', steps: [{ id: 'a', kind: 'call', roleSlot: 'gpt-5' }] },
    });
    expect(problems.some((p) => p.includes('a slot is a job, not a model'))).toBe(true);
  });

  it('leaves an ordinary parameter alone', () => {
    expect(
      strategyModelViolations({
        roleSlots: ['principal', 'verifier'],
        shape: { entry: 'a', steps: [{ id: 'a', kind: 'merge', params: { strategy: 'consensus', consensusThreshold: 0.5 } }] },
      }),
    ).toEqual([]);
  });
});

describe('compiling produces the graph the engine already runs', () => {
  const seed = STRATEGY_SEEDS.find((s) => s.key === 'explore_extract_patch')!;
  const bindings = { explorer: 'cheap', summariser: 'cheap', principal: 'principal', verifier: 'checker' };

  it('compiles explore_extract_patch into existing node types only', () => {
    const pipeline = compileStrategy(seed, bindings);
    const types = new Set(pipeline.nodes.map((n) => n.type));
    expect(types).toEqual(new Set(['input', 'parallel', 'llm_call', 'extract_context', 'verify', 'output']));
  });

  it('binds every step to a role and never to a model', () => {
    const pipeline = compileStrategy(seed, bindings);
    const withRoles = pipeline.nodes.filter((n) => n.data?.roleKey);
    expect(withRoles.length).toBeGreaterThan(0);
    for (const node of pipeline.nodes) {
      expect(node.data?.model).toBeUndefined();
      expect(node.data?.providerId).toBeUndefined();
    }
    expect(pipeline.nodes.find((n) => n.id === 'patch')?.data?.roleKey).toBe('principal');
    expect(pipeline.nodes.find((n) => n.id === 'extract')?.data?.roleKey).toBe('cheap');
  });

  it('wires an entry from input and every leaf to output, so the graph runs on its own', () => {
    const pipeline = compileStrategy(seed, bindings);
    expect(pipeline.edges).toContainEqual(expect.objectContaining({ source: 'input', target: 'explore' }));
    expect(pipeline.edges).toContainEqual(expect.objectContaining({ source: 'check', target: 'output' }));
  });

  it('is deterministic, which is what makes eject safe', () => {
    // Eject is "compile, then save the result as an ordinary pipeline". If
    // compiling twice could differ, an ejected graph could behave
    // differently from the strategy it came from.
    expect(compileStrategy(seed, bindings)).toEqual(compileStrategy(seed, bindings));
  });

  it('refuses an unbound slot, naming which, rather than compiling something half-wired', () => {
    expect(() => compileStrategy(seed, { explorer: 'cheap' })).toThrow(StrategyCompileError);
    try {
      compileStrategy(seed, { explorer: 'cheap' });
    } catch (err) {
      expect((err as Error).message).toContain('summariser');
      expect((err as Error).message).toContain('principal');
    }
  });

  it('refuses a step pointing at one that does not exist', () => {
    expect(() =>
      compileStrategy(
        { key: 'broken', roleSlots: [], shape: { entry: 'a', steps: [{ id: 'a', kind: 'call', next: ['nowhere'] }] } },
        {},
      ),
    ).toThrow(/not one of the strategy's steps/);
  });

  it('compiles every seed with its slots bound to themselves', () => {
    for (const s of STRATEGY_SEEDS) {
      const selfBound = Object.fromEntries(s.roleSlots.map((slot) => [slot, slot]));
      expect(() => compileStrategy(s, selfBound)).not.toThrow();
    }
  });
});

describe('describe tells the picker what a strategy costs', () => {
  it('rates a single call cheapest and a fan-out dearest', () => {
    const single = describeStrategy(STRATEGY_SEEDS.find((s) => s.key === 'single')!);
    const explore = describeStrategy(STRATEGY_SEEDS.find((s) => s.key === 'explore_extract_patch')!);
    expect(single.costBand).toBe('low');
    expect(explore.costBand).toBe('high');
    expect(explore.roleSlots).toContain('summariser');
  });
});
