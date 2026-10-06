import { FilesService } from '../files.service';
import { AgentFile } from '../../../entities/file.entity';
import { fakeRepository } from '../../../test/fake-repository';
import {
  ClauseModel,
  ExecutedQuery,
  RecordingQueryBuilder,
  matchingRows,
} from '../../gateways/__tests__/recording-query-builder';

/**
 * Files someone sent in a conversation: stored from bytes, filed under the
 * conversation that read them, and removed with it, stored object first.
 * The table is a truthful fake that evaluates every criterion; storage is a
 * fake that keeps objects by key.
 */
const ORG = 'org-1';
const AGENT = '00000000-0000-4000-8000-00000000a9e1';

const CLAUSES: ClauseModel = {
  'file.id IN (:...ids)': (row, p) => p.ids.includes(row.id),
  'file.organizationId = :organizationId': (row, p) => row.organizationId === p.organizationId,
  'file.conversationId IS NULL': (row) => row.conversationId == null,
  "file.metadata->>'gatewayId' = :gatewayId": (row, p) => row.metadata?.gatewayId === p.gatewayId,
  "file.metadata->>'endUserId' = :endUserId": (row, p) => row.metadata?.endUserId === p.endUserId,
  "file.metadata->>'threadId' = :threadId": (row, p) => row.metadata?.threadId === p.threadId,
  "file.metadata->>'source' IN (:...sources)": (row, p) => p.sources.includes(row.metadata?.source),
  'file.createdAt < :cutoff': (row, p) => row.createdAt < p.cutoff,
};

function harness(seed: Partial<AgentFile>[] = []) {
  const table = fakeRepository<AgentFile>({ make: () => new AgentFile(), seed: seed as any, idPrefix: 'file' });
  (table as any).createQueryBuilder = jest.fn(
    (alias: string) => new RecordingQueryBuilder(alias, { getMany: (q: ExecutedQuery) => matchingRows(q, table.rows(), CLAUSES) }),
  );
  const objects = new Map<string, Buffer>();
  for (const row of seed) if (row.storageKey) objects.set(row.storageKey, Buffer.from('x'));
  const storage = {
    upload: jest.fn(async (key: string, data: Buffer) => {
      objects.set(key, data);
      return key;
    }),
    delete: jest.fn(async (key: string) => void objects.delete(key)),
  };
  const service = new FilesService(table as any, storage as any, {} as any, { log: jest.fn() } as any);
  return { service, table, storage, objects };
}

const row = (id: string, extra: Partial<AgentFile> = {}): Partial<AgentFile> => ({
  id,
  organizationId: ORG,
  agentId: AGENT,
  name: `${id}.png`,
  mimeType: 'image/png',
  size: 1,
  storageKey: `${ORG}/${AGENT}/${id}/${id}.png`,
  conversationId: null,
  metadata: null,
  createdAt: new Date('2026-09-30T10:00:00Z'),
  ...extra,
});

