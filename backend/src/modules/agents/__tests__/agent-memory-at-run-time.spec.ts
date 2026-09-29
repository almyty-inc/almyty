import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { gatewayPrincipal } from '../../../common/authorization/execution-access.service';
import { anthropicText, anthropicTool, mainModelConfig, runAgent } from './autonomous-harness';

jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

/**
 * An autonomous agent's Memory section, honoured at run time.
 *
 * Each case drives the real step processor with only the provider socket
 * and the memory store faked, and checks what a person would: whose memory
 * the run read and wrote (the scope), what was saved (facts, the exchange,
 * or nothing unless asked), that the never-save rules were applied by the
 * agent's model before anything was written, how long it is kept, and the
 * account it went to.
 */

const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-strong', model: 'claude-sonnet-5' } as const;
const single = { strategy: 'single', roles: [MAIN] } as any;
const ANSWER = 'Order 4411 ships Monday.';
const QUESTION = 'Where is my order 4411?';
const EXCHANGE = `Person: ${QUESTION}\nAgent: ${ANSWER}`;

function memoryDouble() {
  return {
    put: jest.fn(async (..._args: any[]) => ({ id: `mem-${Math.random().toString(16).slice(2, 8)}` })),
    search: jest.fn(async (..._args: any[]) => [{ item: { tier: 'long', content: 'Dana prefers email over phone' }, score: 0.9, signal: 'hybrid' }]),
  };
}

async function run(memoryConfig: Record<string, any>, streams: string[][], extra: { run?: Record<string, any> } = {}) {
  const memoryAccounts = memoryDouble();
  const seen = await runAgent({
    models: single,
    modelConfig: mainModelConfig,
    streams: { 'claude-sonnet-5': streams },
    agent: { memoryConfig },
    memoryAccounts,
    run: extra.run,
  });
  expect(seen.leftover).toEqual({});
  expect(seen.run.error ?? null).toBeNull();
  expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
  return { ...seen, memoryAccounts };
}

const bodyText = (b: { body: any }) => JSON.stringify(b.body);
const saves = (m: ReturnType<typeof memoryDouble>) => m.put.mock.calls.map((c: any[]) => ({ account: c[1], ...c[2], actor: c[3], opts: c[4] }));
const visitor = {
  userId: null,
  endUserId: 'eu-7',
  principal: gatewayPrincipal({ id: 'gw-1', organizationId: 'org-1', visibility: 'org' } as any),
};

