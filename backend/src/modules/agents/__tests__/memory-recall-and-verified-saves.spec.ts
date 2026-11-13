import { readFileSync } from 'fs';
import { join } from 'path';

import { AgentMemoryKeeper, recallQueryOf, verificationFailed } from '../agent-memory.keeper';
import { memoryScopeFor, memorySettings } from '../agent-memory-settings';

/**
 * Found building agents on staging:
 *  - a new agent's memory was the organization's shared one, so its Memory
 *    tab showed every other agent's memories;
 *  - an autonomous run with memory on answered without looking anything
 *    up: recall only ran when the run had a conversation, searched with
 *    the newest user message (by the second answer, the verifier's
 *    feedback), and left no trace on the run;
 *  - facts were saved from an answer the verification panel rejected.
 */

const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model' } as any;
const RANKED = [{ item: { id: 'm1', mode: 'memory', tier: 'long', content: 'billing-service pinned lodash at 4.17.21 on 2026-11-04' }, score: 0.9 }];

function keeper(facts: string[] = ['billing-service uses express 5.1.0']) {
  const memoryAccounts = { put: jest.fn(async () => ({ id: 'mem-1' })), search: jest.fn(async () => RANKED) };
  const callModel = jest.fn(async () => ({ content: JSON.stringify({ facts }) }));
  const k = new AgentMemoryKeeper({ memoryAccounts, logger: { warn: jest.fn() } } as any, { callModel } as any);
  return { k, memoryAccounts, callModel };
}

const agent = (memoryConfig: any) => ({ id: 'agent-1', name: 'Dependency Check', memoryConfig }) as any;
const run = (over: any = {}) =>
  ({
    id: 'run-1', organizationId: 'org-1', userId: 'u-1', endUserId: null, conversationId: null,
    input: { message: 'Check billing-service again and tell me what changed since your last check' },
    output: 'express is current; lodash is behind.', steps: [] as any[], totalCost: 0, metadata: {}, workingMemory: {},
    ...over,
  }) as any;

describe("an agent's memory is its own unless someone picks shared", () => {
  it('defaults to the agent scope, on the server', () => {
    expect(memorySettings({ enabled: true }).whose).toBe('agent');
    expect(memoryScopeFor(agent({ enabled: true }), run())).toEqual({ scope_type: 'agent', scope_id: 'org-1:agent:agent-1' });
  });

  it('is shared only when picked', () => {
    expect(memoryScopeFor(agent({ enabled: true, whose: 'shared' }), run())).toEqual({ scope_type: 'workspace', scope_id: 'org-1' });
  });
});

