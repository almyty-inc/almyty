import { AnthropicRotation } from '../providers/anthropic.rotation';
import { BasetenRotation } from '../providers/baseten.rotation';
import { FireworksRotation } from '../providers/fireworks.rotation';
import { HuggingFaceRotation } from '../providers/huggingface.rotation';
import { MistralRotation } from '../providers/mistral.rotation';
import { OpenAiRotation } from '../providers/openai.rotation';
import { OpenRouterRotation } from '../providers/openrouter.rotation';
import { PerplexityRotation } from '../providers/perplexity.rotation';
import { XaiRotation } from '../providers/xai.rotation';
import { ConnectorRotation } from '../rotation.interface';
import { ctx, fixtureHttp, rejection } from './rotation-support';

describe('OpenRouterRotation', () => {
  const secrets = { apiKey: 'sk-or-v1-oldkey', provisioningKey: 'sk-or-prov-1' };

  it('mints a key through the provisioning API and keeps the hash for later revoke', async () => {
    const f = fixtureHttp([{ method: 'POST', url: 'https://openrouter.ai/api/v1/keys', handle: () => ({ status: 201, body: { key: 'sk-or-v1-newkey', data: { hash: 'h-new', name: 'almyty conn-123 2026-09-08', created_at: '2026-09-08T12:00:00Z' } } }) }]);
    const out = await new OpenRouterRotation(f.http).rotate(secrets, ctx);
    expect(out).toEqual({ next: { apiKey: 'sk-or-v1-newkey', keyHash: 'h-new' }, label: 'almyty conn-123 2026-09-08' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].headers.authorization).toBe('Bearer sk-or-prov-1');
    expect(f.calls[0].json).toEqual({ name: 'almyty conn-123 2026-09-08' });
  });

  it('revokes by stored hash, or finds the hash by the key label when none is stored', async () => {
    const f = fixtureHttp([
      { method: 'DELETE', url: /\/api\/v1\/keys\/h-/, handle: () => ({ status: 200, body: { deleted: true } }) },
      { method: 'GET', url: /\/api\/v1\/key$/, handle: () => ({ status: 200, body: { data: { label: 'sk-or-v1-old...key', usage: 1 } } }) },
      { method: 'GET', url: 'https://openrouter.ai/api/v1/keys?', handle: () => ({ status: 200, body: { data: [{ hash: 'h-other', label: 'other' }, { hash: 'h-old', label: 'sk-or-v1-old...key' }] } }) },
    ]);
    const p = new OpenRouterRotation(f.http);
    await p.revoke({ ...secrets, keyHash: 'h-stored' });
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['DELETE https://openrouter.ai/api/v1/keys/h-stored']);
    f.calls.length = 0;
    await p.revoke(secrets);
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://openrouter.ai/api/v1/key',
      'GET https://openrouter.ai/api/v1/keys?include_disabled=false',
      'DELETE https://openrouter.ai/api/v1/keys/h-old',
    ]);
    expect(f.calls[0].headers.authorization).toBe('Bearer sk-or-v1-oldkey');
    expect(f.calls[1].headers.authorization).toBe('Bearer sk-or-prov-1');
  });

  it('describes the calling key from GET /key without a provisioning key', async () => {
    const f = fixtureHttp([{ method: 'GET', url: 'https://openrouter.ai/api/v1/key', handle: () => ({ status: 200, body: { data: { label: 'team key', limit: null } } }) }]);
    expect(await new OpenRouterRotation(f.http).describe({ apiKey: 'sk-or-v1-x' })).toEqual({ label: 'team key' });
  });

  it('maps 401 to ROTATION_AUTH, other failures to ROTATION_FAILED, and a missing provisioning key to ROTATION_UNSUPPORTED', async () => {
    const f = fixtureHttp([
      { method: 'POST', url: 'https://openrouter.ai/api/v1/keys', handle: () => ({ status: 401, body: { error: { message: 'bad provisioning key' } } }) },
      { method: 'GET', url: 'https://openrouter.ai/api/v1/key', handle: () => ({ status: 500, body: 'boom' }) },
    ]);
    const p = new OpenRouterRotation(f.http);
    const auth = await rejection(p.rotate(secrets, ctx));
    expect(auth.code).toBe('ROTATION_AUTH');
    expect(auth.message).not.toContain('sk-or-prov-1');
    expect((await rejection(p.describe({ apiKey: 'sk-or-v1-x' }))).code).toBe('ROTATION_FAILED');
    expect((await rejection(p.rotate({ apiKey: 'sk-or-v1-x' }, ctx))).code).toBe('ROTATION_UNSUPPORTED');
  });
});

