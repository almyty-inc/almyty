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

  // Where the summary ends is found again each step from the messages either
  // side of that edge. Each case below lost or re-folded messages before.
  describe('finding where the summary ends in a sliding window', () => {
    const config = { enabled: true, maxContextTokens: 3000, keepRecentMessages: 4, providerId: 'p1' };
    const label = (m: any) => String(m.content).split(' ')[0];
    // A plain chat: m0 (user), m1 (assistant), m2 (user), ... ~500 tokens each.
    const chat = (n: number, rename: Record<number, string> = {}) =>
      Array.from({ length: n }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `${rename[i] ?? `m${i}`} ${LONG}`,
      }));
    // The messages each summarizer call was asked to fold in, by label.
    const foldedPerCall = (): string[][] =>
      llm.chat.mock.calls.map((c: any[]) => {
        const prompt = c[1].messages[1].content as string;
        return prompt
          .split('NEW MESSAGES TO FOLD IN:\n')[1]
          .split('\n')
          .map((line) => line.slice(line.indexOf(': ') + 2).split(' ')[0]);
      });
    const tail = (res: { messages: any[] }) => res.messages.slice(1).map(label);

    beforeEach(() => {
      llm.chat.mockResolvedValue({ message: { content: 'SUMMARY' }, cost: 0, usage: { totalTokens: 1 } });
    });

    it('folds every message exactly once as the window slides step after step', async () => {
      const conversation = chat(31);
      const r = run();
      for (let from = 0; from + 9 <= conversation.length; from += 2) {
        const res = await compactor.compact(messages(conversation.slice(from, from + 9)), r, config, 'org-1');
        const folded = foldedPerCall().flat();
        // Nothing folded twice, and every message up to the newest is in the
        // summary or the tail: none fell between the two.
        expect(new Set(folded).size).toBe(folded.length);
        expect([...folded, ...tail(res)]).toEqual(conversation.slice(0, from + 9).map(label));
        expect(r.workingMemory.contextSummary.foldedTotal).toBe(folded.length);
      }
      expect(llm.chat.mock.calls.length).toBeGreaterThan(5);
    });

    it('ends the summary after the last message it covers when the next one was edited', async () => {
      const r = run();
      await compactor.compact(messages(chat(9)), r, config, 'org-1');
      expect(foldedPerCall()).toEqual([['m0', 'm1', 'm2', 'm3', 'm4']]);

      // m5, the first message after the summary, now reads differently.
      const edited = chat(11, { 5: 'm5edited' }).slice(2);
      const res = await compactor.compact(messages(edited), r, config, 'org-1');
      expect(foldedPerCall()[1]).toEqual(['m5edited', 'm6']);
      expect(tail(res)).toEqual(['m7', 'm8', 'm9', 'm10']);
    });

    it('ends the summary after the last message it covers when the next one was removed', async () => {
      const r = run();
      await compactor.compact(messages(chat(9)), r, config, 'org-1');

      const withoutM5 = chat(12).filter((_, i) => i !== 5).slice(2);
      const res = await compactor.compact(messages(withoutM5), r, config, 'org-1');
      expect(foldedPerCall()[1]).toEqual(['m6', 'm7']);
      expect(tail(res)).toEqual(['m8', 'm9', 'm10', 'm11']);
    });

    it('treats every message as new once the window has moved past the whole summary', async () => {
      const r = run();
      await compactor.compact(messages(chat(9)), r, config, 'org-1');

      const res = await compactor.compact(messages(chat(19).slice(10)), r, config, 'org-1');
      expect(foldedPerCall()[1]).toEqual(['m10', 'm11', 'm12', 'm13', 'm14']);
      expect(tail(res)).toEqual(['m15', 'm16', 'm17', 'm18']);
      // The earlier summary is kept and grown, not thrown away.
      expect(r.workingMemory.contextSummary.text).toBe('SUMMARY\nSUMMARY');
    });

    it('is not misled by the same text earlier in the window', async () => {
      const r = run();
      // m3 and m5 read the same ("same"): m5 is the first message after the summary.
      const conversation = chat(11, { 3: 'same', 5: 'same' });
      await compactor.compact(messages(conversation.slice(0, 9)), r, config, 'org-1');
      expect(foldedPerCall()[0]).toEqual(['m0', 'm1', 'm2', 'same', 'm4']);

      const res = await compactor.compact(messages(conversation.slice(2)), r, config, 'org-1');
      expect(foldedPerCall()[1]).toEqual(['same', 'm6']);
      expect(res.folded).toBe(2);
      expect(tail(res)).toEqual(['m7', 'm8', 'm9', 'm10']);
    });

    it('reports what it folded, which coveredCount cannot once the window moves', async () => {
      const r = run();
      const conversation = chat(11);
      const first = await compactor.compact(messages(conversation.slice(0, 9)), r, config, 'org-1');
      expect(first.folded).toBe(5);
      expect(r.workingMemory.contextSummary).toMatchObject({ coveredCount: 5, foldedTotal: 5 });

      const second = await compactor.compact(messages(conversation.slice(2)), r, config, 'org-1');
      // Two more messages were folded, yet the summary ends at index 5 of
      // this window just as it did in the last one.
      expect(second.folded).toBe(2);
      expect(r.workingMemory.contextSummary).toMatchObject({ coveredCount: 5, foldedTotal: 7 });

      // Reusing the cached summary folds nothing.
      const third = await compactor.compact(messages(conversation.slice(2, 8)), r, config, 'org-1');
      expect(third).toMatchObject({ compacted: true, folded: 0 });
    });
  });
});
