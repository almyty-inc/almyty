import { ALWAYS_ON_COMPACTION, AgentContextCompactor, carriedContextSummary } from '../../agent-context-compactor.helper';
import { AgentRuntimeBuilders } from '../../agent-runtime-builders';
import { META_TOOL_DEFINITIONS } from '../../../tool-discovery/meta-tools';
import { Message } from '../../../../entities/message.entity';
import { fakeRepository } from '../../../../test/fake-repository';

/**
 * What one always-on wake that only looks costs, measured.
 *
 * A wake that finds nothing to do still makes four model calls on the
 * standing thread: search_tools, get_tool, call_tool (read the inbox) and
 * the one-line answer. This drives the real message builder and the real
 * compactor over a standing thread through those four steps per wake, the
 * way AgentStepProcessor does (always on is always compacted), and counts
 * what each call is sent: the messages, the tool definitions, and any
 * summarizer call, with the compactor's own estimate (4 characters a token).
 *
 * The sizes are what a mail-watching agent's steps look like: a wake
 * message of ~600 characters, a search_tools answer of ~2,400, a get_tool
 * schema of ~2,000, an inbox listing of ~16,000 and a short answer.
 *
 * Set WAKE_COST_REPORT=1 to print the per-wake numbers.
 */
const ORG = 'org-1';
const CONV = 'conv-standing';
const SUMMARY = 'S'.repeat(1600);
const chars = (n: number, tag: string) => `${tag} ${'x'.repeat(n)}`;

const estimate = (messages: any[]) => {
  let n = 0;
  for (const m of messages) {
    const c = m?.content;
    n += (typeof c === 'string' ? c : JSON.stringify(c ?? '')).length;
    if (m?.toolCalls) n += JSON.stringify(m.toolCalls).length;
  }
  return Math.ceil(n / 4);
};

interface Measured {
  perWake: number[];
  summarizerPerWake: number[];
  mainPerWake: number[];
}

async function simulate(wakes: number): Promise<Measured> {
  const messages = fakeRepository<Message>({ idPrefix: 'msg' });
  const runs = fakeRepository<any>({ idPrefix: 'run' });
  const builders = new AgentRuntimeBuilders(messages as any, { listActiveRules: async () => [] } as any);
  const llm = {
    chat: jest.fn(async (_provider: string, req: any) => ({
      message: { content: SUMMARY },
      usage: { totalTokens: estimate(req.messages) + SUMMARY.length / 4 },
      cost: 0,
    })),
  };
  const compactor = new AgentContextCompactor(llm as any);
  const agent: any = {
    id: 'agent-1',
    instructions: chars(1500, 'Watch my inbox and tell me about anything urgent.'),
    modelConfig: { providerId: 'p-1', model: 'm' },
    agentConfig: {},
  };
  const toolDefs = [...META_TOOL_DEFINITIONS, ...builders.buildToolDefinitions([], agent)];
  const toolTokens = Math.ceil(JSON.stringify(toolDefs).length / 4);

  let clock = Date.parse('2026-10-01T00:00:00Z');
  const save = async (m: Message) => {
    m.createdAt = new Date((clock += 1000));
    await messages.save(m);
  };

  const out: Measured = { perWake: [], summarizerPerWake: [], mainPerWake: [] };
  for (let w = 0; w < wakes; w++) {
    const run: any = {
      id: `run-${w}`,
      organizationId: ORG,
      conversationId: CONV,
      metadata: { triggerType: 'always_on' },
      workingMemory: {},
      createdAt: new Date(clock),
    };
    await save(Message.createUserMessage(CONV, chars(600, `You are always on, and something woke you (wake ${w}).`)));

    // What each step leaves in the thread after its call.
    const steps: Array<() => Promise<void>> = [
      async () => {
        await save(Message.createToolCallMessage(CONV, [{ id: `s${w}`, name: 'search_tools', arguments: { query: 'unread mail' } } as any]));
        await save(Message.createToolResultMessage(CONV, `s${w}`, chars(2400, 'matches')));
      },
      async () => {
        await save(Message.createToolCallMessage(CONV, [{ id: `g${w}`, name: 'get_tool', arguments: { name: 'gmail_users_messages_list' } } as any]));
        await save(Message.createToolResultMessage(CONV, `g${w}`, chars(2000, 'schema')));
      },
      async () => {
        await save(Message.createToolCallMessage(CONV, [{ id: `c${w}`, name: 'call_tool', arguments: { name: 'gmail_users_messages_list', arguments: { q: 'is:unread' } } } as any]));
        await save(Message.createToolResultMessage(CONV, `c${w}`, chars(16000, 'inbox')));
      },
      async () => {
        await save(Message.createAssistantMessage(CONV, 'Nothing new that needs you.'));
      },
    ];

    let main = 0;
    let summarizer = 0;
    for (const step of steps) {
      const built = await builders.buildMessages(agent, run, [], '', undefined, { discover: true });
      // As AgentStepProcessor does before it compacts.
      const carried = await carriedContextSummary(runs, run);
      if (carried) run.workingMemory = { ...run.workingMemory, contextSummary: carried };
      const compacted = await compactor.compact(built, run, { ...ALWAYS_ON_COMPACTION, enabled: true, providerId: 'p-1' }, ORG, 'owner-1');
      main += estimate(compacted.messages) + toolTokens;
      summarizer += compacted.tokens;
      await step();
    }
    await runs.save(run);
    out.mainPerWake.push(main);
    out.summarizerPerWake.push(summarizer);
    out.perWake.push(main + summarizer);
  }
  return out;
}

const report = (label: string, m: Measured) => {
  if (process.env.WAKE_COST_REPORT !== '1') return;
  const rows = m.perWake.map((t, i) => `  wake ${String(i + 1).padStart(2)}: ${String(t).padStart(7)} tokens (calls ${m.mainPerWake[i]}, summarizer ${m.summarizerPerWake[i]})`);
  process.stdout.write(`${label}\n${rows.join('\n')}\n`);
};

describe('An always-on wake that only looks', () => {
  it('costs what four calls over a compacted thread cost, not a re-summary of the whole thread', async () => {
    const measured = await simulate(30);
    report('always-on wake cost', measured);

    // Once the thread is long (a day of hourly wakes), a wake that only looks.
    // Measured with this harness: before, every wake re-summarized the whole
    // history window (~64k summarizer tokens) and cost ~92k-99k; now ~22k-44k,
    // ~32k on average, the summarizer folding in only the last few wakes.
    const steady = measured.perWake.slice(15);
    const mean = steady.reduce((a, b) => a + b, 0) / steady.length;
    expect(mean).toBeLessThan(40_000);
    expect(Math.max(...steady)).toBeLessThan(50_000);
    expect(Math.max(...measured.summarizerPerWake.slice(15))).toBeLessThan(12_000);
  });
});
