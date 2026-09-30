import { MemoryAccountsService } from '../memory-accounts.service';
import { MemoryExpiry } from '../memory-expiry.entity';
import { fakeRepository } from '../../../../test/fake-repository';

/**
 * The memory accounts an agent can choose, and its reads and writes
 * through the one it chose.
 *
 *  - The accounts are almyty's own store plus every outside service the
 *    organization connected an account for on the Memory page.
 *  - A time limit is a ttl in almyty's own store; outside, it is a
 *    memory_expiries row the hourly sweep deletes through the service's
 *    API once it is due. A service that cannot delete one memory cannot
 *    take a time limit.
 */
describe('MemoryAccountsService', () => {
  const backend = (id: string, over: Record<string, any> = {}) => ({
    id,
    capabilities: new Set(over.capabilities ?? ['vector_search']),
    supported_modes: new Set(['memory']),
    ...over,
  });
  const mem0 = backend('mem0', { nativeId: (item: any) => item.metadata?.mem0_id ?? null });
  const vertex = backend('vertex-memory-bank');

  function build(credentials: Record<string, string> = { mem0: 'cred-1', 'vertex-memory-bank': 'cred-2', zep: '' }) {
    const memory = {
      put: jest.fn(async (input: any) => ({ id: 'native-1', ...input })),
      search: jest.fn(async () => [{ item: { content: 'native hit' }, score: 1, signal: 'fts' }]),
      draftItem: jest.fn((input: any) => ({ id: 'mem-1', scope_type: input.scope.scope_type, scope_id: input.scope.scope_id, content: input.content, metadata: {} })),
    };
    const router = {
      backend: (id: string) => ({ mem0, 'vertex-memory-bank': vertex } as Record<string, any>)[id],
      putOn: jest.fn(async (_id: string, item: any) => ({ ...item, metadata: { mem0_id: 'm0-77' } })),
      searchOn: jest.fn(async () => [{ item: { content: 'mem0 hit' }, score: 1, signal: 'vector' }]),
      deleteOn: jest.fn(async (_b: string, nativeId: string) => {
        if (nativeId === 'm0-broken') throw new Error('mem0 is down');
        return true;
      }),
    };
    const config = fakeRepository([
      { scopeType: 'workspace', scopeId: 'org-1', overrides: { routing: { memory_backend: 'almyty-native', credentials } } },
    ] as any);
    const expiries = fakeRepository<MemoryExpiry>({ make: () => new MemoryExpiry(), idPrefix: 'exp' });
    const svc = new MemoryAccountsService(memory as any, router as any, config as any, expiries as any, fakeRepository([]) as any);
    return { svc, memory, router, expiries };
  }

  const input = { mode: 'memory' as const, scope: { scope_type: 'agent' as const, scope_id: 'org-1:agent:a-1' }, content: 'Dana prefers email', provenance: {} as any };

  it("lists almyty's own memory first, then each outside account that has a credential", async () => {
    const { svc } = build();
    expect(await svc.accounts('org-1')).toEqual([
      { id: 'almyty-native', name: "almyty's own memory", canExpire: true, expiresItself: true },
      { id: 'mem0', name: 'Mem0', canExpire: true, expiresItself: false },
      { id: 'vertex-memory-bank', name: 'Vertex AI Memory Bank', canExpire: false, expiresItself: false },
    ]);
    expect(await svc.accounts('org-2')).toEqual([expect.objectContaining({ id: 'almyty-native' })]);
  });

  it("almyty's own store: the write pipeline, with the retention as the memory's ttl", async () => {
    const { svc, memory, router } = build();
    await svc.put('org-1', 'almyty-native', input, { user_id: 'u-1' }, { agentId: 'a-1', expiresInSeconds: 3600 });
    expect(memory.put).toHaveBeenCalledWith({ ...input, ttl_seconds: 3600 }, { user_id: 'u-1' });
    expect(router.putOn).not.toHaveBeenCalled();
  });

  it('an outside account: the backend, signed in as the organization, and a due date for the sweep', async () => {
    const { svc, router, expiries } = build();
    const before = Date.now();
    await svc.put('org-1', 'mem0', input, { user_id: 'u-1' }, { agentId: 'a-1', expiresInSeconds: 3600 });
    expect(router.putOn).toHaveBeenCalledWith('mem0', expect.objectContaining({ content: 'Dana prefers email' }), { scope_type: 'workspace', scope_id: 'org-1' }, undefined);
    const [row] = expiries.rows();
    expect(row).toMatchObject({ organizationId: 'org-1', agentId: 'a-1', backendId: 'mem0', nativeId: 'm0-77', memoryId: 'mem-1', scopeType: 'agent' });
    expect(row.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
  });

  it('kept until deleted outside: the row is kept without a due date, so a later retention reaches it', async () => {
    const { svc, expiries } = build();
    await svc.put('org-1', 'mem0', input, {}, { agentId: 'a-1', expiresInSeconds: null });
    expect(expiries.rows()[0].expiresAt).toBeNull();
  });

  it('searches through the chosen account', async () => {
    const { svc, memory, router } = build();
    const q = { scope: input.scope, query: 'email', mode: 'memory' as const };
    expect((await svc.search('org-1', 'mem0', q))[0].item.content).toBe('mem0 hit');
    expect(router.searchOn).toHaveBeenCalledWith('mem0', q, { scope_type: 'workspace', scope_id: 'org-1' }, undefined);
    expect((await svc.search('org-1', 'almyty-native', q))[0].item.content).toBe('native hit');
    expect(memory.search).toHaveBeenCalledWith(q);
  });

  it('the sweep deletes what is due through the service, keeps what is not, and retries what failed', async () => {
    const { svc, router, expiries } = build();
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 86_400_000);
    await expiries.save([
      { organizationId: 'org-1', agentId: 'a-1', backendId: 'mem0', scopeType: 'agent', scopeId: 's', nativeId: 'm0-1', memoryId: 'x1', expiresAt: past },
      { organizationId: 'org-1', agentId: 'a-1', backendId: 'mem0', scopeType: 'agent', scopeId: 's', nativeId: 'm0-broken', memoryId: 'x2', expiresAt: past },
      { organizationId: 'org-1', agentId: 'a-1', backendId: 'mem0', scopeType: 'agent', scopeId: 's', nativeId: 'm0-3', memoryId: 'x3', expiresAt: future },
    ] as any);
    expect(await svc.sweepExpired()).toEqual({ deleted: 1, failed: 1 });
    expect(router.deleteOn).toHaveBeenCalledWith('mem0', 'm0-1', { scope_type: 'workspace', scope_id: 'org-1' }, undefined);
    expect(expiries.rows().map((r) => r.nativeId).sort()).toEqual(['m0-3', 'm0-broken']);
  });

  describe("an agent's own account (a connection added from its page)", () => {
    function withConnection() {
      const built = build({});
      const resolve = jest.fn(async () => ({ config: { apiKey: 'own-key', baseUrl: 'https://mem0.example' } }));
      const agents = fakeRepository([{ id: 'a-1', organizationId: 'org-1', visibility: 'team', teamId: 'team-1', createdBy: 'u-1' }] as any);
      (built.expiries as any).manager = { getRepository: () => agents };
      const svc = new MemoryAccountsService(
        built.memory as any,
        built.router as any,
        fakeRepository([]) as any,
        built.expiries as any,
        fakeRepository([]) as any,
        { resolve } as any,
      );
      return { ...built, svc, resolve };
    }

    it('signs in with it, as the run, whatever the organization has set up', async () => {
      const { svc, router, resolve, expiries } = withConnection();
      const principal: any = { kind: 'user', userId: 'u-1', source: 'session' };
      await svc.put('org-1', 'mem0', input, {}, { agentId: 'a-1', expiresInSeconds: 60, credentialId: 'cred-own', principal });
      expect(resolve).toHaveBeenCalledWith('org-1', 'cred-own', {
        principal,
        context: { purpose: 'memory_backend', resourceType: 'agent', resourceId: 'a-1' },
      });
      expect(router.putOn).toHaveBeenCalledWith('mem0', expect.anything(), { scope_type: 'workspace', scope_id: 'org-1' }, { apiKey: 'own-key', baseUrl: 'https://mem0.example' });
      expect(expiries.rows()[0].credentialId).toBe('cred-own');

      await svc.search('org-1', 'mem0', { scope: input.scope, query: 'q', mode: 'memory' }, { credentialId: 'cred-own', agentId: 'a-1', principal });
      expect((router.searchOn.mock.calls[0] as any[])[3]).toEqual({ apiKey: 'own-key', baseUrl: 'https://mem0.example' });
    });

    it("the sweep deletes with it as the system acting for the agent, within the agent's scope", async () => {
      const { svc, router, resolve, expiries } = withConnection();
      await expiries.save({
        organizationId: 'org-1', agentId: 'a-1', backendId: 'mem0', scopeType: 'agent', scopeId: 's', nativeId: 'm0-9',
        memoryId: 'x9', credentialId: 'cred-own', expiresAt: new Date(Date.now() - 1000),
      } as any);
      expect(await svc.sweepExpired()).toEqual({ deleted: 1, failed: 0 });
      expect(resolve).toHaveBeenCalledWith('org-1', 'cred-own', {
        principal: null,
        systemFor: { organizationId: 'org-1', visibility: 'team', teamId: 'team-1', ownerUserId: 'u-1' },
        context: { purpose: 'memory_backend', resourceType: 'agent', resourceId: 'a-1' },
      });
      expect(router.deleteOn).toHaveBeenCalledWith('mem0', 'm0-9', { scope_type: 'workspace', scope_id: 'org-1' }, { apiKey: 'own-key', baseUrl: 'https://mem0.example' });
    });
  });
});