describe('OpenAiRotation', () => {
  const secrets = { apiKey: 'sk-proj-abcdef1234567890xyz', adminKey: 'sk-admin-1', projectId: 'proj_abc' };

  it('creates a project service account whose key becomes the connection secret', async () => {
    const f = fixtureHttp([{ method: 'POST', url: 'https://api.openai.com/v1/organization/projects/proj_abc/service_accounts', handle: () => ({ status: 200, body: { object: 'organization.project.service_account', id: 'svc_1', name: 'almyty conn-123 2026-09-08', role: 'member', created_at: 1757332800, api_key: { object: 'organization.project.service_account.api_key', value: 'sk-proj-new', name: 'almyty conn-123 2026-09-08', created_at: 1757332800, id: 'key_new' } } }) }]);
    const out = await new OpenAiRotation(f.http).rotate(secrets, ctx);
    expect(out).toEqual({ next: { apiKey: 'sk-proj-new', keyId: 'key_new', serviceAccountId: 'svc_1' }, label: 'almyty conn-123 2026-09-08' });
    expect(f.calls[0].headers.authorization).toBe('Bearer sk-admin-1');
    expect(f.calls[0].json).toEqual({ name: 'almyty conn-123 2026-09-08' });
  });

  it('deletes the service account it minted, or finds a hand-made key by redacted value and deletes that', async () => {
    const f = fixtureHttp([
      { method: 'DELETE', url: 'https://api.openai.com/v1/organization/projects/proj_abc/service_accounts/svc_1', handle: () => ({ status: 200, body: { deleted: true } }) },
      { method: 'GET', url: 'https://api.openai.com/v1/organization/projects/proj_abc/api_keys?limit=100', handle: (url) => url.includes('after=') ? ({ status: 200, body: { data: [{ id: 'key_old', redacted_value: 'sk-proj-abc...xyz', name: 'legacy', created_at: 1700000000, last_used_at: 1757000000 }], has_more: false } }) : ({ status: 200, body: { data: [{ id: 'key_x', redacted_value: 'sk-proj-zzz...zzz' }], has_more: true, last_id: 'key_x' } }) },
      { method: 'DELETE', url: 'https://api.openai.com/v1/organization/projects/proj_abc/api_keys/key_old', handle: () => ({ status: 200, body: { deleted: true } }) },
    ]);
    const p = new OpenAiRotation(f.http);
    await p.revoke({ ...secrets, serviceAccountId: 'svc_1' });
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['DELETE https://api.openai.com/v1/organization/projects/proj_abc/service_accounts/svc_1']);
    f.calls.length = 0;
    await p.revoke(secrets);
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.openai.com/v1/organization/projects/proj_abc/api_keys?limit=100',
      'GET https://api.openai.com/v1/organization/projects/proj_abc/api_keys?limit=100&after=key_x',
      'DELETE https://api.openai.com/v1/organization/projects/proj_abc/api_keys/key_old',
    ]);
    const d = await p.describe(secrets);
    expect(d).toEqual({ label: 'legacy', createdAt: new Date(1700000000 * 1000), lastUsedAt: new Date(1757000000 * 1000) });
  });

  it('reports a key the admin cannot see as ROTATION_FAILED and a rejected admin key as ROTATION_AUTH', async () => {
    const f = fixtureHttp([{ method: 'GET', url: 'https://api.openai.com/v1/organization/projects/proj_abc/api_keys', handle: () => ({ status: 200, body: { data: [], has_more: false } }) }]);
    expect((await rejection(new OpenAiRotation(f.http).describe(secrets))).code).toBe('ROTATION_FAILED');
    const g = fixtureHttp([{ method: 'POST', url: 'https://api.openai.com/v1/organization/projects/proj_abc/service_accounts', handle: () => ({ status: 403, body: { error: { message: 'insufficient permissions' } } }) }]);
    const e = await rejection(new OpenAiRotation(g.http).rotate(secrets, ctx));
    expect(e.code).toBe('ROTATION_AUTH');
    expect(e.message).toContain('insufficient permissions');
  });
});

