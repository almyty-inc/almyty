import { buildHarness, fakeEnvelope, principal } from './test-support';

describe('api_key connect', () => {
  const ORG = 'org-1';
  const admin = principal('u-admin', ORG, 'admin');
  const validKeys = new Set(['sk-good-key-good']);
  const openai = () => ({
    method: 'GET', url: 'https://api.openai.com/v1/models',
    handle: (_url: string, init: RequestInit) => {
      const key = String((init.headers as Record<string, string>)['Authorization'] ?? '').replace('Bearer ', '');
      if (!validKeys.has(key)) return { status: 401, body: { error: { message: `Incorrect API key provided: ${key.slice(0, 3)}***`, type: 'invalid_request_error' } } };
      return { status: 200, body: { data: [{ id: 'gpt-4o' }], object: 'list' } };
    },
  });

  it('a rejected key is a failed connect: 422 with the provider error, row kept with failed health, then validate flips it', async () => {
    const h = buildHarness({ routes: [openai()] });
    let failure: any;
    try {
      await h.service.connect(admin, ORG, 'openai', { input: { apiKey: 'sk-wrong-key' } });
    } catch (e) {
      failure = e;
    }
    expect(failure?.getStatus?.()).toBe(422);
    expect(failure.response).toMatchObject({ code: 'CONNECTION_VALIDATION_FAILED', message: expect.stringContaining('provider rejected the credential (401') });
    const kept = failure.response.connection;
    expect(kept).toMatchObject({ connectorKey: 'openai', health: { status: 'failed', error: expect.stringContaining('401') }, accountLabel: null });
    expect(JSON.stringify(failure.response)).not.toContain('sk-wrong-key');
    expect(h.credentials.rows).toHaveLength(1);
    expect(h.credentials.rows[0].healthStatus).toBe('failed');
    expect(h.credentials.rows[0].config.apiKey).toMatch(/^encrypted:/);
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection_connect', details: expect.objectContaining({ ok: false, status: 'failed' }) }));

    // The user fixes the key at the provider; validate re-runs the probe.
    validKeys.add('sk-wrong-key');
    const revalidated = await h.service.validate(admin, ORG, kept.id);
    expect(revalidated.health).toMatchObject({ status: 'valid', error: null });
    expect(revalidated.accountLabel).toBe('OpenAI key ...-key');
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection_validate', details: expect.objectContaining({ ok: true }) }));
    validKeys.delete('sk-wrong-key');
  });

  it('a good key connects, is encrypted at rest and never appears in the view', async () => {
    const h = buildHarness({ routes: [openai()] });
    const done = await h.service.connect(admin, ORG, 'openai', { input: { apiKey: 'sk-good-key-good' }, name: 'Team OpenAI' });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(done.connection).toMatchObject({ name: 'Team OpenAI', method: 'api_key', kind: 'inference', health: { status: 'valid' }, accountLabel: 'OpenAI key ...good' });
    expect(JSON.stringify(done.connection)).not.toContain('sk-good-key-good');
    const row = h.credentials.rows[0];
    expect(row.config.apiKey).toMatch(/^encrypted:/);
    expect(await fakeEnvelope.decryptForOrg(ORG, row.config.apiKey)).toBe('sk-good-key-good');
    expect(row.keyName).toBe('Authorization');
  });

  it('rejects input that does not fit the method schema before touching the provider', async () => {
    const h = buildHarness({ routes: [openai()] });
    await expect(h.service.connect(admin, ORG, 'openai', { input: { apiKey: 'short', extra: 1 } })).rejects.toMatchObject({ response: { code: 'CONNECT_INPUT_INVALID', errors: expect.arrayContaining(['apiKey is too short', 'extra is not a known field']) } });
    await expect(h.service.connect(admin, ORG, 'openai', { method: 'oauth2_pkce' })).rejects.toMatchObject({ response: { code: 'CONNECT_METHOD_UNSUPPORTED' } });
    await expect(h.service.connect(admin, ORG, 'does-not-exist', {})).rejects.toMatchObject({ response: { code: 'CONNECTOR_UNKNOWN' } });
    expect(h.http.calls).toHaveLength(0);
    expect(h.credentials.rows).toHaveLength(0);
  });

  it('quota and billing answers are reported as quota, not failed', async () => {
    const h = buildHarness({ routes: [{ url: 'https://api.openai.com/v1/models', handle: () => ({ status: 429, body: { error: { message: 'insufficient_quota' } } }) }] });
    await expect(h.service.connect(admin, ORG, 'openai', { input: { apiKey: 'sk-broke-account' } })).rejects.toMatchObject({ response: { code: 'CONNECTION_VALIDATION_FAILED', connection: expect.objectContaining({ health: expect.objectContaining({ status: 'quota' }) }) } });
  });

  it('rotate returns the form first, then accepts new values in place and keeps plain fields', async () => {
    const seen: string[] = [];
    const h = buildHarness({ routes: [{ url: 'https://vllm.example.com/v1/models', handle: (_u, init) => { seen.push(String((init.headers as any)['Authorization'])); return { status: 200, body: { data: [] } }; } }] });
    const done = await h.service.connect(admin, ORG, 'openai-compatible', { input: { baseUrl: 'https://vllm.example.com/v1', apiKey: 'first-key-value' } });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(done.connection.accountLabel).toBe('https://vllm.example.com/v1');

    const form = await h.service.rotate(admin, ORG, done.connection.id, {});
    expect(form.pending).toBe(true);
    if (!form.pending || !('form' in form)) throw new Error('expected a form');
    expect(form.method).toBe('api_key');
    expect(Object.keys(form.form.schema!.properties)).toEqual(['baseUrl', 'apiKey']);

    const rotated = await h.service.rotate(admin, ORG, done.connection.id, { input: { apiKey: 'second-key-value' } });
    if (rotated.pending !== false) throw new Error('expected a connection');
    expect(rotated.connection.id).toBe(done.connection.id);
    expect(seen).toEqual(['Bearer first-key-value', 'Bearer second-key-value']);
    expect(h.credentials.rows).toHaveLength(1);
    expect(h.credentials.rows[0].config.baseUrl).toBe('https://vllm.example.com/v1');
    expect(await fakeEnvelope.decryptForOrg(ORG, h.credentials.rows[0].config.apiKey)).toBe('second-key-value');
  });

  it('disconnect calls the connector revoke endpoint with the secret, then deletes the row', async () => {
    const revokes: string[] = [];
    const h = buildHarness({ routes: [
      { url: 'https://acme.example.com/v1/models', handle: () => ({ status: 200, body: { data: [] } }) },
      { method: 'DELETE', url: 'https://acme.example.com/v1/keys/self', handle: (_u, init) => { revokes.push(String((init.headers as any)['Authorization'])); return { status: 204 }; } },
    ] });
    await h.catalog.createCustom(ORG, 'u-admin', {
      key: 'acme', kind: 'inference', displayName: 'Acme',
      connect: [{ type: 'api_key', schema: { type: 'object', properties: { apiKey: { type: 'string', 'x-secret': true } }, required: ['apiKey'] } }],
      validation: { kind: 'http', url: 'https://acme.example.com/v1/models' },
      revoke: { kind: 'http', url: 'https://acme.example.com/v1/keys/self', method: 'DELETE' },
    } as any);
    const done = await h.service.connect(admin, ORG, 'acme', { input: { apiKey: 'acme-secret-key' } });
    if (done.pending !== false) throw new Error('expected a connection');
    expect(await h.service.disconnect(admin, ORG, done.connection.id)).toEqual({ revoked: true, revokeError: undefined });
    expect(revokes).toEqual(['Bearer acme-secret-key']);
    expect(h.credentials.rows).toHaveLength(0);
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connection_disconnect', details: expect.objectContaining({ revoked: true }) }));
    await expect(h.service.get(admin, ORG, done.connection.id)).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
  });

  it('never probes a private or non-http validation URL (SSRF guard)', async () => {
    const h = buildHarness();
    await expect(h.service.connect(admin, ORG, 'openai-compatible', { input: { baseUrl: 'http://169.254.169.254/v1', apiKey: 'k' } })).rejects.toMatchObject({ response: { code: 'CONNECTION_VALIDATION_FAILED', message: expect.stringContaining('refused') } });
    expect(h.http.calls).toHaveLength(0);
  });
});
