import { AgentMemoryKeeper, memoryKindOf, personWordsOf } from '../agent-memory.keeper';
import { ownerWordsOf, wakeMessage } from '../always-on/always-on.service';

/**
 * "Facts it learns" read an always-on run's wake prompt as the person's
 * words ("Person: You are always on, and something woke you..."), and
 * learned facts about the owner from text the system wrote. Only what a
 * person wrote is fed to the facts call: on a wake run, the owner's own
 * messages, which the run carries apart from the prompt.
 */

const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model' } as any;
const AGENT = { id: 'agent-1', name: 'Assistant', memoryConfig: { enabled: true, whose: 'agent', save: 'facts' } } as any;
const WAKE = wakeMessage('Watch my inbox.', [
  { source: 'timer', summary: 'the timer went off', payload: null, createdAt: new Date('2026-10-22T09:00:00Z') } as any,
]);

function keeper(facts: string[]) {
  const memoryAccounts = { put: jest.fn(async () => ({ id: 'mem-1' })), search: jest.fn(async () => []) };
  const callModel = jest.fn(async () => ({ content: JSON.stringify({ facts }) }));
  const k = new AgentMemoryKeeper({ memoryAccounts, logger: { warn: jest.fn() } } as any, { callModel } as any);
  return { k, memoryAccounts, callModel };
}

function wakeRun(personWords: unknown) {
  return {
    id: 'run-1', organizationId: 'org-1', userId: 'u-1', endUserId: null, input: WAKE, output: 'Nothing new.',
    steps: [] as any[], totalCost: 0, metadata: { triggerType: 'always_on', personWords },
  } as any;
}

describe('personWordsOf', () => {
  it("is a run's input when a person started it", () => {
    expect(personWordsOf({ input: 'I moved to Lisbon', metadata: { triggerType: 'chat' } } as any)).toBe('I moved to Lisbon');
  });

  it("is only the owner's messages on an always-on run, never the wake prompt", () => {
    expect(personWordsOf(wakeRun(['I moved to Lisbon', ' ', 'Call me Ana']))).toBe('I moved to Lisbon\n\nCall me Ana');
    expect(personWordsOf(wakeRun([]))).toBe('');
    expect(personWordsOf(wakeRun(undefined))).toBe('');
  });
});

describe('ownerWordsOf', () => {
  it("takes the owner's messages out of a wake batch, and nothing else", () => {
    expect(
      ownerWordsOf([
        { payload: { ownerMessage: { text: 'I moved to Lisbon' } } },
        { payload: { text: 'a webhook body' } },
        { payload: null },
      ] as any),
    ).toEqual(['I moved to Lisbon']);
  });
});

describe('facts after an always-on run', () => {
  it('learns nothing from a wake nobody wrote into: no facts call, nothing saved', async () => {
    const { k, memoryAccounts, callModel } = keeper(['The person is always on']);
    await k.afterRun(AGENT, wakeRun([]), { main: MAIN } as any);
    expect(callModel).not.toHaveBeenCalled();
    expect(memoryAccounts.put).not.toHaveBeenCalled();
  });

  it("feeds the facts call the owner's words as the person's, without the wake prompt", async () => {
    const { k, memoryAccounts, callModel } = keeper(['The owner moved to Lisbon']);
    await k.afterRun(AGENT, wakeRun(['I moved to Lisbon']), { main: MAIN } as any);
    const exchange = (callModel.mock.calls[0] as any[])[2].messages[1].content as string;
    expect(exchange).toBe('Person: I moved to Lisbon\nAgent: Nothing new.');
    expect(exchange).not.toContain('You are always on');
    expect((memoryAccounts.put.mock.calls[0] as any[])[2]).toMatchObject({ content: 'The owner moved to Lisbon', metadata: { type: 'fact' } });
  });
});

describe('memoryKindOf', () => {
  it("keeps the store_memory tool's kinds and nothing else", () => {
    expect(memoryKindOf('preference')).toBe('preference');
    expect(memoryKindOf('secret')).toBeUndefined();
    expect(memoryKindOf(undefined)).toBeUndefined();
  });
});