describe('AnthropicRotation', () => {
  const secrets = { apiKey: 'sk-ant-api03-R2DxxxxxxxxxxxxigAA', adminKey: 'sk-ant-admin-1' };
  const listed = { data: [{ id: 'apikey_1', name: 'Developer Key', created_at: '2024-10-30T23:58:27.427722Z', expires_at: '2027-01-01T00:00:00Z', partial_key_hint: 'sk-ant-api03-R2D...igAA', status: 'active' }], has_more: false };

  it('cannot create, deactivates by matching the partial key hint, and describes name, created and expiry', async () => {
    const f = fixtureHttp([
      { method: 'GET', url: 'https://api.anthropic.com/v1/organizations/api_keys?limit=1000', handle: () => ({ status: 200, body: listed }) },
      { method: 'POST', url: 'https://api.anthropic.com/v1/organizations/api_keys/apikey_1', handle: () => ({ status: 200, body: { ...listed.data[0], status: 'inactive' } }) },
    ]);
    const p = new AnthropicRotation(f.http);
    expect(p.capabilities()).toEqual({ create: false, revoke: true, metadata: true, refresh: false });
    expect((p as ConnectorRotation).rotate).toBeUndefined();
    await p.revoke(secrets);
    expect(f.calls[0].headers['x-api-key']).toBe('sk-ant-admin-1');
    expect(f.calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(f.calls[1].method).toBe('POST');
    expect(f.calls[1].json).toEqual({ status: 'inactive' });
    expect(await p.describe(secrets)).toEqual({ label: 'Developer Key', createdAt: new Date('2024-10-30T23:58:27.427722Z'), expiresAt: new Date('2027-01-01T00:00:00Z') });
  });

  it('maps a 401 on the admin list to ROTATION_AUTH without the admin key in the message', async () => {
    const f = fixtureHttp([{ method: 'GET', url: 'https://api.anthropic.com/v1/organizations/api_keys', handle: () => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } }) }]);
    const e = await rejection(new AnthropicRotation(f.http).revoke(secrets));
    expect(e.code).toBe('ROTATION_AUTH');
    expect(e.message).not.toContain('sk-ant-admin-1');
  });
});