describe("an agent's memory settings at run time", () => {
  it('per person, saved only when asked: reads the member\'s own memory, saves nothing on its own', async () => {
    const seen = await run({ enabled: true, whose: 'person', save: 'asked' }, [anthropicText('claude-sonnet-5', 100, [ANSWER], 8)]);

    expect(seen.memoryAccounts.search).toHaveBeenCalledTimes(1);
    const [org, account, query] = seen.memoryAccounts.search.mock.calls[0] as any[];
    expect([org, account, query.scope, query.query]).toEqual(['org-1', 'almyty-native', { scope_type: 'user', scope_id: 'org-1:user:u-1' }, QUESTION]);
    // What it recalled reached the model.
    expect(bodyText(seen.bodies[0])).toContain('Dana prefers email over phone');
    // The tool says when to save.
    const storeTool = seen.bodies[0].body.tools.find((t: any) => t.name === 'store_memory');
    expect(storeTool.description).toContain('only when the person asks you to remember it');
    expect(seen.memoryAccounts.put).not.toHaveBeenCalled();
    expect(seen.run.steps.some((st: any) => st.type === 'memory_save')).toBe(false);
  });

  it("per agent, facts, kept 30 days, in an outside account: the main model picks the facts under the rules, each is saved to the agent's own memory there", async () => {
    const seen = await run(
      { enabled: true, whose: 'agent', save: 'facts', account: 'mem0', retentionDays: 30, neverSave: 'payment details\nhealth information' },
      [
        anthropicText('claude-sonnet-5', 100, [ANSWER], 8),
        anthropicText('claude-sonnet-5', 60, ['{"facts": ["Order 4411 belongs to Dana", "Dana prefers email"]}'], 20),
      ],
    );

    // The facts call: on the main model, over the exchange, with the rules.
    const factsCall = bodyText(seen.bodies[1]);
    expect(seen.bodies[1].model).toBe('claude-sonnet-5');
    expect(factsCall).toContain('Answer with JSON only');
    expect(factsCall).toContain('payment details');
    expect(factsCall).toContain('health information');
    expect(factsCall).toContain('Agent: Order 4411 ships Monday.');

    expect(saves(seen.memoryAccounts)).toEqual([
      expect.objectContaining({
        account: 'mem0',
        scope: { scope_type: 'agent', scope_id: 'org-1:agent:agent-1' },
        content: 'Order 4411 belongs to Dana',
        tier: 'long',
        tags: ['auto-saved', 'fact'],
        actor: { user_id: 'u-1' },
        opts: { agentId: 'agent-1', expiresInSeconds: 30 * 86400 },
      }),
      expect.objectContaining({ content: 'Dana prefers email', opts: { agentId: 'agent-1', expiresInSeconds: 30 * 86400 } }),
    ]);
    // Read from the same memory it writes.
    expect((seen.memoryAccounts.search.mock.calls[0] as any[])[1]).toBe('mem0');
    expect((seen.memoryAccounts.search.mock.calls[0] as any[])[2].scope).toEqual({ scope_type: 'agent', scope_id: 'org-1:agent:agent-1' });

    // The facts call is the run's cost, on the stored row too.
    const stored = seen.runRepository.row('run-1')!;
    const step = stored.steps.find((st: any) => st.type === 'memory_save') as any;
    expect(step).toMatchObject({ role: { key: 'main' }, input: { save: 'facts', scope: 'agent', account: 'mem0' }, output: { saved: 2 } });
    expect(step.cost).toBeGreaterThan(0);
    expect(stored.totalTokens).toBe(100 + 8 + 60 + 20);
  });

  it('full conversations: the exchange is screened against the rules by the main model, and what is left is saved', async () => {
    const screened = `Person: ${QUESTION}\nAgent: ${ANSWER}`;
    const seen = await run(
      { enabled: true, whose: 'shared', save: 'conversations', neverSave: 'card numbers' },
      [anthropicText('claude-sonnet-5', 100, [ANSWER], 8), anthropicText('claude-sonnet-5', 50, [screened], 20)],
    );
    const screen = bodyText(seen.bodies[1]);
    expect(screen).toContain('Never save');
    expect(screen).toContain('card numbers');
    expect(saves(seen.memoryAccounts)).toEqual([
      expect.objectContaining({
        account: 'almyty-native',
        scope: { scope_type: 'workspace', scope_id: 'org-1' },
        content: screened,
        tier: 'project',
        tags: ['auto-saved', 'conversation'],
        opts: { agentId: 'agent-1', expiresInSeconds: null },
      }),
    ]);
  });

  it('full conversations without rules: the exchange is saved as said, with no screening call', async () => {
    const seen = await run({ enabled: true, save: 'conversations' }, [anthropicText('claude-sonnet-5', 100, [ANSWER], 8)]);
    expect(seen.bodies).toHaveLength(1);
    expect(saves(seen.memoryAccounts).map((s) => s.content)).toEqual([EXCHANGE]);
  });

  it('when the rules cover all of it, nothing is saved and the step says why', async () => {
    const seen = await run(
      { enabled: true, save: 'conversations', neverSave: 'anything about orders' },
      [anthropicText('claude-sonnet-5', 100, [ANSWER], 8), anthropicText('claude-sonnet-5', 50, ['NOTHING'], 1)],
    );
    expect(seen.memoryAccounts.put).not.toHaveBeenCalled();
    const step = seen.runRepository.row('run-1')!.steps.find((st: any) => st.type === 'memory_save') as any;
    expect(step.output).toEqual({ saved: 0, dropped: 'never-save rules' });
  });

  it("the agent's own save (store_memory) is screened too: only what the rules leave is written", async () => {
    const seen = await run(
      { enabled: true, whose: 'person', save: 'asked', neverSave: 'card numbers' },
      [
        anthropicTool('claude-sonnet-5', 'store_memory', { content: 'Card 4242 4242 4242 4242. Prefers email.', type: 'preference' }, 100, 12),
        anthropicText('claude-sonnet-5', 40, ['Prefers email.'], 4),
        anthropicText('claude-sonnet-5', 130, ['Noted.'], 3),
      ],
    );
    expect(bodyText(seen.bodies[1])).toContain('card numbers');
    expect(saves(seen.memoryAccounts)).toEqual([
      expect.objectContaining({ content: 'Prefers email.', tier: 'long', scope: { scope_type: 'user', scope_id: 'org-1:user:u-1' } }),
    ]);
  });

  describe('a visitor, per person', () => {
    it("is read their own memory, and nothing is saved while the visitor rules do not allow keeping it", async () => {
      const seen = await run({ enabled: true, whose: 'person', save: 'facts' }, [anthropicText('claude-sonnet-5', 100, [ANSWER], 8)], {
        run: { ...visitor, metadata: {} },
      });
      expect((seen.memoryAccounts.search.mock.calls[0] as any[])[2].scope).toEqual({ scope_type: 'user', scope_id: 'org-1:user:visitor:eu-7' });
      expect(seen.bodies).toHaveLength(1);
      expect(seen.memoryAccounts.put).not.toHaveBeenCalled();
    });

    it("keeps the visitor's facts in the visitor's own memory when the visitor rules allow it", async () => {
      const seen = await run(
        { enabled: true, whose: 'person', save: 'facts' },
        [anthropicText('claude-sonnet-5', 100, [ANSWER], 8), anthropicText('claude-sonnet-5', 60, ['{"facts": ["Asked about order 4411"]}'], 9)],
        { run: { ...visitor, metadata: { visitorMemory: true } } },
      );
      expect(saves(seen.memoryAccounts)).toEqual([
        expect.objectContaining({ content: 'Asked about order 4411', scope: { scope_type: 'user', scope_id: 'org-1:user:visitor:eu-7' } }),
      ]);
    });
  });

  it('per person on a run for nobody (a heartbeat): no memory is read or written', async () => {
    const seen = await run({ enabled: true, whose: 'person', save: 'facts' }, [anthropicText('claude-sonnet-5', 100, [ANSWER], 8)], {
      run: { userId: null },
    });
    expect(seen.memoryAccounts.search).not.toHaveBeenCalled();
    expect(seen.memoryAccounts.put).not.toHaveBeenCalled();
  });

  it('memory off: the memory tools are not offered, and a call to one anyway writes nothing', async () => {
    const seen = await run({ enabled: false }, [
      anthropicTool('claude-sonnet-5', 'store_memory', { content: 'remember this' }, 100, 12),
      anthropicText('claude-sonnet-5', 130, ['Done.'], 3),
    ]);
    expect(seen.bodies[0].body.tools.map((t: any) => t.name)).not.toContain('store_memory');
    const refused = seen.run.steps.find((st: any) => st.type === 'tool_call') as any;
    expect(refused.error).toBe("Tool 'store_memory' not found");
    expect(seen.memoryAccounts.put).not.toHaveBeenCalled();
    expect(seen.memoryAccounts.search).not.toHaveBeenCalled();
  });

  it("an account of the agent's own: every read and write names its connection, used as the run's principal", async () => {
    const seen = await run(
      { enabled: true, whose: 'agent', save: 'conversations', account: 'mem0', credentialId: 'cred-own' },
      [anthropicText('claude-sonnet-5', 100, [ANSWER], 8)],
    );
    const use = { credentialId: 'cred-own', agentId: 'agent-1', principal: expect.objectContaining({ kind: 'user' }) };
    expect((seen.memoryAccounts.search.mock.calls[0] as any[])[3]).toEqual(use);
    expect(saves(seen.memoryAccounts)).toEqual([
      expect.objectContaining({ account: 'mem0', opts: { agentId: 'agent-1', expiresInSeconds: null, ...use } }),
    ]);
  });
});
