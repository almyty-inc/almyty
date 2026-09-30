/**
 * Real-Postgres check of an agent's memory settings in the store:
 *
 *  - the `agent` scope passes the memories.scope_type CHECK (and a scope
 *    type that is not one still fails it);
 *  - a changed retention reaches the memories an agent already saved, in
 *    almyty's own store (ttl_seconds) and in outside accounts
 *    (memory_expiries.expires_at), and no other agent's or organization's;
 *  - the sweep deletes the outside memories that are due.
 *
 * Gated behind RUN_DB_INTEGRATION=1, like every DB spec.
 */
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { CanonicalMemory } from '../../modules/memory/canonical/canonical-memory.entity';
import { CanonicalMemoryWorkspaceConfig } from '../../modules/memory/canonical/canonical-memory-config.entity';
import { MemoryExpiry } from '../../modules/memory/canonical/memory-expiry.entity';
import { MemoryAccountsService } from '../../modules/memory/canonical/memory-accounts.service';
import { itemToEntity } from '../../modules/memory/canonical/canonical-memory.helpers';
import { MemoryItem } from '../../modules/memory/canonical/canonical.types';
import { ensureSchema } from './isolated-schema.helper';
import { testDbConnection } from './test-db-extensions';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'agent_memory_settings_test';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000002';
const AGENT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_AGENT = '00000000-0000-4000-8000-0000000000a2';

jest.setTimeout(120_000);

function item(scope_type: MemoryItem['scope_type'], scope_id: string, agentId: string): MemoryItem {
  const now = new Date();
  return {
    id: uuidv7(),
    mode: 'memory',
    scope_type,
    scope_id,
    content: 'Dana prefers email',
    content_format: 'text',
    content_bytes: 18,
    embedding: null, embedding_dim: null, embedding_model: null,
    embedding_status: 'skipped', embedding_error: null,
    tags: [], metadata: {}, file_refs: [],
    tier: 'long',
    valid_from: now, valid_until: null, superseded_by: null, ttl_seconds: null,
    source_uri: null, source_version: null, source_checksum: null,
    chunk_index: null, chunk_total: null, chunk_of: null,
    confidence: 1,
    provenance: { agent_id: agentId, session_id: null, collab_id: null, model: null, provider: null, tool_chain: [], created_by: 'agent', source_backend: 'almyty-native' },
    created_at: now, updated_at: now, accessed_at: null, access_count: 0, deleted_at: null, deleted_by: null,
  };
}

describeIfDb('agent memory settings in the store (real Postgres)', () => {
  let ds: DataSource;
  let accounts: MemoryAccountsService;
  const deleteOn = jest.fn(async () => true);

  beforeAll(async () => {
    await ensureSchema(SCHEMA);
    const conn = testDbConnection();
    ds = new DataSource({
      type: 'postgres',
      host: conn.host,
      port: conn.port,
      username: conn.user,
      password: conn.password,
      database: conn.database,
      schema: SCHEMA,
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      logging: false,
      extra: { options: `-c search_path=${SCHEMA},public` },
      entities: [CanonicalMemory, CanonicalMemoryWorkspaceConfig, MemoryExpiry],
    });
    await ds.initialize();
    accounts = new MemoryAccountsService(
      {} as any,
      { deleteOn } as any,
      ds.getRepository(CanonicalMemoryWorkspaceConfig),
      ds.getRepository(MemoryExpiry),
      ds.getRepository(CanonicalMemory),
    );
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  it("the agent scope passes the scope_type check; a made-up scope type does not", async () => {
    await expect(ds.getRepository(CanonicalMemory).save(itemToEntity(item('agent', `${ORG}:agent:${AGENT}`, AGENT)))).resolves.toBeDefined();
    await expect(ds.getRepository(CanonicalMemory).save(itemToEntity(item('nobody' as any, ORG, AGENT)))).rejects.toThrow();
  });

  it("a changed retention reaches the agent's memories in every scope of its organization, and nobody else's", async () => {
    const repo = ds.getRepository(CanonicalMemory);
    const mine = [
      item('workspace', ORG, AGENT),
      item('agent', `${ORG}:agent:${AGENT}`, AGENT),
      item('user', `${ORG}:user:visitor:eu-1`, AGENT),
    ];
    const others = [item('workspace', ORG, OTHER_AGENT), item('workspace', OTHER_ORG, AGENT)];
    for (const m of [...mine, ...others]) await repo.save(itemToEntity(m));
    const expiries = ds.getRepository(MemoryExpiry);
    await expiries.save([
      expiries.create({ organizationId: ORG, agentId: AGENT, backendId: 'mem0', scopeType: 'agent', scopeId: 's', nativeId: 'm0-1', memoryId: 'x1', expiresAt: null }),
      expiries.create({ organizationId: ORG, agentId: OTHER_AGENT, backendId: 'mem0', scopeType: 'agent', scopeId: 's', nativeId: 'm0-2', memoryId: 'x2', expiresAt: null }),
    ]);

    await accounts.setAgentRetention(ORG, AGENT, 7 * 86400);

    const ttl = async (id: string) => (await repo.findOneByOrFail({ id })).ttlSeconds;
    for (const m of mine) expect(await ttl(m.id)).toBe(7 * 86400);
    for (const m of others) expect(await ttl(m.id)).toBeNull();
    const rows = await expiries.find();
    const due = rows.find((r) => r.nativeId === 'm0-1')!;
    expect(due.expiresAt!.getTime() - due.createdAt.getTime()).toBe(7 * 86400 * 1000);
    expect(rows.find((r) => r.nativeId === 'm0-2')!.expiresAt).toBeNull();

    // Back to "until deleted".
    await accounts.setAgentRetention(ORG, AGENT, null);
    for (const m of mine) expect(await ttl(m.id)).toBeNull();
    expect((await expiries.findOneByOrFail({ nativeId: 'm0-1' })).expiresAt).toBeNull();
  });

  it('the sweep deletes the outside memories that are due, through the service, and forgets them', async () => {
    const expiries = ds.getRepository(MemoryExpiry);
    await expiries.clear();
    await expiries.save([
      expiries.create({ organizationId: ORG, agentId: AGENT, backendId: 'mem0', scopeType: 'agent', scopeId: 's', nativeId: 'due-1', memoryId: 'd1', expiresAt: new Date(Date.now() - 60_000) }),
      expiries.create({ organizationId: ORG, agentId: AGENT, backendId: 'mem0', scopeType: 'agent', scopeId: 's', nativeId: 'later-1', memoryId: 'l1', expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);
    expect(await accounts.sweepExpired()).toEqual({ deleted: 1, failed: 0 });
    // The organization's account: no connection of the agent's own.
    expect(deleteOn).toHaveBeenCalledWith('mem0', 'due-1', { scope_type: 'workspace', scope_id: ORG }, undefined);
    expect((await expiries.find()).map((r) => r.nativeId)).toEqual(['later-1']);
  });
});
