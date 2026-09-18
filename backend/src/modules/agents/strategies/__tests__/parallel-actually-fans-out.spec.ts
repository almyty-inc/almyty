import { compileStrategy, describeStrategy, StrategyCompileError } from '../strategy-compiler';
import { STRATEGY_SEEDS } from '../strategy-seeds';
import { StrategyShape } from '../../../../entities/strategy.entity';

/**
 * A fan-out that does not fan out.
 *
 * `parallel` carried `params.n` into node data and the engine's parallel
 * node is a pass-through, so a compiled shape ran its downstream step
 * once: best-of-n was best-of-one, and explore-extract-patch handed the
 * summariser a single rollout. Meanwhile `describe()` quoted the picker a
 * cost band computed from the n that never happened, so the shape looked
 * expensive and behaved cheap — the one combination that cannot be caught
 * by reading either number on its own.
 *
 * Fan-out is a compile-time expansion, per the compiler's own rule: if
 * making a strategy work needs a change in the executor, the change
 * belongs in the compiler instead.
 */
describe('a parallel step actually runs its branches', () => {
  const bestOfN = STRATEGY_SEEDS.find((s) => s.key === 'best_of_n')!;
  const explore = STRATEGY_SEEDS.find((s) => s.key === 'explore_extract_patch')!;

  const bind = (slots: string[]) => Object.fromEntries(slots.map((s) => [s, `role-${s}`]));

  it('emits n candidates for best_of_n, not one', () => {
    const pipeline = compileStrategy(bestOfN, bind(bestOfN.roleSlots!));
    const candidates = pipeline.nodes.filter((n) => n.data?.strategyStep === 'candidate');
    expect(candidates).toHaveLength(3);
    expect(candidates.map((n) => n.id).sort()).toEqual(['candidate#1', 'candidate#2', 'candidate#3']);

    // Every branch carries the same role. Fan-out is n attempts on one
    // slot, not n different models.
    expect(new Set(candidates.map((n) => n.data?.roleKey))).toEqual(new Set(['role-principal']));
    expect(new Set(candidates.map((n) => n.data?.strategyBranch))).toEqual(new Set([1, 2, 3]));
  });

  it('wires every branch to the fan-out step and to the judge', () => {
    const { edges } = compileStrategy(bestOfN, bind(bestOfN.roleSlots!));
    for (const n of [1, 2, 3]) {
      expect(edges).toContainEqual(expect.objectContaining({ source: 'fan', target: `candidate#${n}` }));
      expect(edges).toContainEqual(expect.objectContaining({ source: `candidate#${n}`, target: 'judge' }));
    }
    // The judge sees three inputs, which is the whole point.
    expect(edges.filter((e) => e.target === 'judge')).toHaveLength(3);
  });

  it('gives the judge three candidates to choose between', () => {
    const { nodes } = compileStrategy(bestOfN, bind(bestOfN.roleSlots!));
    const judge = nodes.find((n) => n.id === 'judge')!;
    expect(judge.type).toBe('merge');
    expect(judge.data?.strategy).toBe('best_of_n');
    // Named as a role, never as a provider — that is what let this
    // strategy throw "requires judgeConfig.providerId" for so long.
    expect(judge.data?.roleKey).toBe('role-verifier');
    expect(judge.data?.providerId).toBeUndefined();
  });

  it('replicates only the fan-out targets, so the extraction stays single', () => {
    const { nodes, edges } = compileStrategy(explore, bind(explore.roleSlots!));
    expect(nodes.filter((n) => n.data?.strategyStep === 'rollout')).toHaveLength(3);
    // Three rollouts, one brief. Replicating the extraction too would
    // defeat the strategy: it exists so that one compression is read by
    // the expensive role instead of three transcripts.
    expect(nodes.filter((n) => n.data?.strategyStep === 'extract')).toHaveLength(1);
    expect(edges.filter((e) => e.target === 'extract')).toHaveLength(3);
  });

  it('fans out from the entry step too', () => {
    // explore_extract_patch's entry IS the parallel step, so nothing
    // upstream of it replicates; a shape whose entry is a replicated
    // target has to be wired from input on every branch.
    const shape: StrategyShape = {
      entry: 'fan',
      steps: [
        { id: 'fan', kind: 'parallel', params: { n: 2 }, next: ['a'] },
        { id: 'a', kind: 'call', roleSlot: 'principal' },
      ],
    };
    const { edges } = compileStrategy({ key: 'k', roleSlots: ['principal'], shape } as any, { principal: 'r' });
    expect(edges).toContainEqual(expect.objectContaining({ source: 'input', target: 'fan' }));
    // Both leaves feed output.
    expect(edges.filter((e) => e.target === 'output').map((e) => e.source).sort()).toEqual(['a#1', 'a#2']);
  });

  it('refuses a fan-out whose target has another parent', () => {
    const shape: StrategyShape = {
      entry: 'fan',
      steps: [
        { id: 'fan', kind: 'parallel', params: { n: 2 }, next: ['a'] },
        { id: 'other', kind: 'call', roleSlot: 'principal', next: ['a'] },
        { id: 'a', kind: 'call', roleSlot: 'principal' },
      ],
    };
    expect(() => compileStrategy({ key: 'k', roleSlots: ['principal'], shape } as any, { principal: 'r' })).toThrow(
      StrategyCompileError,
    );
  });

  it('refuses nested fan-out rather than compiling something surprising', () => {
    const shape: StrategyShape = {
      entry: 'outer',
      steps: [
        { id: 'outer', kind: 'parallel', params: { n: 2 }, next: ['inner'] },
        { id: 'inner', kind: 'parallel', params: { n: 2 }, next: ['a'] },
        { id: 'a', kind: 'call', roleSlot: 'principal' },
      ],
    };
    expect(() => compileStrategy({ key: 'k', roleSlots: ['principal'], shape } as any, { principal: 'r' })).toThrow(
      /Nested fan-out/,
    );
  });

  it('refuses an n that is not a whole number of branches', () => {
    const shape: StrategyShape = {
      entry: 'fan',
      steps: [
        { id: 'fan', kind: 'parallel', params: { n: 2.5 }, next: ['a'] },
        { id: 'a', kind: 'call', roleSlot: 'principal' },
      ],
    };
    expect(() => compileStrategy({ key: 'k', roleSlots: ['principal'], shape } as any, { principal: 'r' })).toThrow(
      /whole number of branches/,
    );
  });

  it('leaves a parallel step with explicit branches alone', () => {
    // panel names its three branches rather than asking for n copies of
    // one, so nothing replicates and the ids stay readable.
    const panel = STRATEGY_SEEDS.find((s) => s.key === 'panel')!;
    const { nodes, edges } = compileStrategy(panel, bind(panel.roleSlots!));
    expect(nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(['fan', 'a', 'b', 'c', 'consensus']),
    );
    expect(nodes.filter((n) => n.id.includes('#'))).toEqual([]);
    expect(edges.filter((e) => e.target === 'consensus')).toHaveLength(3);
  });

  describe('the band the picker shows is a band on the graph that runs', () => {
    it('counts each fanned branch once', () => {
      // 3 candidates + 1 judged merge = 4 calls.
      expect(describeStrategy(bestOfN).costBand).toBe('medium');
    });

    it('does not multiply steps past the fan-in by n', () => {
      // 3 rollouts + 1 extract + 1 patch + 1 verify = 6. The old
      // arithmetic was calls × n = 3 × 3 = 9 — same band here, but it
      // scaled with every step added after the join, which is wrong for
      // any shape with a long tail.
      const shape: StrategyShape = {
        entry: 'fan',
        steps: [
          { id: 'fan', kind: 'parallel', params: { n: 2 }, next: ['a'] },
          { id: 'a', kind: 'call', roleSlot: 'principal', next: ['b'] },
          { id: 'b', kind: 'call', roleSlot: 'principal' },
        ],
      };
      // 2 branches + 1 tail step = 3 calls, not 2 × 2 = 4.
      expect(describeStrategy({ key: 'k', displayName: 'k', roleSlots: ['principal'], shape } as any).costBand).toBe(
        'medium',
      );
      expect(describeStrategy(explore).costBand).toBe('high');
    });

    it('calls a single call low', () => {
      expect(describeStrategy(STRATEGY_SEEDS.find((s) => s.key === 'single')!).costBand).toBe('low');
    });
  });
});
