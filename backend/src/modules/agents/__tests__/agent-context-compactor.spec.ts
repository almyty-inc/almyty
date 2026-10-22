import { AgentContextCompactor } from '../agent-context-compactor.helper';
import { AgentRun } from '../../../entities/agent-run.entity';

/**
 * Unit tests for AgentContextCompactor — the long-run context compaction that
 * folds the old conversation prefix into the system prompt while keeping a
 * verbatim recent tail. Covers: disabled/under-budget no-ops, truncate vs
 * summarize strategies, summary caching, tool-pair safety, and summarizer
 * failure fallback.
 */
describe('AgentContextCompactor', () => {
  let llm: { chat: jest.Mock };
  let compactor: AgentContextCompactor;

  const LONG = 'x'.repeat(2000);
  const SHORT = 'ok';

  const run = (over: Partial<AgentRun> = {}): AgentRun =>
    ({ id: 'run-1', organizationId: 'org-1', userId: 'user-1', workingMemory: {}, ...over } as AgentRun);

  // A realistic autonomous transcript: task → (assistant+toolcall → tool result)* → recent tail.
  const longHistory = () => [
    { role: 'user', content: `TASK ${LONG}` },
    { role: 'assistant', content: `a1 ${LONG}`, toolCalls: [{ id: 'c1', name: 't' }] },
    { role: 'tool', content: `t1 ${LONG}`, toolCallId: 'c1' },
    { role: 'assistant', content: `a2 ${LONG}`, toolCalls: [{ id: 'c2', name: 't' }] },
    { role: 'tool', content: `t2 ${LONG}`, toolCallId: 'c2' },
    { role: 'assistant', content: `a3 ${SHORT}` },
    { role: 'user', content: `follow up ${SHORT}` },
  ];

  const messages = (history: any[]) => [{ role: 'system', content: 'SYSTEM PROMPT' }, ...history];

  beforeEach(() => {
    llm = { chat: jest.fn() };
    compactor = new AgentContextCompactor(llm as any);
  });

  it('is a no-op when compaction is disabled', async () => {
    const msgs = messages(longHistory());
    const res = await compactor.compact(msgs, run(), { enabled: false }, 'org-1');
    expect(res.compacted).toBe(false);
    expect(res.messages).toBe(msgs);
    expect(res.cost).toBe(0);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('is a no-op when the context is under budget', async () => {
    const small = messages([
      { role: 'user', content: SHORT },
      { role: 'assistant', content: SHORT },
    ]);
    const res = await compactor.compact(small, run(), { enabled: true, maxContextTokens: 5000 }, 'org-1');
    expect(res.compacted).toBe(false);
    expect(res.messages.length).toBe(3);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('truncates the prefix without an LLM call under the truncate strategy', async () => {
    const r = run();
    const res = await compactor.compact(
      messages(longHistory()),
      r,
      { enabled: true, maxContextTokens: 1500, keepRecentMessages: 2, strategy: 'truncate', providerId: 'p1' },
      'org-1',
    );
    expect(res.compacted).toBe(true);
    expect(res.cost).toBe(0);
    expect(llm.chat).not.toHaveBeenCalled();
    // Prefix folded into the system message as an omission note; recent tail kept.
    expect(res.messages[0].content).toContain('[EARLIER CONVERSATION SUMMARY]');
    expect(res.messages[0].content).toContain('earlier message(s) omitted');
    expect(res.messages[res.messages.length - 1].content).toContain('follow up');
    expect(r.workingMemory.contextSummary.coveredCount).toBeGreaterThan(0);
  });

  it('summarizes the prefix via the LLM and folds it into the system message', async () => {
    llm.chat.mockResolvedValue({
      message: { content: 'CONDENSED SUMMARY OF EARLIER TURNS' },
      usage: { totalTokens: 42 },
      cost: 0.01,
    });
    const r = run();
    const res = await compactor.compact(
      messages(longHistory()),
      r,
      { enabled: true, maxContextTokens: 1500, keepRecentMessages: 2, strategy: 'summarize', providerId: 'p1' },
      'org-1',
      'user-1',
    );
    expect(res.compacted).toBe(true);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(res.cost).toBe(0.01);
    expect(res.tokens).toBe(42);
    expect(res.messages[0].content).toContain('CONDENSED SUMMARY OF EARLIER TURNS');
    // System message is preserved, not replaced.
    expect(res.messages[0].content).toContain('SYSTEM PROMPT');
    expect(res.messages[0].role).toBe('system');
    expect(r.workingMemory.contextSummary.text).toContain('CONDENSED SUMMARY');
  });

  it('keeps tool/assistant pairs intact — the tail never starts with an orphan tool result', async () => {
    llm.chat.mockResolvedValue({ message: { content: 'S' }, usage: { totalTokens: 1 }, cost: 0 });
    const res = await compactor.compact(
      messages(longHistory()),
      run(),
      // keepRecent=3 places the raw boundary on a 'tool' message; it must move back to the assistant.
      { enabled: true, maxContextTokens: 1500, keepRecentMessages: 3, strategy: 'summarize', providerId: 'p1' },
      'org-1',
    );
    const tail = res.messages.slice(1);
    expect(tail[0].role).not.toBe('tool');
    expect(['user', 'assistant']).toContain(tail[0].role);
  });

  it('reuses the cached summary on a later step instead of re-summarizing', async () => {
    llm.chat.mockResolvedValue({ message: { content: 'SUM' }, usage: { totalTokens: 5 }, cost: 0.02 });
    const r = run();
    const cfg = {
      enabled: true,
      maxContextTokens: 1500,
      keepRecentMessages: 2,
      strategy: 'summarize' as const,
      providerId: 'p1',
    };
    // First call: over budget → summarizes once.
    await compactor.compact(messages(longHistory()), r, cfg, 'org-1');
    expect(llm.chat).toHaveBeenCalledTimes(1);
    // Second call: cache renders a small context (summary + short tail) under budget → no new call.
    const res2 = await compactor.compact(messages(longHistory()), r, cfg, 'org-1');
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(res2.compacted).toBe(true);
    expect(res2.cost).toBe(0);
    expect(res2.messages[0].content).toContain('SUM');
  });

  it('falls back to a truncation note when the summarizer throws', async () => {
    llm.chat.mockRejectedValue(new Error('provider exploded'));
    const res = await compactor.compact(
      messages(longHistory()),
      run(),
      { enabled: true, maxContextTokens: 1500, keepRecentMessages: 2, strategy: 'summarize', providerId: 'p1' },
      'org-1',
    );
    expect(res.compacted).toBe(true);
    expect(res.messages[0].content).toContain('earlier message(s) omitted');
  });

  // The history is the conversation's newest messages (agent-runtime-builders.ts
  // loads the last 100), so in a long always-on conversation it slides
  // forward one step at a time. A summary that remembered only how many
  // leading messages it covered then pointed past the messages that slid
  // under it: they were in neither the summary nor the tail, and a run lost
  // its own earlier tool results a few steps in.
  it('finds where the summary ends after the window slides, and skips nothing', async () => {
    llm.chat.mockResolvedValue({ message: { content: 'SUMMARY' }, cost: 0, usage: { totalTokens: 1 } });
    const pair = (n: number) => [
      { role: 'assistant', content: `a${n} ${LONG}`, toolCalls: [{ id: `c${n}`, name: 't' }] },
      { role: 'tool', content: `t${n} ${LONG}`, toolCallId: `c${n}` },
    ]
    const conversation = [{ role: 'user', content: `TASK ${LONG}` }, ...[1, 2, 3, 4, 5, 6].flatMap(pair)]
    const window = (from: number, to: number) => messages(conversation.slice(from, to))
    const config = { enabled: true, maxContextTokens: 3000, keepRecentMessages: 4, providerId: 'p1' }
    const r = run()

    // Step 1: messages 0..8 are in the window; the prefix is summarized, 4 kept.
    const first = await compactor.compact(window(0, 9), r, config, 'org-1')
    const firstTail = first.messages.slice(1).map((m: any) => m.content.split(' ')[0])
    expect(firstTail).toEqual(['a3', 't3', 'a4', 't4'])

    // Step 2: two new messages arrived and the window dropped its oldest two.
    const second = await compactor.compact(window(2, 11), r, config, 'org-1')
    // a3 and t3 were after the summary and are no longer in the tail: they
    // must have gone into the summary, not vanished.
    expect(llm.chat).toHaveBeenCalledTimes(2)
    const folded = llm.chat.mock.calls[1][1].messages[1].content as string
    expect(folded).toContain(`assistant: a3 `)
    expect(folded).toContain(`tool: t3 `)
    expect(second.messages.slice(1).map((m: any) => m.content.split(' ')[0])).toEqual(['a4', 't4', 'a5', 't5'])
  })
});
