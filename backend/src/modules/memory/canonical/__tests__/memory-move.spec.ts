import { MemoryMoveService } from '../memory-move.service';
import { MemoryMove, MemoryMoveItem } from '../memory-move.entity';
import { MemoryExpiry } from '../memory-expiry.entity';
import { AuditAction } from '../../../../entities/audit-log.entity';
import { fakeRepository } from '../../../../test/fake-repository';

/**
 * Moving memories between memory accounts: copy to the target, then
 * delete from the source; one step row per memory, so a move that stopped
 * part way resumes without copying anything twice.
 */
describe('MemoryMoveService', () => {
  const ORG = 'org-1';
  const USER = 'user-1';
  const scope = { scope_type: 'workspace' as const, scope_id: ORG };

  /**
   * An outside service: one adapter, one store per account (told apart by
   * the credentials, as the real adapters are). Its list ignores cursors,
   * like Mem0's; it deletes by its own id.
   */
  function outside(id: string, opts: { failPutFor?: Set<string> } = {}) {
    const stores = new Map<string, Map<string, any>>();
    const storeOf = (creds?: any) => {
      const key = creds?.apiKey ?? 'none';
      if (!stores.has(key)) stores.set(key, new Map());
      return stores.get(key)!;
    };
    let n = 0;
    return {
      id,
      schema_version: 1,
      capabilities: new Set(['mode_memory', 'vector_search']),
      supported_modes: new Set(['memory']),
      /** The store of account `cred`. */
      account: (cred = 'cred-a') => storeOf({ apiKey: `key-of-${cred}` }),
      nativeId: (item: any) => item.metadata?.[`${id}_id`] ?? null,
      list: jest.fn(async (q: any, creds?: any) => {
        const all = [...storeOf(creds).values()].filter((i) => i.scope_id === q.scope.scope_id);
        return { items: all.slice(0, q.limit), total: all.length, cursor: null };
      }),
      put: jest.fn(async (item: any, creds?: any) => {
        if (opts.failPutFor?.has(item.content)) throw new Error(`${id} refused the write`);
        const nativeId = `${id}-${++n}`;
        const saved = { ...item, metadata: { ...item.metadata, [`${id}_id`]: nativeId } };
        storeOf(creds).set(nativeId, saved);
        return saved;
      }),
      delete: jest.fn(async (nativeId: string, _mode: string, creds?: any) => storeOf(creds).delete(nativeId)),
    };
  }

  /** almyty's own store: deletes by the canonical id, lists with a cursor. */
  function native() {
    const store = new Map<string, any>();
    const remove = async (id: string) => store.delete(id);
    return {
      id: 'almyty-native',
      schema_version: 1,
      capabilities: new Set(['mode_memory', 'mode_document', 'ttl', 'bi_temporal', 'soft_delete', 'vector_search']),
      supported_modes: new Set(['memory', 'document']),
      store,
      remove,
      list: jest.fn(async (q: any) => {
        const all = [...store.values()].filter((i) => i.scope_id === q.scope.scope_id);
        const start = q.cursor ? Number(q.cursor) : 0;
        const items = all.slice(start, start + q.limit);
        return { items, total: all.length, cursor: start + q.limit < all.length ? String(start + q.limit) : null };
      }),
      put: jest.fn(async (item: any) => {
        store.set(item.id, item);
        return item;
      }),
      delete: jest.fn(remove),
    };
  }

  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

  function memoryItem(id: string, content: string, over: Record<string, any> = {}) {
    return {
      id, mode: 'memory', scope_type: 'workspace', scope_id: ORG, content, content_format: 'text',
      content_bytes: content.length, embedding: [0.1, 0.2], embedding_dim: 2, embedding_model: 'old-model',
      embedding_status: 'ready', embedding_error: null, tags: ['t'], metadata: {}, file_refs: [], tier: 'long',
      valid_from: new Date('2026-09-01T00:00:00Z'), valid_until: null, superseded_by: null, ttl_seconds: null,
      source_uri: null, source_version: null, source_checksum: null, chunk_index: null, chunk_total: null, chunk_of: null,
      confidence: 1, provenance: { agent_id: 'agent-9', tool_chain: [], created_by: 'agent', source_backend: 'almyty-native' },
      created_at: new Date('2026-09-01T00:00:00Z'), updated_at: new Date('2026-09-01T00:00:00Z'),
      accessed_at: null, access_count: 0, deleted_at: null, deleted_by: null,
      ...over,
    };
  }

  function build(backends: Record<string, any>) {
    const moves = fakeRepository<MemoryMove>({ make: () => new MemoryMove(), idPrefix: 'move' });
    const items = fakeRepository<MemoryMoveItem>({ make: () => new MemoryMoveItem(), idPrefix: 'step' });
    const expiries = fakeRepository<MemoryExpiry>({ make: () => new MemoryExpiry(), idPrefix: 'exp' });
    const router = { backend: (id: string) => backends[id] };
    let drafted = 0;
    const memory = {
      // What CanonicalMemoryService.draftItem builds: a fresh item, no embedding yet.
      draftItem: jest.fn((input: any) => ({
        ...memoryItem(input.id ?? uuid(9000 + ++drafted), input.content),
        scope_type: input.scope.scope_type,
        scope_id: input.scope.scope_id,
        tags: input.tags,
        metadata: input.metadata,
        tier: input.tier ?? null,
        ttl_seconds: input.ttl_seconds ?? null,
        provenance: input.provenance,
        embedding: null, embedding_dim: null, embedding_model: null, embedding_status: 'pending',
        created_at: new Date(),
      })),
    };
    const audit = { log: jest.fn(async (_entry: any) => null) };
    const queue = { add: jest.fn(async () => ({})) };
    const resolve = jest.fn(async (_org: string, credentialId: string, _opts: any) => ({ config: { apiKey: `key-of-${credentialId}` } }));
    const svc = new MemoryMoveService(moves as any, items as any, expiries as any, router as any, memory as any, audit as any, queue as any, { resolve } as any);
    return { svc, moves, items, expiries, audit, queue, resolve };
  }

  const nativeAccount = { service: 'almyty-native', credentialId: null };
  const mem0Account = (id = 'cred-a') => ({ service: 'mem0', credentialId: id });

  it('moves every memory from almyty to a Mem0 account: copied there, deleted here, re-embedded by the target', async () => {
    const src = native();
    const mem0 = outside('mem0');
    // More than one page: almyty's store pages with a cursor.
    for (let i = 0; i < 150; i++) src.store.set(uuid(i), memoryItem(uuid(i), `fact ${i}`));
    const { svc, moves, audit, queue, resolve } = build({ 'almyty-native': src, mem0 });

    const started = await svc.start(ORG, USER, { source: nativeAccount, target: mem0Account(), scope });
    expect(started.status).toBe('queued');
    expect(queue.add).toHaveBeenCalledWith('move', { moveId: started.id, userId: USER }, expect.any(Object));

    const done = await svc.run(started.id, USER);
    expect(done).toMatchObject({ status: 'completed', moved: 150, failed: 0, total: 150 });
    expect(src.store.size).toBe(0);
    expect(mem0.account().size).toBe(150);
    // Vectors are never carried to another service.
    for (const put of mem0.put.mock.calls) expect(put[0].embedding).toBeNull();
    // The Mem0 connection is resolved as the member who started the move.
    expect(resolve).toHaveBeenCalledWith(ORG, 'cred-a', expect.objectContaining({ principal: { id: USER } }));
    expect(moves.row(started.id)!.status).toBe('completed');
    const actions = audit.log.mock.calls.map((c: any[]) => [c[0].action, c[0].details.phase]);
    expect(actions).toEqual([[AuditAction.MEMORY_MOVE, 'started'], [AuditAction.MEMORY_MOVE, 'finished']]);
    expect(audit.log.mock.calls[1][0]).toMatchObject({ organizationId: ORG, userId: USER, resourceId: started.id, details: { moved: 150, failed: 0 } });
  });

  it('into almyty: the copy is embedded again by almyty, and a due date travels with it', async () => {
    const mem0 = outside('mem0');
    const dst = native();
    const due = new Date('2026-12-01T00:00:00Z');
    mem0.account().set('mem0-a', memoryItem(uuid(1), 'Dana prefers email', { metadata: { mem0_id: 'mem0-a' }, embedding_status: 'skipped' }));
    const { svc, expiries } = build({ mem0, 'almyty-native': dst });
    expiries.seed({ organizationId: ORG, backendId: 'mem0', nativeId: 'mem0-a', memoryId: 'x', scopeType: 'workspace', scopeId: ORG, agentId: null, credentialId: null, expiresAt: due });

    const move = await svc.start(ORG, USER, { source: mem0Account(), target: nativeAccount, scope });
    const done = await svc.run(move.id, USER);

    expect(done).toMatchObject({ status: 'completed', moved: 1 });
    const [copy] = [...dst.store.values()];
    expect(copy).toMatchObject({ id: uuid(1), content: 'Dana prefers email', embedding: null, embedding_status: 'pending' });
    // The service's own id does not travel to the target.
    expect(copy.metadata.mem0_id).toBeUndefined();
    expect(new Date(copy.created_at).getTime() + copy.ttl_seconds * 1000).toBe(due.getTime());
    expect(mem0.delete).toHaveBeenCalledWith('mem0-a', 'hard', { apiKey: 'key-of-cred-a' });
    // The source's expiry bookkeeping goes with the memory.
    expect(expiries.rows()).toEqual([]);
  });

  it('between two accounts of one service: the target account gets the copy and an expiry row of its own', async () => {
    const mem0 = outside('mem0');
    mem0.account('cred-a').set('mem0-a', memoryItem('a', 'x', { metadata: { mem0_id: 'mem0-a' } }));
    const { svc, expiries } = build({ mem0 });
    const move = await svc.start(ORG, USER, { source: mem0Account('cred-a'), target: mem0Account('cred-b'), scope });
    expect(await svc.run(move.id, USER)).toMatchObject({ status: 'completed', moved: 1 });
    expect(mem0.account('cred-a').size).toBe(0);
    expect([...mem0.account('cred-b').values()].map((m) => m.content)).toEqual(['x']);
    expect(expiries.rows()).toEqual([expect.objectContaining({ backendId: 'mem0', nativeId: 'mem0-1', credentialId: 'cred-b', expiresAt: null })]);
  });

  it('resumes where it stopped: a failed copy is tried again, a copied memory is only deleted, nothing is copied twice', async () => {
    const src = native();
    const failPutFor = new Set(['b']);
    const dst = outside('mem0', { failPutFor });
    ['a', 'b', 'c'].forEach((c, i) => src.store.set(uuid(i), memoryItem(uuid(i), c)));
    // The source refuses to delete "c" the first time.
    let cRefused = false;
    src.delete.mockImplementation(async (id: string) => {
      if (id === uuid(2) && !cRefused) {
        cRefused = true;
        throw new Error('database busy');
      }
      return src.remove(id);
    });
    const { svc, moves, items } = build({ 'almyty-native': src, mem0: dst });

    const move = await svc.start(ORG, USER, { source: nativeAccount, target: mem0Account(), scope });
    const first = await svc.run(move.id, USER);
    // The page says why, with what a service answered.
    expect(first).toMatchObject({ status: 'completed', moved: 1, failed: 2, lastError: expect.stringMatching(/refused the write|database busy/) });
    expect(items.rows().map((r) => [r.sourceId, r.state]).sort()).toEqual([[uuid(0), 'moved'], [uuid(1), 'failed'], [uuid(2), 'copied']]);
    expect(dst.put.mock.calls.map((c) => c[0].content)).toEqual(['a', 'b', 'c']); // b was refused

    failPutFor.clear();
    const resumed = await svc.resume(ORG, USER, move.id);
    expect(resumed.status).toBe('queued');
    const second = await svc.run(move.id, USER);

    expect(second).toMatchObject({ status: 'completed', moved: 3, failed: 0 });
    expect(src.store.size).toBe(0);
    // b is copied once now; c was already on the target and is only deleted from the source.
    expect(dst.put.mock.calls.map((c) => c[0].content)).toEqual(['a', 'b', 'c', 'b']);
    expect(dst.account().size).toBe(3);
    expect(moves.row(move.id)!.failed).toBe(0);
  });

  it('a source that cannot be reached fails the move with the reason, and it can be resumed', async () => {
    const src = native();
    src.list.mockRejectedValueOnce(new Error('connection refused'));
    src.store.set(uuid(1), memoryItem(uuid(1), 'x'));
    const { svc } = build({ 'almyty-native': src, mem0: outside('mem0') });
    const move = await svc.start(ORG, USER, { source: nativeAccount, target: mem0Account(), scope });

    expect(await svc.run(move.id, USER)).toMatchObject({ status: 'failed', lastError: 'connection refused', moved: 0 });

    await svc.resume(ORG, USER, move.id);
    expect(await svc.run(move.id, USER)).toMatchObject({ status: 'completed', moved: 1, lastError: null });
  });

  it('refuses to resume a move that is done or still running', async () => {
    const { svc, moves } = build({ 'almyty-native': native(), mem0: outside('mem0') });
    const done = moves.seed({ organizationId: ORG, status: 'completed', failed: 0, updatedAt: new Date() } as any);
    const running = moves.seed({ organizationId: ORG, status: 'running', failed: 0, updatedAt: new Date() } as any);
    await expect(svc.resume(ORG, USER, done.id)).rejects.toMatchObject({ response: { code: 'MOVE_NOT_RESUMABLE' } });
    await expect(svc.resume(ORG, USER, running.id)).rejects.toMatchObject({ response: { code: 'MOVE_NOT_RESUMABLE' } });
    // Another organization's move is not found.
    await expect(svc.resume('org-2', USER, done.id)).rejects.toMatchObject({ response: { code: 'MOVE_NOT_FOUND' } });
  });

  it('resumes a running move that stopped reporting (its process went away)', async () => {
    const { svc, moves, queue } = build({ 'almyty-native': native(), mem0: outside('mem0') });
    const stale = moves.seed({ organizationId: ORG, status: 'running', failed: 0, sourceService: 'almyty-native', sourceCredentialId: null, targetService: 'mem0', targetCredentialId: 'cred-a', updatedAt: new Date(Date.now() - 10 * 60 * 1000) } as any);
    expect((await svc.resume(ORG, USER, stale.id)).status).toBe('queued');
    expect(queue.add).toHaveBeenCalled();
  });

  it('starting the same move twice returns the one already under way', async () => {
    const { svc, queue } = build({ 'almyty-native': native(), mem0: outside('mem0') });
    const a = await svc.start(ORG, USER, { source: nativeAccount, target: mem0Account(), scope });
    const b = await svc.start(ORG, USER, { source: nativeAccount, target: mem0Account(), scope });
    expect(b.id).toBe(a.id);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('refuses a move to the same account, out of a service that cannot delete one memory, or with no account picked', async () => {
    const vertex = { id: 'vertex-memory-bank', capabilities: new Set(), supported_modes: new Set(['memory']) };
    const { svc } = build({ 'almyty-native': native(), mem0: outside('mem0'), 'vertex-memory-bank': vertex });
    await expect(svc.start(ORG, USER, { source: mem0Account('x'), target: mem0Account('x'), scope })).rejects.toMatchObject({ response: { code: 'SAME_ACCOUNT' } });
    await expect(svc.start(ORG, USER, { source: { service: 'vertex-memory-bank', credentialId: 'v' }, target: nativeAccount, scope })).rejects.toMatchObject({ response: { code: 'SOURCE_CANNOT_DELETE' } });
    await expect(svc.start(ORG, USER, { source: nativeAccount, target: { service: 'mem0', credentialId: null }, scope })).rejects.toMatchObject({ response: { code: 'NO_ACCOUNT' } });
  });

  it('refuses before queueing when the member may not use an account', async () => {
    const { svc, queue, resolve } = build({ 'almyty-native': native(), mem0: outside('mem0') });
    resolve.mockRejectedValueOnce(new Error('not yours'));
    await expect(svc.start(ORG, USER, { source: nativeAccount, target: mem0Account(), scope })).rejects.toThrow('not yours');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a dry run counts the memories and says what the target cannot keep, without moving any', async () => {
    const src = native();
    src.store.set(uuid(1), memoryItem(uuid(1), 'x', { ttl_seconds: 60 }));
    const dst = outside('mem0');
    const { svc, moves } = build({ 'almyty-native': src, mem0: dst });
    const preview = await svc.preview(ORG, USER, { source: nativeAccount, target: mem0Account(), scope });
    expect(preview).toEqual({ total: 1, more: false, warnings: [{ capability: 'ttl', field: 'ttl_seconds', count: 1 }] });
    expect(dst.put).not.toHaveBeenCalled();
    expect(moves.rows()).toEqual([]);
  });

  it("lists the organization's moves, hiding the ones of an agent the caller cannot see", async () => {
    const { svc, moves } = build({});
    moves.seed({ organizationId: ORG, scopeType: 'workspace', scopeId: ORG, createdAt: new Date(1) } as any);
    moves.seed({ organizationId: ORG, scopeType: 'agent', scopeId: `${ORG}:agent:seen`, createdAt: new Date(2) } as any);
    moves.seed({ organizationId: ORG, scopeType: 'agent', scopeId: `${ORG}:agent:hidden`, createdAt: new Date(3) } as any);
    moves.seed({ organizationId: 'org-2', scopeType: 'workspace', scopeId: 'org-2', createdAt: new Date(4) } as any);
    const listed = await svc.list(ORG, [`${ORG}:agent:seen`]);
    expect(listed.map((m) => m.scopeId)).toEqual([`${ORG}:agent:seen`, ORG]);
  });
});
