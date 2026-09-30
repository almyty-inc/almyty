import { AgentMemoryKeeper, RECALL_ITEM_MAX_CHARS } from '../agent-memory.keeper';

/**
 * An agent's recall looks up documents as well as facts: a document added
 * on the Memory page is in the same scope as the facts and is found the
 * same way. Scope rules are the facts' rules: whose memory the run reads,
 * a visitor's own scope, nothing when memory is off.
 */
describe('agent memory recall', () => {
  const fact = { item: { id: 'f1', mode: 'memory', tier: 'long', content: 'The customer prefers invoices in euros.' }, score: 0.9, signal: 'hybrid' };
  const doc = { item: { id: 'd1', mode: 'document', tier: null, content: 'Shipping to Norway takes nine business days.' }, score: 0.8, signal: 'hybrid' };

  function build(memoryConfig: Record<string, any>, results: { account?: any[]; native?: any[] } = {}) {
    const accountSearch = jest.fn(async () => results.account ?? [fact, doc]);
    const nativeSearch = jest.fn(async () => results.native ?? []);
    const logger = { warn: jest.fn() };
    const keeper = new AgentMemoryKeeper(
      { memoryAccounts: { search: accountSearch }, memoryService: { search: nativeSearch }, logger } as any,
      {} as any,
    );
    const agent: any = { id: 'agent-1', name: 'Support', memoryConfig };
    const run = (over: Record<string, any> = {}): any => ({ id: 'run-1', organizationId: 'org-1', userId: 'user-1', endUserId: null, metadata: {}, ...over });
    return { keeper, agent, run, accountSearch, nativeSearch };
  }

  it("searches facts and documents alike in almyty's own store", async () => {
    const { keeper, agent, run, accountSearch } = build({ enabled: true, whose: 'shared' });
    const block = await keeper.recallContext(agent, run(), 'shipping to Norway');
    const q = (accountSearch.mock.calls[0] as any[])[2];
    expect(q.scope).toEqual({ scope_type: 'workspace', scope_id: 'org-1' });
    // No mode filter: a document is as findable as a fact.
    expect(q.mode).toBeUndefined();
    expect(block).toContain('- [document] Shipping to Norway takes nine business days.');
    expect(block).toContain('- [long] The customer prefers invoices in euros.');
  });

  it('the recall_memory tool returns documents too', async () => {
    const { keeper, agent, run } = build({ enabled: true });
    const out = await keeper.recall(agent, run(), { query: 'Norway' });
    expect(out.result).toContain('[document] (score: 0.80) Shipping to Norway');
  });

  it("per person, a visitor's recall reads that visitor's own scope only", async () => {
    const { keeper, agent, run, accountSearch } = build({ enabled: true, whose: 'person' });
    await keeper.recallContext(agent, run({ userId: null, endUserId: 'visitor-9' }), 'Norway');
    expect((accountSearch.mock.calls[0] as any[])[2].scope).toEqual({ scope_type: 'user', scope_id: 'org-1:user:visitor:visitor-9' });
  });

  it("per agent, recall reads the agent's own scope", async () => {
    const { keeper, agent, run, accountSearch } = build({ enabled: true, whose: 'agent' });
    await keeper.recallContext(agent, run(), 'Norway');
    expect((accountSearch.mock.calls[0] as any[])[2].scope).toEqual({ scope_type: 'agent', scope_id: 'org-1:agent:agent-1' });
  });

  it('with memory off nothing is searched', async () => {
    const { keeper, agent, run, accountSearch, nativeSearch } = build({ enabled: false });
    expect(await keeper.recallContext(agent, run(), 'Norway')).toBe('');
    expect(accountSearch).not.toHaveBeenCalled();
    expect(nativeSearch).not.toHaveBeenCalled();
  });

  it("with an outside account, facts come from it and documents from almyty's own store, same scope", async () => {
    const { keeper, agent, run, accountSearch, nativeSearch } = build(
      { enabled: true, whose: 'agent', account: 'mem0' },
      { account: [fact], native: [doc] },
    );
    const block = await keeper.recallContext(agent, run(), 'Norway');
    const scope = { scope_type: 'agent', scope_id: 'org-1:agent:agent-1' };
    expect((accountSearch.mock.calls[0] as any[])[1]).toBe('mem0');
    expect((accountSearch.mock.calls[0] as any[])[2]).toMatchObject({ scope, mode: 'memory' });
    expect((nativeSearch.mock.calls[0] as any[])[0]).toMatchObject({ scope, mode: 'document' });
    expect(block).toContain('[long] The customer prefers invoices in euros.');
    expect(block).toContain('[document] Shipping to Norway');
  });

  it('a long document is cut before it reaches the prompt', async () => {
    const long = { item: { id: 'd2', mode: 'document', tier: null, content: 'a'.repeat(RECALL_ITEM_MAX_CHARS + 500) }, score: 0.5, signal: 'fts' };
    const { keeper, agent, run } = build({ enabled: true }, { account: [long] });
    const block = await keeper.recallContext(agent, run(), 'a');
    expect(block).toContain(`${'a'.repeat(RECALL_ITEM_MAX_CHARS)}…`);
    expect(block).not.toContain('a'.repeat(RECALL_ITEM_MAX_CHARS + 1));
  });
});