describe('FilesService: files sent in a conversation', () => {
  it('stores bytes under the organization and the agent, with the name made safe for a key', async () => {
    const { service, objects, table } = harness();
    const stored = await service.storeBytes(ORG, Buffer.from('hello'), { name: '../../etc/passwd', mimeType: 'text/plain' }, {
      agentId: AGENT,
      extractedText: 'hello',
      metadata: { source: 'channel_attachment', gatewayId: 'gw-1' },
    });
    expect(stored.storageKey).toMatch(new RegExp(`^${ORG}/${AGENT}/[0-9a-f-]{36}/passwd$`));
    expect(objects.get(stored.storageKey)?.toString()).toBe('hello');
    expect(table.rows()[0]).toMatchObject({ name: '../../etc/passwd', mimeType: 'text/plain', size: 5, conversationId: null, uploadedBy: null });
  });

  it('refuses an agent id that is not an id', async () => {
    const { service } = harness();
    await expect(service.storeBytes(ORG, Buffer.from('x'), { name: 'a', mimeType: 'text/plain' }, { agentId: '../other-org' })).rejects.toThrow('agentId must be a UUID');
  });

  it('files attachments under a conversation, only within the organization', async () => {
    const { service, table } = harness([row('00000000-0000-4000-8000-000000000001'), row('00000000-0000-4000-8000-000000000002', { organizationId: 'org-2' })]);
    await service.attachToConversation(ORG, ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'not-an-id'], 'conv-1', 'run-1');
    expect(table.rows().map((r) => [r.id.slice(-1), r.conversationId, r.runId ?? null])).toEqual([
      ['1', 'conv-1', 'run-1'],
      ['2', null, null],
    ]);
  });

  it('removes a conversation\'s files, stored objects included, and nobody else\'s', async () => {
    const { service, table, objects } = harness([
      row('a', { conversationId: 'conv-1' }),
      row('b', { conversationId: 'conv-2' }),
      row('c', { conversationId: 'conv-1', organizationId: 'org-2' }),
    ]);
    await expect(service.removeForConversations(ORG, ['conv-1'])).resolves.toBe(1);
    expect(table.rows().map((r) => r.id)).toEqual(['b', 'c']);
    expect(objects.has(`${ORG}/${AGENT}/a/a.png`)).toBe(false);
    expect(objects.has(`${ORG}/${AGENT}/b/b.png`)).toBe(true);
  });

  it('removes the row even when the stored object is already gone', async () => {
    const { service, table, storage } = harness([row('a', { conversationId: 'conv-1' })]);
    storage.delete.mockRejectedValueOnce(new Error('no such key'));
    await service.removeForConversations(ORG, ['conv-1']);
    expect(table.rows()).toEqual([]);
  });

  it('finds a visitor\'s unsent uploads only when every id is theirs', async () => {
    const mine = { source: 'web_chat_upload', gatewayId: 'gw-1', endUserId: 'eu-1' };
    const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c'];
    const { service } = harness([
      row(ids[0], { metadata: mine }),
      row(ids[1], { metadata: { ...mine, endUserId: 'eu-2' } }),
      row(ids[2], { metadata: mine, conversationId: 'conv-1' }),
    ]);
    const found = await service.findUnsentUploads(ORG, [ids[0]], { gatewayId: 'gw-1', endUserId: 'eu-1' });
    expect(found?.map((f) => f.id)).toEqual([ids[0]]);
    // Someone else's, and one already sent: the lot is refused.
    await expect(service.findUnsentUploads(ORG, [ids[0], ids[1]], { gatewayId: 'gw-1', endUserId: 'eu-1' })).resolves.toBeNull();
    await expect(service.findUnsentUploads(ORG, [ids[2]], { gatewayId: 'gw-1', endUserId: 'eu-1' })).resolves.toBeNull();
    await expect(service.findUnsentUploads(ORG, [ids[0]], { gatewayId: 'gw-2', endUserId: 'eu-1' })).resolves.toBeNull();
    await expect(service.findUnsentUploads(ORG, ['not-an-id'], { gatewayId: 'gw-1', endUserId: 'eu-1' })).resolves.toBeNull();
    // Without an owner to scope by, nothing.
    await expect(service.findUnsentUploads(ORG, [ids[0]], { gatewayId: 'gw-1' })).resolves.toBeNull();
  });

  it('erases a widget thread\'s unsent uploads, and nothing sent or elsewhere', async () => {
    const { service, table } = harness([
      row('a', { metadata: { source: 'widget_upload', gatewayId: 'gw-1', threadId: 'wt-1' } }),
      row('b', { metadata: { source: 'widget_upload', gatewayId: 'gw-1', threadId: 'wt-2' } }),
      row('c', { metadata: { source: 'widget_upload', gatewayId: 'gw-1', threadId: 'wt-1' }, conversationId: 'conv-1' }),
    ]);
    await expect(service.removeUnsentUploads(ORG, { gatewayId: 'gw-1', threadId: 'wt-1' })).resolves.toBe(1);
    expect(table.rows().map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('removes attachments that never reached a conversation once a day old, and no other files', async () => {
    const old = new Date('2026-09-28T10:00:00Z');
    const { service, table } = harness([
      row('stale-upload', { metadata: { source: 'web_chat_upload' }, createdAt: old }),
      row('stale-channel', { metadata: { source: 'channel_attachment' }, createdAt: old }),
      row('fresh-upload', { metadata: { source: 'web_chat_upload' }, createdAt: new Date('2026-09-30T09:00:00Z') }),
      row('sent', { metadata: { source: 'web_chat_upload' }, createdAt: old, conversationId: 'conv-1' }),
      row('dashboard-upload', { metadata: null, createdAt: old }),
    ]);
    await expect(service.removeUnsentAttachments(new Date('2026-09-29T10:00:00Z'))).resolves.toBe(2);
    expect(table.rows().map((r) => r.id)).toEqual(['fresh-upload', 'sent', 'dashboard-upload']);
  });
});
