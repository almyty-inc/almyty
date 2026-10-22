import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentContextCompactor, carriedContextSummary, tagStoredMessage } from '../agent-context-compactor.helper';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * A run of a standing thread (always on) or a chat starts from the summary
 * the previous run of its conversation left. The summary names the message
 * it ends at, so it is found again in a window that has moved on; the
 * summarizer's merged summary replaces the old one instead of being
 * appended to it.
 */
describe('A conversation summary carried from run to run', () => {
  const LONG = 'x'.repeat(4000);
  const stored = (i: number, role: string, content: string, extra: Record<string, any> = {}) => {
    const entry: any = { role, content, ...extra };
    tagStoredMessage(entry, { id: `m${i}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) });
    return entry;
  };
  const thread = (from: number, to: number) => {
    const out: any[] = [];
    for (let i = from; i < to; i++) out.push(stored(i, i % 2 ? 'assistant' : 'user', `${i} ${LONG}`));
    return out;
  };
  const system = { role: 'system', content: 'SYSTEM' };

  it('keeps the message ids off what a provider is sent', () => {
    const entry = stored(1, 'user', 'hi');
    expect(JSON.parse(JSON.stringify(entry))).toEqual({ role: 'user', content: 'hi' });
    expect({ ...entry }).toEqual({ role: 'user', content: 'hi' });
  });

  it('finds where the summary ends in a later window, and summarizes only what came after it', async () => {
    const llm = { chat: jest.fn(async () => ({ message: { content: 'MERGED SUMMARY' }, usage: { totalTokens: 10 }, cost: 0 })) };
    const compactor = new AgentContextCompactor(llm as any);
    const config = { enabled: true, providerId: 'p', maxContextTokens: 6000, keepRecentMessages: 2 };

    const first: any = { id: 'r1', organizationId: 'o', conversationId: 'c', workingMemory: {} };
    await compactor.compact([system, ...thread(0, 10)], first, config, 'o');
    const left = first.workingMemory.contextSummary;
    expect(left).toMatchObject({ throughId: 'm7', text: 'MERGED SUMMARY' });

    // The next run's window starts four messages later and has four new ones.
    const runs = fakeRepository<any>([{ id: 'r1', conversationId: 'c', createdAt: new Date(1), workingMemory: first.workingMemory }]);
    const second: any = { id: 'r2', organizationId: 'o', conversationId: 'c', workingMemory: {} };
    const carried = await carriedContextSummary(runs as any, second);
    expect(carried).toEqual(left);
    second.workingMemory.contextSummary = carried;

    llm.chat.mockClear();
    const out = await compactor.compact([system, ...thread(4, 14)], second, config, 'o');
    // m8..m11 folded in (m12, m13 kept), and nothing from before m8 sent again.
    const transcript = (llm.chat.mock.calls[0] as any[])[1].messages[1].content as string;
    expect(transcript).toContain('PRIOR SUMMARY:\nMERGED SUMMARY');
    expect(transcript).toMatch(/^user: 8 /m);
    expect(transcript).not.toMatch(/^(user|assistant): [4-7] /m);
    expect(transcript).not.toMatch(/^(user|assistant): 1[23] /m);
    // The merged summary replaces the prior one; it is not appended to it.
    expect(second.workingMemory.contextSummary).toMatchObject({ throughId: 'm11', text: 'MERGED SUMMARY' });
    expect(out.messages[0].content.match(/MERGED SUMMARY/g)).toHaveLength(1);
    expect(out.messages.slice(1).map((m: any) => m.content.split(' ')[0])).toEqual(['12', '13']);
  });

  it("cuts an earlier run's tool results when asked, and never this run's", async () => {
    const compactor = new AgentContextCompactor({ chat: jest.fn() } as any);
    const history = [
      stored(1, 'user', 'wake 1'),
      stored(2, 'assistant', '', { toolCalls: [{ id: 'a', name: 'call_tool' }] }),
      stored(3, 'tool', 'y'.repeat(9000), { toolCallId: 'a' }),
      stored(4, 'assistant', 'nothing new'),
      stored(10, 'user', 'wake 2'),
      stored(11, 'assistant', '', { toolCalls: [{ id: 'b', name: 'call_tool' }] }),
      stored(12, 'tool', 'z'.repeat(9000), { toolCallId: 'b' }),
    ];
    const run: any = { id: 'r2', organizationId: 'o', createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 9)), workingMemory: {} };

    const out = await compactor.compact([system, ...history], run, { enabled: true, earlierToolResultChars: 2000, maxContextTokens: 100_000 }, 'o');

    expect(out.messages[3].content).toMatch(/^y{2000}\n\[cut: 7000 more characters of an earlier tool result\]$/);
    expect(out.messages[7].content).toBe('z'.repeat(9000));
    // Off unless set.
    const whole = await compactor.compact([system, ...history], { ...run, workingMemory: {} }, { enabled: true, maxContextTokens: 100_000 }, 'o');
    expect(whole.messages[3].content).toBe('y'.repeat(9000));
  });

  it('carries nothing to a run that has its own, and nothing that is a bare count', async () => {
    const runs = fakeRepository<any>([
      { id: 'old', conversationId: 'c', createdAt: new Date(1), workingMemory: { contextSummary: { coveredCount: 5, text: 'S' } } },
    ]);
    expect(await carriedContextSummary(runs as any, { id: 'new', conversationId: 'c', workingMemory: {} } as any)).toBeNull();
    expect(
      await carriedContextSummary(runs as any, { id: 'new', conversationId: 'c', workingMemory: { contextSummary: { coveredCount: 1, text: 'own' } } } as any),
    ).toBeNull();
  });

  it('is what the step processor starts a compacted run from', () => {
    const source = readFileSync(join(__dirname, '../agent-step-processor.ts'), 'utf8');
    const carry = source.indexOf('carriedContextSummary(this.s.runRepository, run)');
    expect(carry).toBeGreaterThan(-1);
    expect(carry).toBeLessThan(source.indexOf('this.compactor.compact('));
    const builders = readFileSync(join(__dirname, '../agent-runtime-builders.ts'), 'utf8');
    expect(builders).toMatch(/tagStoredMessage\(msgObj, msg\)/);
  });
});
