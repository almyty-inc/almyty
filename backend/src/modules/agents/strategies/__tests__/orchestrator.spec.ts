import {
  MAX_ORCHESTRATOR_DEPTH,
  ORCHESTRATOR_DEFAULTS,
  OrchestratorDepthExceeded,
  chooseStrategy,
  orchestratorPrompt,
  readOrchestratorAnswer,
} from '../orchestrator';
import { STRATEGY_SEEDS } from '../strategy-seeds';

/**
 * L6 gate: chooses a strategy, is budget-accounted, falls back cleanly on
 * timeout, is disabled by default, and the product is fully usable with it
 * off.
 */
const available = STRATEGY_SEEDS;
const config = { ...ORCHESTRATOR_DEFAULTS, enabled: true, timeoutMs: 50 };

const answer = (o: unknown) => JSON.stringify(o);

describe('it is off unless someone turns it on', () => {
  it('defaults to disabled', () => {
    expect(ORCHESTRATOR_DEFAULTS.enabled).toBe(false);
  });

  it('falls straight to the static strategy when disabled, without calling the model', async () => {
    const decide = jest.fn();
    const choice = await chooseStrategy(ORCHESTRATOR_DEFAULTS, 0, available, decide);

    expect(decide).not.toHaveBeenCalled();
    expect(choice).toMatchObject({ strategyKey: 'single', via: 'fallback', fallbackReason: 'the orchestrator is disabled' });
  });
});

describe('it chooses, and records why', () => {
  it('takes a well-formed choice', async () => {
    const choice = await chooseStrategy(config, 0, available, async () =>
      answer({ strategy: 'cascade', roleBindings: { drafter: 'cheap', verifier: 'checker', principal: 'big' }, reasoning: 'simple edit' }),
    );

    expect(choice).toMatchObject({
      strategyKey: 'cascade',
      roleBindings: { drafter: 'cheap', verifier: 'checker', principal: 'big' },
      reasoning: 'simple edit',
      via: 'orchestrator',
    });
  });

  it('reads a choice wrapped in prose', () => {
    const read = readOrchestratorAnswer(
      `I would use a cascade.\n${answer({ strategy: 'cascade', roleBindings: { drafter: 'a', verifier: 'b', principal: 'c' } })}\nThat should do.`,
      available,
    );
    expect(read).toMatchObject({ ok: true, strategyKey: 'cascade' });
  });
});

describe('every way it can misbehave ends in the fallback, with a reason', () => {
  it.each([
    ['a timeout', async () => new Promise<string>(() => {}), /did not answer within/],
    ['an unparseable answer', async () => 'not json', /no JSON object/],
    ['a strategy that does not exist', async () => answer({ strategy: 'telepathy', roleBindings: {} }), /not a strategy this organization has/],
    ['unbound slots', async () => answer({ strategy: 'cascade', roleBindings: { drafter: 'a' } }), /left these slots unbound/],
    ['a thrown error', async () => { throw new Error('provider exploded'); }, /provider exploded/],
  ])('%s falls back', async (_name, decide, reason) => {
    const choice = await chooseStrategy(config, 0, available, decide as () => Promise<string>);
    expect(choice.via).toBe('fallback');
    expect(choice.strategyKey).toBe('single');
    expect(choice.fallbackReason).toMatch(reason as RegExp);
  });

  it('refuses a strategy outside the allowed list', async () => {
    const choice = await chooseStrategy(
      { ...config, allowedStrategyKeys: ['single', 'cascade'] },
      0,
      available,
      async () => answer({ strategy: 'panel', roleBindings: { panelist_one: 'a', panelist_two: 'b', panelist_three: 'c' } }),
    );
    expect(choice.via).toBe('fallback');
    expect(choice.fallbackReason).toMatch(/not in the allowed list/);
  });

  it('never leaves a run without a strategy, whatever happens', async () => {
    for (const decide of [
      async () => '',
      async () => '{}',
      async () => answer({ strategy: 'cascade', roleBindings: 'not an object' }),
      async () => answer({ strategy: 'cascade', roleBindings: { drafter: 7 } }),
    ]) {
      const choice = await chooseStrategy(config, 0, available, decide as () => Promise<string>);
      expect(choice.strategyKey).toBeTruthy();
    }
  });
});

describe('an orchestrator never chooses an orchestrator', () => {
  it('refuses beyond a depth of one, in code rather than in documentation', async () => {
    expect(MAX_ORCHESTRATOR_DEPTH).toBe(1);
    await expect(chooseStrategy(config, 2, available, async () => answer({ strategy: 'single', roleBindings: { principal: 'a' } }))).rejects.toBeInstanceOf(
      OrchestratorDepthExceeded,
    );
  });

  it('allows the one layer it is meant to have', async () => {
    const choice = await chooseStrategy(config, 1, available, async () => answer({ strategy: 'single', roleBindings: { principal: 'a' } }));
    expect(choice.via).toBe('orchestrator');
  });
});

describe('the prompt describes shapes rather than dumping them', () => {
  it('offers slots and cost bands, and never a step graph', () => {
    const prompt = orchestratorPrompt('fix the retry bug', available, ['cheap', 'big', 'checker']);
    expect(prompt).toContain('explore_extract_patch');
    expect(prompt).toContain('cost high');
    expect(prompt).toContain('cheap, big, checker');
    // The orchestrator picks a shape; it has no business seeing the steps.
    expect(prompt).not.toContain('"steps"');
  });
});
