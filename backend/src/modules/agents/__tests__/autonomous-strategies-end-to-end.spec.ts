import { MessageRole } from '../../../entities/message.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { AgentModels } from '../autonomous-models';
import { anthropicText, anthropicTool, FAIL, openaiText, PASS, runAgent } from './autonomous-harness';

jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

/**
 * Every working strategy, end to end, as a visitor on the hosted chat
 * meets it.
 *
 * Multi-model is the headline: the roles of one agent are different
 * models, and the strategy decides which of them answers which step. So
 * each case gives its roles distinct models -- on two accounts, one of
 * them a role routed by policy rather than pinned -- drives the real step
 * processor through the hosted chat controller's stream, and asserts two
 * things a person would check: which model answered each step (the model,
 * provider and, for the routed role, the router's attribution recorded on
 * the step), and the answer the visitor was given.
 */

const QUESTION = 'Where is my order 4411?';

// ── The models, on two accounts (see autonomous-harness.ts) ─────────────
const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-strong', model: 'claude-sonnet-5' } as const;
const DRAFTER = { key: 'drafter', name: 'Drafter', purpose: 'drafter', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o-mini' } as const;
const CHECKER = { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', providerId: 'p-cheap', model: 'o4-mini' } as const;
const mainConfig = { providerId: 'p-strong', model: 'claude-sonnet-5' };

/** [step type, role, the model that answered it] -- who did what, in order. */
const attribution = (run: AgentRun) => run.steps.map((st: any) => [st.type, st.role?.key ?? null, st.output?.model ?? null]);

/** The last thing said in the visitor's conversation, internal working left out. */
const lastSaid = (visible: Array<[string, string]>) => visible[visible.length - 1];

async function asVisitor(models: AgentModels, streams: Record<string, string[][]>, routes?: Record<string, { providerId: string; model: string }>) {
  const seen = await runAgent({ models, modelConfig: mainConfig, streams, hosted: true, routes });
  // Every stream the case set up was asked for: no call was skipped.
  expect(seen.leftover).toEqual({});
  expect(seen.run.error ?? null).toBeNull();
  expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
  return seen;
}

describe('every strategy, with a different model in each role, answers the visitor', () => {
  it('Single: the main model answers, and a teammate routed by policy is attributed to the model the router chose', async () => {
    const seen = await asVisitor(
      {
        strategy: 'single',
        roles: [MAIN, { key: 'lookup', name: 'Lookup', purpose: 'teammate', kind: 'model', routing: { objective: 'cheapest' } }] as any,
      },
      {
        'claude-sonnet-5': [
          anthropicTool('claude-sonnet-5', 'ask_lookup', { input: 'order 4411' }, 90, 10),
          anthropicText('claude-sonnet-5', 140, ['Order 4411 ships Monday.'], 8),
        ],
        'gpt-4o-mini': [openaiText('gpt-4o-mini', 40, ['4411: ships Monday'], 6)],
      },
      { cheapest: { providerId: 'p-cheap', model: 'gpt-4o-mini' } },
    );

    expect(seen.run.output).toBe('Order 4411 ships Monday.');
    expect(lastSaid(seen.visible)).toEqual([MessageRole.ASSISTANT, 'Order 4411 ships Monday.']);
    const teammate = seen.run.steps.find((st: any) => st.type === 'teammate_call') as any;
    expect(teammate.role.key).toBe('lookup');
    expect(teammate.output).toMatchObject({ model: 'gpt-4o-mini', providerId: 'p-cheap' });
    // Routed, not pinned: the step says what the router picked and why.
    expect(teammate.output.routing).toMatchObject({ modelId: 'card-gpt-4o-mini', vendorModelId: 'gpt-4o-mini', providerId: 'p-cheap', rationale: 'cheapest: gpt-4o-mini' });
    const last = seen.run.steps[seen.run.steps.length - 1] as any;
    expect([last.role.key, last.output.model, last.output.providerId]).toEqual(['main', 'claude-sonnet-5', 'p-strong']);
  });

  describe('Cascade', () => {
    const cascade = { strategy: 'cascade', roles: [MAIN, DRAFTER, CHECKER] } as unknown as AgentModels;

    it('a passing check: the drafter answers, the checker passes it, the main model is never asked', async () => {
      const seen = await asVisitor(cascade, {
        'gpt-4o-mini': [openaiText('gpt-4o-mini', 100, ['Order 4411 ships Monday.'], 8)],
        'o4-mini': [openaiText('o4-mini', 120, [PASS], 12)],
      });
      expect(attribution(seen.run)).toEqual([
        ['verify', 'checker', 'o4-mini'],
        ['llm_call', 'drafter', 'gpt-4o-mini'],
      ]);
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      expect(seen.tokens).toEqual([]);
      expect(seen.visible).toEqual([
        [MessageRole.USER, QUESTION],
        [MessageRole.ASSISTANT, 'Order 4411 ships Monday.'],
      ]);
    });

    it('a failed check: the escalated answer, from the main model, is the one the visitor gets', async () => {
      const seen = await asVisitor(cascade, {
        'gpt-4o-mini': [openaiText('gpt-4o-mini', 100, ['Your order ships soon.'], 8)],
        'o4-mini': [openaiText('o4-mini', 120, [FAIL], 12)],
        'claude-sonnet-5': [anthropicText('claude-sonnet-5', 130, ['Order 4411 ships Monday.'], 8)],
      });
      expect(attribution(seen.run)).toEqual([
        ['llm_call', 'drafter', 'gpt-4o-mini'],
        ['verify', 'checker', 'o4-mini'],
        ['llm_call', 'main', 'claude-sonnet-5'],
      ]);
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      expect(seen.tokens).toEqual([]);
      expect(seen.visible).toEqual([
        [MessageRole.USER, QUESTION],
        [MessageRole.ASSISTANT, 'Order 4411 ships Monday.'],
      ]);
    });
  });

  it('Best of N: the main model writes the candidates, the checker on another model picks, and the picked one is the answer', async () => {
    const seen = await asVisitor({ strategy: 'best_of_n', candidates: 3, roles: [MAIN, CHECKER] } as unknown as AgentModels, {
      'claude-sonnet-5': [
        anthropicText('claude-sonnet-5', 100, ['Monday, probably.'], 5),
        anthropicText('claude-sonnet-5', 101, ['Order 4411 ships Monday.'], 7),
        anthropicText('claude-sonnet-5', 101, ['Soon.'], 2),
      ],
      'o4-mini': [openaiText('o4-mini', 90, ['2'], 1)],
    });
    expect(attribution(seen.run)).toEqual([
      ['llm_call', 'main', 'claude-sonnet-5'],
      ['llm_call', 'main', 'claude-sonnet-5'],
      ['judge', 'checker', 'o4-mini'],
      ['llm_call', 'main', 'claude-sonnet-5'],
    ]);
    expect(seen.run.steps[2].output).toMatchObject({ picked: 2, candidates: 3 });
    expect(seen.run.output).toBe('Order 4411 ships Monday.');
    expect(seen.tokens).toEqual([]);
    expect(lastSaid(seen.visible)).toEqual([MessageRole.ASSISTANT, 'Order 4411 ships Monday.']);
  });

  it('Panel: panelists on other models (one routed) answer too, the judge role on its own model writes the answer', async () => {
    const seen = await asVisitor(
      {
        strategy: 'panel',
        roles: [
          MAIN,
          { key: 'panelist_1', name: 'Fast', purpose: 'panelist', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o' },
          { key: 'panelist_2', name: 'Careful', purpose: 'panelist', kind: 'model', routing: { objective: 'quality' } },
          { key: 'judge', name: 'Judge', purpose: 'judge', kind: 'model', providerId: 'p-cheap', model: 'gpt-4.1' },
        ],
      } as unknown as AgentModels,
      {
        'claude-sonnet-5': [anthropicText('claude-sonnet-5', 100, ['Monday.'], 3)],
        'gpt-4o': [openaiText('gpt-4o', 95, ['It ships Monday.'], 5)],
        'claude-haiku-5': [anthropicText('claude-haiku-5', 95, ['Tuesday.'], 3)],
        'gpt-4.1': [openaiText('gpt-4.1', 120, [JSON.stringify({ agreeing: 2, answer: 'Order 4411 ships Monday.' })], 15)],
      },
      { quality: { providerId: 'p-strong', model: 'claude-haiku-5' } },
    );
    const byRole = Object.fromEntries(seen.run.steps.map((st: any) => [st.role?.key, st.output]));
    expect(byRole.panelist_1).toMatchObject({ model: 'gpt-4o', providerId: 'p-cheap' });
    expect(byRole.panelist_2).toMatchObject({ model: 'claude-haiku-5', providerId: 'p-strong', routing: { vendorModelId: 'claude-haiku-5', rationale: 'quality: claude-haiku-5' } });
    expect(byRole.judge).toMatchObject({ strategy: 'panel', model: 'gpt-4.1', providerId: 'p-cheap', candidates: 3, consensusReached: true });
    expect(byRole.main).toMatchObject({ model: 'claude-sonnet-5', providerId: 'p-strong' });
    // The judge read all three answers.
    const judged = JSON.stringify(seen.bodies.find((b) => b.model === 'gpt-4.1')!.body.messages);
    for (const said of ['Monday.', 'It ships Monday.', 'Tuesday.']) expect(judged).toContain(said);
    expect(seen.run.output).toBe('Order 4411 ships Monday.');
    expect(seen.tokens).toEqual([]);
    expect(lastSaid(seen.visible)).toEqual([MessageRole.ASSISTANT, 'Order 4411 ships Monday.']);
  });

  it('Panel without a judge role: the main model judges', async () => {
    const seen = await asVisitor(
      {
        strategy: 'panel',
        roles: [
          MAIN,
          { key: 'panelist_1', name: 'Fast', purpose: 'panelist', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o' },
          { key: 'panelist_2', name: 'Other', purpose: 'panelist', kind: 'model', providerId: 'p-cheap', model: 'gpt-4.1' },
        ],
      } as unknown as AgentModels,
      {
        'claude-sonnet-5': [
          anthropicText('claude-sonnet-5', 100, ['Monday.'], 3),
          anthropicText('claude-sonnet-5', 120, [JSON.stringify({ agreeing: 2, answer: 'Order 4411 ships Monday.' })], 15),
        ],
        'gpt-4o': [openaiText('gpt-4o', 95, ['It ships Monday.'], 5)],
        'gpt-4.1': [openaiText('gpt-4.1', 95, ['Tuesday.'], 3)],
      },
    );
    const judge = seen.run.steps.find((st: any) => st.type === 'judge') as any;
    expect([judge.role.key, judge.output.model]).toEqual(['main', 'claude-sonnet-5']);
    expect(seen.run.output).toBe('Order 4411 ships Monday.');
  });

  it('Explore, extract, patch: explorer, summariser, main and checker each on their model; the answer is the patched text, not the verdict', async () => {
    const brief = { relevantFiles: [], symbols: [], callers: [], tests: [], notes: 'Order 4411: eta Monday per CRM.' };
    const seen = await asVisitor(
      {
        strategy: 'explore_extract_patch',
        roles: [
          MAIN,
          CHECKER,
          { key: 'explorer', name: 'Explorer', purpose: 'explorer', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o-mini' },
          { key: 'summariser', name: 'Summariser', purpose: 'summariser', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o' },
        ],
      } as unknown as AgentModels,
      {
        'gpt-4o-mini': [openaiText('gpt-4o-mini', 110, ['CRM says account 4411 eta Monday.'], 9)],
        'gpt-4o': [openaiText('gpt-4o', 70, [JSON.stringify(brief)], 30)],
        'claude-sonnet-5': [anthropicText('claude-sonnet-5', 130, ['Order 4411 ships Monday.'], 7)],
        'o4-mini': [openaiText('o4-mini', 100, [PASS], 10)],
      },
    );
    expect(attribution(seen.run)).toEqual([
      ['explore', 'explorer', null],
      ['extract_context', 'summariser', 'gpt-4o'],
      ['verify', 'checker', 'o4-mini'],
      ['llm_call', 'main', 'claude-sonnet-5'],
    ]);
    // The explorer's own run answered on the explorer's model.
    const child = seen.runRepository.row('child-1')!;
    expect(child.steps.map((st: any) => [st.role?.key, st.output?.model])).toEqual([['explorer', 'gpt-4o-mini']]);
    expect(seen.run.output).toBe('Order 4411 ships Monday.');
    expect(JSON.stringify(seen.run.output)).not.toContain('verdict');
    expect(seen.tokens).toEqual([]);
    expect(seen.visible).toEqual([
      [MessageRole.USER, QUESTION],
      [MessageRole.ASSISTANT, 'Order 4411 ships Monday.'],
    ]);
  });
});