describe('HuggingFaceRotation', () => {
  it('describes the calling token from whoami-v2 and revokes it through the credentials endpoint', async () => {
    const f = fixtureHttp([
      { method: 'GET', url: 'https://huggingface.co/api/whoami-v2', handle: () => ({ status: 200, body: { type: 'user', name: 'frane', auth: { type: 'access_token', accessToken: { displayName: 'almyty', role: 'read', createdAt: '2026-01-01T00:00:00Z' }, expiresAt: '2026-12-31T00:00:00Z' } } }) },
      { method: 'POST', url: 'https://huggingface.co/api/credentials/revoke', handle: () => ({ status: 202, body: {} }) },
    ]);
    const p = new HuggingFaceRotation(f.http, 'registry-huggingface');
    expect(p.key).toBe('registry-huggingface');
    expect(await p.describe({ apiKey: 'hf_abc' })).toEqual({ label: 'frane (almyty)', createdAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-12-31T00:00:00Z'), scopes: ['read'] });
    await p.revoke({ apiKey: 'hf_abc' });
    expect(f.calls[1].headers.authorization).toBeUndefined();
    expect(f.calls[1].json).toEqual({ credentials: ['hf_abc'] });
  });

  it('maps a rejected token to ROTATION_AUTH', async () => {
    const f = fixtureHttp([{ method: 'GET', url: 'https://huggingface.co/api/whoami-v2', handle: () => ({ status: 401, body: { error: 'Invalid credentials' } }) }]);
    expect((await rejection(new HuggingFaceRotation(f.http).describe({ apiKey: 'hf_bad' }))).code).toBe('ROTATION_AUTH');
  });
});

describe('XaiRotation', () => {
  const secrets = { apiKey: 'xai-oldkey1234', managementKey: 'xai-mgmt', teamId: 'team-1' };

  it('creates through the management API with full ACLs, deletes by id, and describes from the team list', async () => {
    const f = fixtureHttp([
      { method: 'POST', url: 'https://management-api.x.ai/auth/teams/team-1/api-keys', handle: () => ({ status: 200, body: { apiKey: 'xai-new', apiKeyId: 'k-new', name: 'almyty conn-123 2026-09-08', createTime: '2026-09-08T12:00:00Z', expireTime: '2027-09-08T12:00:00Z' } }) },
      { method: 'GET', url: 'https://management-api.x.ai/auth/teams/team-1/api-keys?pageSize=100', handle: () => ({ status: 200, body: { apiKeys: [{ apiKeyId: 'k-old', redactedApiKey: 'xai-***1234', name: 'old', createTime: '2026-01-01T00:00:00Z' }] } }) },
      { method: 'DELETE', url: 'https://management-api.x.ai/auth/api-keys/k-old', handle: () => ({ status: 200, body: {} }) },
    ]);
    const p = new XaiRotation(f.http);
    const out = await p.rotate(secrets, ctx);
    expect(out).toEqual({ next: { apiKey: 'xai-new', keyId: 'k-new' }, label: 'almyty conn-123 2026-09-08', expiresAt: new Date('2027-09-08T12:00:00Z') });
    expect(f.calls[0].headers.authorization).toBe('Bearer xai-mgmt');
    expect(f.calls[0].json).toEqual({ name: 'almyty conn-123 2026-09-08', acls: ['api-key:endpoint:*', 'api-key:model:*'] });
    await p.revoke(secrets);
    expect(f.calls.slice(1).map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://management-api.x.ai/auth/teams/team-1/api-keys?pageSize=100', 'DELETE https://management-api.x.ai/auth/api-keys/k-old']);
    expect(await p.describe(secrets)).toEqual({ label: 'old', createdAt: new Date('2026-01-01T00:00:00Z'), expiresAt: undefined });
  });

  it('refuses a team id that is not a path segment', async () => {
    const f = fixtureHttp([]);
    expect((await rejection(new XaiRotation(f.http).rotate({ ...secrets, teamId: 'a/b' }, ctx))).code).toBe('ROTATION_FAILED');
    expect(f.calls).toHaveLength(0);
  });
});

describe('MistralRotation', () => {
  const secrets = { apiKey: 'mistral-oldkey-xyz', adminKey: 'mistral-admin', workspaceId: 'ws-1', userId: 'user-1' };

  it('creates with user and workspace, deletes by key_id found through hidden_key, and describes last use', async () => {
    const f = fixtureHttp([
      { method: 'POST', url: 'https://api.mistral.ai/v1/admin/api-keys', handle: () => ({ status: 200, body: { key_id: 'k-new', key: 'mistral-new', hidden_key: 'mis...new', name: 'almyty conn-123 2026-09-08', created_at: '2026-09-08T12:00:00Z', expiration_date: null } }) },
      { method: 'GET', url: 'https://api.mistral.ai/v1/admin/api-keys', handle: () => ({ status: 200, body: { keys: [{ key_id: 'k-old', hidden_key: 'mistral-...xyz', name: 'old', created_at: '2026-01-01T00:00:00Z', last_used: '2026-09-01T00:00:00Z', expiration_date: '2026-12-01T00:00:00Z' }] } }) },
      { method: 'DELETE', url: 'https://api.mistral.ai/v1/admin/api-keys/k-old', handle: () => ({ status: 200, body: { detail: 'deleted' } }) },
    ]);
    const p = new MistralRotation(f.http);
    expect(await p.rotate(secrets, ctx)).toEqual({ next: { apiKey: 'mistral-new', keyId: 'k-new' }, label: 'almyty conn-123 2026-09-08', expiresAt: undefined });
    expect(f.calls[0].json).toEqual({ user_id: 'user-1', workspace_uuid: 'ws-1', name: 'almyty conn-123 2026-09-08' });
    expect(f.calls[0].headers.authorization).toBe('Bearer mistral-admin');
    await p.revoke(secrets);
    expect(f.calls[2].method).toBe('DELETE');
    expect(await p.describe(secrets)).toEqual({ label: 'old', createdAt: new Date('2026-01-01T00:00:00Z'), lastUsedAt: new Date('2026-09-01T00:00:00Z'), expiresAt: new Date('2026-12-01T00:00:00Z') });
  });
});

describe('FireworksRotation', () => {
  const secrets = { apiKey: 'fw-old', accountId: 'acme', userId: 'frane' };

  it('creates under the account user with the connection key, deletes with :delete and the successor as bearer', async () => {
    const f = fixtureHttp([
      { method: 'POST', url: 'https://api.fireworks.ai/v1/accounts/acme/users/frane/apiKeys', handle: (url) => url.endsWith(':delete') ? ({ status: 200, body: {} }) : ({ status: 200, body: { keyId: 'k-new', key: 'fw-new', displayName: 'almyty conn-123 2026-09-08', createTime: '2026-09-08T12:00:00Z' } }) },
      { method: 'GET', url: 'https://api.fireworks.ai/v1/accounts/acme/users/frane/apiKeys', handle: () => ({ status: 200, body: { apiKeys: [{ keyId: 'k-old', displayName: 'old', createTime: '2026-01-01T00:00:00Z' }] } }) },
    ]);
    const p = new FireworksRotation(f.http);
    expect(await p.rotate(secrets, ctx)).toEqual({ next: { apiKey: 'fw-new', keyId: 'k-new' }, label: 'almyty conn-123 2026-09-08', expiresAt: undefined });
    expect(f.calls[0].headers.authorization).toBe('Bearer fw-old');
    expect(f.calls[0].json).toEqual({ apiKey: { displayName: 'almyty conn-123 2026-09-08' } });
    await p.revoke({ ...secrets, keyId: 'k-old' }, { ...ctx, successor: { apiKey: 'fw-new' } });
    expect(f.calls[1].url).toBe('https://api.fireworks.ai/v1/accounts/acme/users/frane/apiKeys:delete');
    expect(f.calls[1].headers.authorization).toBe('Bearer fw-new');
    expect(f.calls[1].json).toEqual({ keyId: 'k-old' });
    expect(await p.describe({ ...secrets, keyId: 'k-old' })).toEqual({ label: 'old', createdAt: new Date('2026-01-01T00:00:00Z'), expiresAt: undefined });
  });

  it('cannot revoke or describe a key it did not mint', async () => {
    const f = fixtureHttp([]);
    const p = new FireworksRotation(f.http);
    expect((await rejection(p.revoke(secrets, ctx))).code).toBe('ROTATION_UNSUPPORTED');
    expect((await rejection(p.describe(secrets))).code).toBe('ROTATION_UNSUPPORTED');
  });
});

describe('PerplexityRotation', () => {
  it('mints with the current key and revokes the old one using the successor as bearer', async () => {
    const f = fixtureHttp([
      { method: 'POST', url: 'https://api.perplexity.ai/generate_auth_token', handle: () => ({ status: 200, body: { auth_token: 'pplx-new', token_name: 'almyty conn-123 2026-09-08', created_at_epoch_seconds: 1757332800 } }) },
      { method: 'POST', url: 'https://api.perplexity.ai/revoke_auth_token', handle: () => ({ status: 200, body: {} }) },
    ]);
    const p = new PerplexityRotation(f.http);
    expect(p.capabilities()).toEqual({ create: true, revoke: true, metadata: false, refresh: false });
    expect(await p.rotate({ apiKey: 'pplx-old' }, ctx)).toEqual({ next: { apiKey: 'pplx-new' }, label: 'almyty conn-123 2026-09-08' });
    expect(f.calls[0].headers.authorization).toBe('Bearer pplx-old');
    expect(f.calls[0].json).toEqual({ token_name: 'almyty conn-123 2026-09-08' });
    await p.revoke({ apiKey: 'pplx-old' }, { ...ctx, successor: { apiKey: 'pplx-new' } });
    expect(f.calls[1].headers.authorization).toBe('Bearer pplx-new');
    expect(f.calls[1].json).toEqual({ auth_token: 'pplx-old' });
    await p.revoke({ apiKey: 'pplx-old' }, ctx);
    expect(f.calls[2].headers.authorization).toBe('Bearer pplx-old');
  });

  it('maps a 403 to ROTATION_AUTH', async () => {
    const f = fixtureHttp([{ method: 'POST', url: 'https://api.perplexity.ai/generate_auth_token', handle: () => ({ status: 403, body: { error: 'forbidden' } }) }]);
    expect((await rejection(new PerplexityRotation(f.http).rotate({ apiKey: 'pplx-old' }, ctx))).code).toBe('ROTATION_AUTH');
  });
});

describe('BasetenRotation', () => {
  const secrets = { apiKey: 'abcd1234.secretpart', managementKey: 'mgmt.key' };

  it('creates a full-access team key with a slug name, deletes by prefix, and describes from the list', async () => {
    const f = fixtureHttp([
      { method: 'POST', url: 'https://api.baseten.co/v1/api_keys', handle: () => ({ status: 200, body: { api_key: 'wxyz9876.newsecret' } }) },
      { method: 'DELETE', url: 'https://api.baseten.co/v1/api_keys/abcd1234', handle: () => ({ status: 200, body: { prefix: 'abcd1234' } }) },
      { method: 'GET', url: 'https://api.baseten.co/v1/api_keys', handle: () => ({ status: 200, body: { api_keys: [{ prefix: 'abcd1234', name: 'ci-deploy-key', type: 'WORKSPACE_MANAGE_ALL', team_name: 'My Team' }] } }) },
    ]);
    const p = new BasetenRotation(f.http);
    expect(await p.rotate(secrets, ctx)).toEqual({ next: { apiKey: 'wxyz9876.newsecret', keyPrefix: 'wxyz9876' }, label: 'almyty-conn-123-2026-09-08' });
    expect(f.calls[0].headers.authorization).toBe('Bearer mgmt.key');
    expect(f.calls[0].json).toEqual({ name: 'almyty-conn-123-2026-09-08', type: 'WORKSPACE_MANAGE_ALL' });
    await p.revoke(secrets);
    expect(f.calls[1].url).toBe('https://api.baseten.co/v1/api_keys/abcd1234');
    expect(await p.describe(secrets)).toEqual({ label: 'ci-deploy-key (My Team)', createdAt: undefined, lastUsedAt: undefined, expiresAt: undefined });
  });

  it('refuses a key with no prefix', async () => {
    const f = fixtureHttp([]);
    expect((await rejection(new BasetenRotation(f.http).revoke({ apiKey: 'noprefix', managementKey: 'm' }))).code).toBe('ROTATION_FAILED');
  });
});
