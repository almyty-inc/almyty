/**
 * A `user` memory belongs to that user; provenance is the server's word.
 *
 * The canonical memory controller replaced every client scope with
 * `{ scope_type, scope_id: <caller org id> }`. For `workspace` that is the
 * point. For `user` it made "my memories" a folder every member of the
 * organization reads, searches, fetches by id and supersedes. And the
 * write routes stored `provenance` as the client sent it, so a member could
 * file a memory as written by an agent (created_by, agent_id, model) that
 * agents then read back as their own grounding.
 *
 * Real Postgres, through the controller and the real service, because
 * both the scope collapse and the lookups are SQL.
 */
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';

import { CanonicalMemory } from '../../modules/memory/canonical/canonical-memory.entity';
import { CanonicalMemoryWorkspaceConfig } from '../../modules/memory/canonical/canonical-memory-config.entity';
import { CanonicalMemorySoftcapWarning } from '../../modules/memory/canonical/canonical-memory-softcap-warning.entity';
import {
  CanonicalMemoryService,
  EMBEDDING_QUEUE_NAME,
} from '../../modules/memory/canonical/canonical-memory.service';
import { CanonicalMemoryController } from '../../modules/memory/canonical/canonical-memory.controller';
import { CanonicalSearchHelper } from '../../modules/memory/canonical/canonical-search.helper';
import { CanonicalMemoryOpsHelper } from '../../modules/memory/canonical/canonical-ops.helper';
import { CanonicalPutValidators } from '../../modules/memory/canonical/canonical-put-validators.helper';
import { EmbeddingService, HASH_EMBEDDING_MODEL } from '../../modules/memory/embedding.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'memory_user_scope_test';

jest.setTimeout(300_000);

describeIfDb('canonical memory: user scope and provenance (real Postgres)', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const alice = { user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', currentOrganizationId: ORG } };
  const bob = { user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', currentOrganizationId: ORG } };

  let ds: DataSource;
  let controller: CanonicalMemoryController;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      logging: false,
      extra: { options: `-c search_path=${SCHEMA},public` },
      entities: [CanonicalMemory, CanonicalMemoryWorkspaceConfig, CanonicalMemorySoftcapWarning],
    });
    await ds.initialize();

    const embeddingStub = {
      generateEmbedding: jest.fn(async () => ({
        vector: new Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
        model: HASH_EMBEDDING_MODEL,
        dim: 1536,
        provider: 'hash' as const,
      })),
      cosineSimilarity: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CanonicalMemoryService,
        { provide: getRepositoryToken(CanonicalMemory), useValue: ds.getRepository(CanonicalMemory) },
        { provide: getRepositoryToken(CanonicalMemoryWorkspaceConfig), useValue: ds.getRepository(CanonicalMemoryWorkspaceConfig) },
        { provide: getRepositoryToken(CanonicalMemorySoftcapWarning), useValue: ds.getRepository(CanonicalMemorySoftcapWarning) },
        { provide: getQueueToken(EMBEDDING_QUEUE_NAME), useValue: { add: jest.fn(async () => ({ id: 'job' })) } },
        { provide: DataSource, useValue: ds },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: EmbeddingService, useValue: embeddingStub },
        CanonicalSearchHelper,
        CanonicalMemoryOpsHelper,
        CanonicalPutValidators,
      ],
    }).compile();
    controller = new CanonicalMemoryController(
      moduleRef.get(CanonicalMemoryService),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await ds.destroy();
    }
  });

  const forgedProvenance = {
    agent_id: 'agent-forged',
    session_id: 'sess-forged',
    collab_id: null,
    model: 'gpt-forged',
    provider: 'openai',
    tool_chain: ['store_memory'],
    created_by: 'agent',
    source_backend: 'almyty-native',
  } as any;

  const put = (req: any, scope_type: string, content: string) =>
    controller.put(
      {
        mode: 'memory',
        // Clients have always sent the org id here; it is accepted and
        // replaced with the caller's own scope.
        scope: { scope_type, scope_id: ORG },
        content,
        provenance: forgedProvenance,
      } as any,
      req,
    );
  const list = (req: any, scope_type: string) =>
    controller.list({ scope: { scope_type, scope_id: ORG } } as any, req);
  const search = (req: any, scope_type: string, query: string) =>
    controller.search({ scope: { scope_type, scope_id: ORG }, query, fts_only: true } as any, req);

  let aliceNote: string;

  it('another member cannot list, search, fetch, delete or supersede a user memory', async () => {
    aliceNote = (await put(alice, 'user', 'alice private note about the dentist')).data.id;

    expect((await list(bob, 'user')).data.items.map((i: any) => i.id)).not.toContain(aliceNote);
    expect((await search(bob, 'user', 'dentist')).data.map((r: any) => r.item.id)).not.toContain(aliceNote);
    await expect(controller.get(aliceNote, bob)).rejects.toMatchObject({ status: 404 });
    await expect(
      controller.supersede(
        aliceNote,
        { new_item: { mode: 'memory', scope: { scope_type: 'user', scope_id: ORG }, content: 'bob was here', provenance: forgedProvenance } } as any,
        bob,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('the owner still lists, searches and fetches it', async () => {
    expect((await list(alice, 'user')).data.items.map((i: any) => i.id)).toContain(aliceNote);
    expect((await search(alice, 'user', 'dentist')).data.map((r: any) => r.item.id)).toContain(aliceNote);
    expect((await controller.get(aliceNote, alice)).data.id).toBe(aliceNote);
  });

  it('a workspace memory stays shared across the organization', async () => {
    const shared = (await put(alice, 'workspace', 'team wiki lives in notion')).data.id;
    expect((await list(bob, 'workspace')).data.items.map((i: any) => i.id)).toContain(shared);
    expect((await controller.get(shared, bob)).data.id).toBe(shared);
  });

  it('stores provenance the server derived, not what the client claimed', async () => {
    const stored = (await controller.get(aliceNote, alice)).data;
    expect(stored.provenance).toMatchObject({
      created_by: 'user',
      agent_id: null,
      session_id: null,
      model: null,
      provider: null,
    });
  });
});