describe('recall at the start of a run', () => {
  it('looks memory up before the first answer, with what the person asked, even with no conversation', async () => {
    const { k, memoryAccounts } = keeper();
    const r = run();
    const conversationQuery = jest.fn(async () => '');

    const context = await k.recallAtStart(agent({ enabled: true }), r, conversationQuery);

    expect(memoryAccounts.search).toHaveBeenCalledTimes(1);
    const [, , query] = memoryAccounts.search.mock.calls[0] as any[];
    expect(query).toMatchObject({ scope: { scope_type: 'agent', scope_id: 'org-1:agent:agent-1' }, query: 'Check billing-service again and tell me what changed since your last check' });
    expect(conversationQuery).not.toHaveBeenCalled();
    expect(context).toContain('billing-service pinned lodash');
    expect(r.steps).toEqual([expect.objectContaining({ type: 'memory_recall', output: { found: 1 } })]);
  });

  it('looks up once per run: later steps read the same memories, not a search on the verifier\'s feedback', async () => {
    const { k, memoryAccounts } = keeper();
    const r = run();
    const first = await k.recallAtStart(agent({ enabled: true }), r, async () => 'A verification panel reviewed your answer');
    const second = await k.recallAtStart(agent({ enabled: true }), r, async () => 'A verification panel reviewed your answer');
    expect(second).toBe(first);
    expect(memoryAccounts.search).toHaveBeenCalledTimes(1);
    expect(r.steps.filter((s: any) => s.type === 'memory_recall')).toHaveLength(1);
  });

  it("falls back to the conversation's message when the run carries no words", async () => {
    const { k, memoryAccounts } = keeper();
    await k.recallAtStart(agent({ enabled: true }), run({ input: null }), async () => 'what did we decide about lodash?');
    expect((memoryAccounts.search.mock.calls[0] as any[])[2].query).toBe('what did we decide about lodash?');
  });

  it('does nothing with memory off', async () => {
    const { k, memoryAccounts } = keeper();
    const r = run();
    expect(await k.recallAtStart(agent({ enabled: false }), r, async () => 'x')).toBe('');
    expect(memoryAccounts.search).not.toHaveBeenCalled();
    expect(r.steps).toHaveLength(0);
  });

  it('searches with the message, not the JSON of the input', () => {
    expect(recallQueryOf({ input: { message: ' hi ' }, metadata: {} } as any)).toBe('hi');
    expect(recallQueryOf({ input: 'plain', metadata: {} } as any)).toBe('plain');
  });

  it('is what the step processor calls on every autonomous step', () => {
    const src = readFileSync(join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');
    expect(src).toMatch(/memory\.recallAtStart\(agent, run,/);
    expect(src).not.toMatch(/memory\.recallContext\(/);
  });
});

describe('no memories from an answer that failed verification', () => {
  const failedThenExhausted = [
    { type: 'verify', output: { verdict: 'fail', revision: 1 } },
    { type: 'verify', output: { verdict: 'fail', revision: 2 } },
    { type: 'verify', output: { verdict: 'fail', exhausted: true } },
  ];

  it('saves nothing, and says why on the run', async () => {
    const { k, memoryAccounts, callModel } = keeper(['All found works were future-dated and invalid']);
    const r = run({ steps: [...failedThenExhausted] });
    await k.afterRun(agent({ enabled: true, save: 'facts' }), { ...r, input: 'any new papers?' }, { main: MAIN } as any);
    expect(callModel).not.toHaveBeenCalled();
    expect(memoryAccounts.put).not.toHaveBeenCalled();
  });

  it('records the skipped save as a memory_save step', async () => {
    const { k } = keeper();
    const r = run({ input: 'any new papers?', steps: [...failedThenExhausted] });
    await k.afterRun(agent({ enabled: true, save: 'conversations' }), r, { main: MAIN } as any);
    expect(r.steps[r.steps.length - 1]).toMatchObject({ type: 'memory_save', output: { saved: 0, skipped: 'the answer did not pass verification' } });
  });

  it('saves once a revision passed', async () => {
    const { k, memoryAccounts } = keeper();
    const r = run({ input: 'check billing-service', steps: [{ type: 'verify', output: { verdict: 'fail', revision: 1 } }, { type: 'verify', output: { verdict: 'pass' } }] });
    await k.afterRun(agent({ enabled: true, save: 'facts' }), r, { main: MAIN } as any);
    expect(memoryAccounts.put).toHaveBeenCalled();
  });

  it('reads the verdict on the answer, not an advisory mid-run check or a cascade draft the stronger model replaced', () => {
    expect(verificationFailed({ steps: [{ type: 'verify', output: { verdict: 'fail', advisory: true } }], metadata: {} } as any)).toBe(false);
    expect(verificationFailed({ steps: [{ type: 'verify', output: { verdict: 'fail', escalateTo: 'main' } }], metadata: {} } as any)).toBe(false);
    expect(verificationFailed({ steps: [{ type: 'verify', output: { verdict: 'error', exhausted: true } }], metadata: {} } as any)).toBe(true);
    expect(verificationFailed({ steps: [], metadata: {} } as any)).toBe(false);
  });
});
