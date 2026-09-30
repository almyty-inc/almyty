import { MessageRole } from '../../../entities/message.entity';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { AgentModels } from '../autonomous-models';
import {
  anthropicText,
  anthropicTool,
  CHECKER,
  cheap,
  dear,
  DRAFTER,
  FAIL,
  MAIN,
  openaiText,
  openaiTool,
  PASS,
  runAgent,
  story,
} from './autonomous-harness';

// Only the socket is faked. The provider parsers, LlmChatHelper.chatStream,
// the step processor, the strategy runner, the verifier and the message
// builder are the real code; the byte streams are what Anthropic and
// chat-completions send.
jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

/**
 * An autonomous agent's roles and strategy drive its runs.
 *
 * Each case builds a run of a multi-model agent and drives the real step
 * processor to the end, with two providers on the wire -- a cheap
 * chat-completions account and a dear Anthropic one -- and checks which
 * model every call went to, what each role was charged, and what the run
 * answered.
 */
describe('autonomous strategies drive the loop, role by role', () => {
  describe('Cascade', () => {
    const cascade: AgentModels = { strategy: 'cascade', roles: [MAIN as any, DRAFTER as any, CHECKER as any] };

    it('the drafter works the task, the checker fails its answer, and only then the main role redoes the step', async () => {
      const seen = await runAgent({
        models: cascade,
        streams: {
          'gpt-4o-mini': [openaiTool('gpt-4o-mini', 'crm_lookup', { account: '4411' }, 90, 7), openaiText('gpt-4o-mini', 120, ['Your order ships soon.'], 6)],
          'o4-mini': [openaiText('o4-mini', 150, [FAIL], 20)],
          'claude-sonnet-5': [anthropicText('claude-sonnet-5', 140, ['Order 4411', ' ships Monday.'], 9)],
        },
      });

      expect(seen.leftover).toEqual({});
      expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
      expect(seen.run.output).toBe('Order 4411 ships Monday.');

      // Which model every call went to, in order.
      expect(seen.bodies.map((b) => b.model)).toEqual(['gpt-4o-mini', 'gpt-4o-mini', 'o4-mini', 'claude-sonnet-5']);
      // Each role's own sampling on the wire.
      expect(seen.bodies[0].body.temperature).toBe(0.3);
      expect(seen.bodies[0].body.max_tokens).toBe(400);
      expect(seen.bodies[3].body.temperature).toBe(0.2);
      expect(seen.bodies[3].body.max_tokens).toBe(800);
      // The checker is refute-only, with the role's focus, and reads the draft.
      const checkerSaid = JSON.stringify(seen.bodies[2].body.messages);
      expect(checkerSaid).toContain('Your ONLY job is to find what is WRONG');
      expect(checkerSaid).toContain('Every claim needs order data.');
      expect(checkerSaid).toContain('Your order ships soon.');
      // The main role redoes the step from the same state: the tools are
      // offered, the tool work is in front of it, the rejected draft is not.
      const mainSaid = JSON.stringify(seen.bodies[3].body);
      expect(seen.bodies[3].body.tools.map((t: any) => t.name)).toContain('crm_lookup');
      expect(mainSaid).toContain('Monday');
      expect(mainSaid).not.toContain('Your order ships soon.');

      expect(story(seen.run)).toEqual([
        ['tool_call', null, null],
        ['llm_call', 'drafter', 'tools'],
        ['llm_call', 'drafter', 'escalated'],
        ['verify', 'checker', 'fail'],
        ['llm_call', 'main', 'completed'],
      ]);
      const [, toolStep, escalated, check, done] = seen.run.steps as any[];
      expect(toolStep.output).toMatchObject({ model: 'gpt-4o-mini', providerId: 'p-cheap' });
      expect(escalated.output).toMatchObject({ model: 'gpt-4o-mini', providerId: 'p-cheap' });
      expect(check.output.failures[0]).toMatchObject({ rule: 'cites no order data', checker: 'Checker' });
      expect(done.output).toMatchObject({ model: 'claude-sonnet-5', providerId: 'p-strong' });
      expect(done.role).toEqual({ key: 'main', name: 'Main', purpose: 'main', kind: 'model' });

      // Cost per role, to the token, and nothing uncounted.
      const costs = seen.run.metadata.roleCosts;
      expect(costs.drafter.cost).toBeCloseTo(cheap(90, 7) + cheap(120, 6), 12);
      expect(costs.drafter.calls).toBe(2);
      expect(costs.checker.cost).toBeCloseTo(cheap(150, 20), 12);
      expect(costs.main.cost).toBeCloseTo(dear(140, 9), 12);
      expect(costs.main.calls).toBe(1);
      expect(seen.run.totalCost).toBeCloseTo(costs.drafter.cost + costs.checker.cost + costs.main.cost, 12);
      expect(seen.run.totalTokens).toBe(97 + 126 + 170 + 149);
      expect(seen.run.metadata.strategy).toBe('cascade');
      expect(seen.run.workingMemory.cascadeEscalated).toBe(false);

      // The customer's history: the question, the tool work, the main role's answer. No draft.
      expect(seen.visible.map(([role]) => role)).toEqual([MessageRole.USER, MessageRole.ASSISTANT, MessageRole.TOOL, MessageRole.ASSISTANT]);
      expect(JSON.stringify(seen.visible)).not.toContain('Your order ships soon.');
      expect(seen.events.find((e) => e.type === 'cascade.escalated')?.data).toMatchObject({ from: 'drafter', to: 'main' });
    });

    it('a passing check keeps the drafter\'s answer and never pays for the main role', async () => {
      const seen = await runAgent({
        models: cascade,
        streams: {
          'gpt-4o-mini': [openaiText('gpt-4o-mini', 100, ['Order 4411 ships Monday.'], 8)],
          'o4-mini': [openaiText('o4-mini', 120, [PASS], 12)],
        },
      });

      expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      expect(seen.bodies.map((b) => b.model)).toEqual(['gpt-4o-mini', 'o4-mini']);
      expect(story(seen.run)).toEqual([
        ['verify', 'checker', 'pass'],
        ['llm_call', 'drafter', 'completed'],
      ]);
      expect(Object.keys(seen.run.metadata.roleCosts).sort()).toEqual(['checker', 'drafter']);
      expect(seen.run.totalCost).toBeCloseTo(cheap(100, 8) + cheap(120, 12), 12);
    });

    it('an unreadable verdict escalates rather than passing an unchecked draft', async () => {
      const seen = await runAgent({
        models: cascade,
        streams: {
          'gpt-4o-mini': [openaiText('gpt-4o-mini', 100, ['Probably Monday.'], 8)],
          'o4-mini': [openaiText('o4-mini', 120, ['I think it is fine'], 12)],
          'claude-sonnet-5': [anthropicText('claude-sonnet-5', 130, ['Order 4411 ships Monday.'], 8)],
        },
      });
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      expect(story(seen.run).map((s) => s.slice(1))).toEqual([
        ['drafter', 'escalated'],
        ['checker', 'fail'],
        ['main', 'completed'],
      ]);
    });

    it('a hosted chat visitor gets only the chosen answer, never the draft, and no extra answer call is made', async () => {
      const seen = await runAgent({
        models: cascade,
        hosted: true,
        streams: {
          'gpt-4o-mini': [openaiText('gpt-4o-mini', 100, ['Your order ships soon.'], 8)],
          'o4-mini': [openaiText('o4-mini', 120, [FAIL], 12)],
          'claude-sonnet-5': [anthropicText('claude-sonnet-5', 130, ['Order 4411', ' ships Monday.'], 8)],
        },
      });
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      // Held back until the choice was made; the page reconciles from the transcript.
      expect(seen.tokens).toEqual([]);
      expect(seen.bodies).toHaveLength(3);
      expect(seen.visible).toEqual([
        [MessageRole.USER, 'Where is my order 4411?'],
        [MessageRole.ASSISTANT, 'Order 4411 ships Monday.'],
      ]);
    });
  });

  describe('Single', () => {
    it('runs on the main role exactly as the agent\'s modelConfig says, and records it as the main role', async () => {
      const seen = await runAgent({
        models: { strategy: 'single', roles: [MAIN as any] },
        streams: { 'claude-sonnet-5': [anthropicText('claude-sonnet-5', 100, ['Order 4411 ships Monday.'], 8)] },
      });
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      expect(seen.bodies.map((b) => [b.model, b.body.temperature, b.body.max_tokens])).toEqual([['claude-sonnet-5', 0.2, 800]]);
      expect(story(seen.run)).toEqual([['llm_call', 'main', 'completed']]);
      expect(seen.run.metadata.roleCosts).toEqual({
        main: { name: 'Main', purpose: 'main', kind: 'model', cost: dear(100, 8), tokens: 108, calls: 1 },
      });
    });

    it('an agent saved before models existed runs on modelConfig, as its main role', async () => {
      const seen = await runAgent({
        models: null,
        streams: { 'claude-sonnet-5': [anthropicText('claude-sonnet-5', 100, ['Order 4411 ships Monday.'], 8)] },
      });
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      expect(story(seen.run)).toEqual([['llm_call', 'main', 'completed']]);
      expect(seen.run.metadata.strategy).toBe('single');
    });

    it('offers a teammate as a tool, and charges its answer to it', async () => {
      const seen = await runAgent({
        models: {
          strategy: 'single',
          roles: [
            MAIN as any,
            { key: 'translator', name: 'Translator', purpose: 'teammate', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o', instructions: 'Translate into Spanish.' },
          ],
        },
        streams: {
          'claude-sonnet-5': [
            anthropicTool('claude-sonnet-5', 'ask_translator', { input: 'Your order ships Monday.' }, 100, 12),
            anthropicText('claude-sonnet-5', 160, ['Su pedido sale el lunes.'], 9),
          ],
          'gpt-4o': [openaiText('gpt-4o', 40, ['Su pedido sale el lunes.'], 8)],
        },
      });
      expect(seen.run.output).toBe('Su pedido sale el lunes.');
      const offered = seen.bodies[0].body.tools.map((t: any) => t.name);
      expect(offered).toEqual(expect.arrayContaining(['crm_lookup', 'ask_translator']));
      const teammateCall = seen.bodies[1].body;
      expect(teammateCall.model).toBe('gpt-4o');
      expect(teammateCall).not.toHaveProperty('tools');
      expect(JSON.stringify(teammateCall.messages)).toContain('You are Translator');
      expect(JSON.stringify(teammateCall.messages)).toContain('Translate into Spanish.');
      // The teammate's answer is the tool result the main role reads next.
      expect(JSON.stringify(seen.bodies[2].body.messages)).toContain('Su pedido sale el lunes.');
      expect(story(seen.run)).toEqual([
        ['teammate_call', 'translator', null],
        ['llm_call', 'main', 'tools'],
        ['llm_call', 'main', 'completed'],
      ]);
      expect(seen.run.metadata.roleCosts.translator).toMatchObject({ purpose: 'teammate', calls: 1 });
      expect(seen.run.metadata.roleCosts.translator.cost).toBeCloseTo(cheap(40, 8), 12);
      expect(seen.run.totalCost).toBeCloseTo(dear(100, 12) + cheap(40, 8) + dear(160, 9), 12);
    });
  });

  describe('Best of N', () => {
    const bestOf3: AgentModels = { strategy: 'best_of_n', candidates: 3, roles: [MAIN as any, CHECKER as any] };

    it('the main role writes N answers over the same context and the checker picks one', async () => {
      const seen = await runAgent({
        models: bestOf3,
        streams: {
          'claude-sonnet-5': [
            anthropicText('claude-sonnet-5', 100, ['Monday, probably.'], 5),
            anthropicText('claude-sonnet-5', 101, ['Order 4411 ships Monday.'], 7),
            anthropicText('claude-sonnet-5', 101, ['Soon.'], 2),
          ],
          'o4-mini': [openaiText('o4-mini', 90, ['2'], 1)],
        },
      });
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      expect(seen.bodies.map((b) => b.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5', 'o4-mini']);
      // Extra candidates are answers, not more tool work.
      expect(seen.bodies[1].body).not.toHaveProperty('tools');
      expect(seen.bodies[2].body).not.toHaveProperty('tools');
      expect(JSON.stringify(seen.bodies[3].body.messages)).toContain('Option 2: Order 4411 ships Monday.');
      expect(story(seen.run)).toEqual([
        ['llm_call', 'main', 'candidate'],
        ['llm_call', 'main', 'candidate'],
        ['judge', 'checker', null],
        ['llm_call', 'main', 'completed'],
      ]);
      expect(seen.run.steps[2].output).toMatchObject({ strategy: 'best_of_n', picked: 2, candidates: 3, model: 'o4-mini' });
      expect(seen.run.metadata.roleCosts.main.calls).toBe(3);
      expect(seen.run.metadata.roleCosts.checker.cost).toBeCloseTo(cheap(90, 1), 12);
      expect(seen.run.totalCost).toBeCloseTo(dear(100, 5) + dear(101, 7) + dear(101, 2) + cheap(90, 1), 12);
    });

    it('stops making candidates at the run\'s cost ceiling, and pays no judge for one answer', async () => {
      const seen = await runAgent({
        models: bestOf3,
        limits: { maxCostCents: 1 },
        streams: { 'claude-sonnet-5': [anthropicText('claude-sonnet-5', 1000, ['Order 4411 ships Monday.'], 500)] },
      });
      expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      expect(seen.bodies).toHaveLength(1);
      expect(seen.run.steps[0].output).toMatchObject({ status: 'candidate', skipped: 'run limit reached' });
      expect(seen.run.steps[1]).toMatchObject({ type: 'judge', output: { skipped: 'one candidate', picked: 1 } });
    });
  });

  describe('Panel', () => {
    it('each panelist answers too, and the judge writes what they agree on', async () => {
      const seen = await runAgent({
        models: {
          strategy: 'panel',
          roles: [
            MAIN as any,
            { key: 'panelist_1', name: 'Fast', purpose: 'panelist', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o' },
            { key: 'panelist_2', name: 'Careful', purpose: 'panelist', kind: 'model', providerId: 'p-strong', model: 'claude-haiku-5' },
          ],
        },
        streams: {
          'claude-sonnet-5': [
            anthropicText('claude-sonnet-5', 100, ['Monday.'], 3),
            anthropicText('claude-sonnet-5', 120, [JSON.stringify({ agreeing: 2, answer: 'Order 4411 ships Monday.' })], 15),
          ],
          'gpt-4o': [openaiText('gpt-4o', 95, ['It ships Monday.'], 5)],
          'claude-haiku-5': [anthropicText('claude-haiku-5', 95, ['Tuesday.'], 3)],
        },
      });
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      const judgeSaid = JSON.stringify(seen.bodies.find((b, i) => b.model === 'claude-sonnet-5' && i > 0)!.body.messages);
      expect(judgeSaid).toContain('Response 1: Monday.');
      expect(judgeSaid).toContain('It ships Monday.');
      expect(judgeSaid).toContain('Tuesday.');
      const judge = seen.run.steps.find((st: any) => st.type === 'judge') as any;
      expect(judge.role.key).toBe('main');
      expect(judge.output).toMatchObject({ strategy: 'panel', candidates: 3, consensusReached: true });
      expect(judge.output.agreement).toBeCloseTo(2 / 3, 12);
      expect(seen.run.metadata.roleCosts.panelist_1.cost).toBeCloseTo(cheap(95, 5), 12);
      expect(seen.run.metadata.roleCosts.panelist_2.cost).toBeCloseTo(dear(95, 3), 12);
      expect(seen.run.metadata.roleCosts.main.calls).toBe(2);
    });
  });

  describe('Explore, extract, patch', () => {
    it('explorers gather with the tools in their own runs, the summariser writes the brief, the main role answers from it, the checker verifies', async () => {
      const brief = { relevantFiles: [], symbols: [], callers: [], tests: [], notes: 'Order 4411: eta Monday per CRM.' };
      const seen = await runAgent({
        models: {
          strategy: 'explore_extract_patch',
          roles: [
            MAIN as any,
            CHECKER as any,
            { key: 'explorer', name: 'Explorer', purpose: 'explorer', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o-mini' },
            { key: 'summariser', name: 'Summariser', purpose: 'summariser', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o' },
          ],
        },
        streams: {
          'gpt-4o-mini': [
            openaiTool('gpt-4o-mini', 'crm_lookup', { account: '4411' }, 80, 6),
            openaiText('gpt-4o-mini', 110, ['CRM says account 4411 eta Monday.'], 9),
          ],
          'gpt-4o': [openaiText('gpt-4o', 70, [JSON.stringify(brief)], 30)],
          'claude-sonnet-5': [anthropicText('claude-sonnet-5', 130, ['Order 4411 ships Monday.'], 7)],
          'o4-mini': [openaiText('o4-mini', 100, [PASS], 10)],
        },
      });

      expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
      expect(seen.run.output).toBe('Order 4411 ships Monday.');
      // The explorer ran as its own run, on its own model, with the tools, told to gather.
      const explorerFirst = seen.bodies.find((b) => b.model === 'gpt-4o-mini')!.body;
      expect(explorerFirst.tools.map((t: any) => t.name ?? t.function?.name)).toContain('crm_lookup');
      expect(JSON.stringify(explorerFirst.messages)).toContain('You are exploring for another model');
      const child = seen.runRepository.row('child-1')!;
      expect(child).toMatchObject({ parentRunId: 'run-1', status: AgentRunStatus.COMPLETED, metadata: { actAs: 'explorer' } });
      expect(child.steps.map((st: any) => st.role?.key).filter(Boolean)).toEqual(['explorer', 'explorer']);
      // The main role reads the brief, not the transcript.
      const mainSaid = JSON.stringify(seen.bodies.find((b) => b.model === 'claude-sonnet-5')!.body);
      expect(mainSaid).toContain('Brief from exploration');
      expect(mainSaid).toContain('eta Monday per CRM');
      expect(mainSaid).not.toContain('CRM says account 4411 eta Monday.');

      expect(story(seen.run)).toEqual([
        ['explore', 'explorer', 'completed'],
        ['extract_context', 'summariser', null],
        ['verify', 'checker', 'pass'],
        ['llm_call', 'main', 'completed'],
      ]);
      expect(seen.run.workingMemory.brief).toEqual(brief);
      const costs = seen.run.metadata.roleCosts;
      expect(costs.explorer.cost).toBeCloseTo(cheap(80, 6) + cheap(110, 9), 12);
      expect(costs.summariser.cost).toBeCloseTo(cheap(70, 30), 12);
      expect(costs.main.cost).toBeCloseTo(dear(130, 7), 12);
      expect(costs.checker.cost).toBeCloseTo(cheap(100, 10), 12);
      expect(seen.run.totalCost).toBeCloseTo(costs.explorer.cost + costs.summariser.cost + costs.main.cost + costs.checker.cost, 12);
    });

    it('a brief that does not validate fails the run, with what it cost kept', async () => {
      const seen = await runAgent({
        models: {
          strategy: 'explore_extract_patch',
          roles: [
            MAIN as any,
            CHECKER as any,
            { key: 'explorer', name: 'Explorer', purpose: 'explorer', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o-mini' },
            { key: 'summariser', name: 'Summariser', purpose: 'summariser', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o' },
          ],
        },
        streams: {
          'gpt-4o-mini': [openaiText('gpt-4o-mini', 110, ['CRM says eta Monday.'], 9)],
          'gpt-4o': [openaiText('gpt-4o', 70, ['{"notes": "Monday"}'], 30)],
        },
      });
      expect(seen.run.status).toBe(AgentRunStatus.FAILED);
      expect(seen.run.error).toMatch(/did not return a usable brief/);
      expect(seen.bodies.some((b) => b.model === 'claude-sonnet-5')).toBe(false);
      expect(seen.run.totalCost).toBeCloseTo(cheap(110, 9) + cheap(70, 30), 12);
    });
  });

  it('a strategy with an empty slot fails the run and names the slot, rather than running as something else', async () => {
    const seen = await runAgent({
      models: { strategy: 'cascade', roles: [MAIN as any, CHECKER as any] } as any,
      streams: {},
    });
    expect(seen.run.status).toBe(AgentRunStatus.FAILED);
    expect(seen.run.error).toMatch(/Cascade needs a drafter role/);
    expect(seen.bodies).toHaveLength(0);
  });
});
