import { buildHarness, principal } from './test-support';

/**
 * Gate 5 wired into rotate and disconnect: a provider with a
 * provisioning API rotates in place; one without falls through to the
 * re-connect form; disconnect prefers the provider-side revoke.
 */
describe('ConnectionsService with rotation', () => {
  const ORG = 'org-1';
  const admin = principal('u-admin', ORG, 'admin');
  const validKeys = new Set(['sk-old-key-000', 'sk-new-key-111']);
  const openai = () => ({
    method: 'GET', url: 'https://api.openai.com/v1/models',
    handle: (_url: string, init: RequestInit) => {
      const key = String((init.headers as Record<string, string>)['Authorization'] ?? '').replace('Bearer ', '');
      return validKeys.has(key) ? { status: 200, body: { data: [{ id: 'gpt-4o' }] } } : { status: 401, body: { error: { message: 'bad key' } } };
    },
  });

  async function connected(rotation: any) {
    const h = buildHarness({ routes: [openai()], rotation });
    const done: any = await h.service.connect(admin, ORG, 'openai', { input: { apiKey: 'sk-old-key-000' } });
    return { h, id: done.connection.id as string };
  }

  it('rotates in place through the provider seam: validates the minted key, persists it encrypted, keeps the row id', async () => {
    const rotation = {
      rotate: jest.fn(async (_conn: any, seams: any) => {
        const verdict = await seams.validate({ apiKey: 'sk-new-key-111' });
        expect(verdict.ok).toBe(true);
        await seams.persist({ apiKey: 'sk-new-key-111' }, { label: 'almyty rotated', expiresAt: null, rotatedAt: new Date('2026-09-08T12:00:00Z') });
        return { manual: false, label: 'almyty rotated', expiresAt: null, previousRevoked: true };
      }),
      revoke: jest.fn(),
    };
    const { h, id } = await connected(rotation);
    const result: any = await h.service.rotate(admin, ORG, id, {});
    expect(result.pending).toBe(false);
    expect(result.rotation).toMatchObject({ manual: false, previousRevoked: true });
    expect(result.connection.id).toBe(id);
    const row = h.credentials.rows[0];
    expect(row.config.apiKey).toMatch(/^encrypted:/);
    expect(await h.service.decryptConfig(row)).toMatchObject({ apiKey: 'sk-new-key-111' });
    expect(row.metadata.rotatedAt).toBe('2026-09-08T12:00:00.000Z');
    expect(rotation.rotate.mock.calls[0][0]).toMatchObject({ id, connectorKey: 'openai', secrets: { apiKey: 'sk-old-key-000' } });
  });

  it('falls through to the re-connect form when the provider cannot mint keys', async () => {
    const rotation = { rotate: jest.fn().mockResolvedValue({ manual: true, reason: 'no provisioning API', keyPageUrl: 'https://platform.openai.com/api-keys' }), revoke: jest.fn() };
    const { h, id } = await connected(rotation);
    const result: any = await h.service.rotate(admin, ORG, id, {});
    expect(result.pending).toBe(true);
    expect(result.form.schema).toBeTruthy();
  });

  it('disconnect uses the provider-side revoke when supported and still removes the row', async () => {
    const rotation = { rotate: jest.fn(), revoke: jest.fn().mockResolvedValue({ supported: true, revoked: true }) };
    const { h, id } = await connected(rotation);
    const out = await h.service.disconnect(admin, ORG, id);
    expect(out).toEqual({ revoked: true, revokeError: undefined });
    expect(rotation.revoke).toHaveBeenCalledWith(expect.objectContaining({ id, secrets: { apiKey: 'sk-old-key-000' } }), { userId: 'u-admin' });
    expect(h.credentials.rows).toHaveLength(0);
  });
});
