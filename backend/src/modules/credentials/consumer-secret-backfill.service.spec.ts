import { Api } from '../../entities/api.entity';
import { ChannelInstallation } from '../../entities/channel-installation.entity';
import { LlmProvider, LlmProviderType } from '../../entities/llm-provider.entity';
import { McpSource } from '../../entities/mcp-source.entity';
import { encryptField, isEncrypted } from '../../common/security/field-crypto';
import { makeEnvelopeCryptoMock } from '../../test/envelope-crypto.mock';
import { makeCredentialRefFake } from '../../test/credential-ref.fake';
import { ConsumerSecretBackfillService } from './consumer-secret-backfill.service';

const repoOf = <T>(rows: T[]) => ({
  find: jest.fn(async () => rows),
  save: jest.fn(async (row: T) => row),
});

describe('ConsumerSecretBackfillService', () => {
  const build = (fixtures: { providers?: LlmProvider[]; sources?: McpSource[]; installations?: ChannelInstallation[]; apis?: Api[] } = {}) => {
    const store = makeCredentialRefFake();
    const providers = repoOf(fixtures.providers ?? []);
    const sources = repoOf(fixtures.sources ?? []);
    const installations = repoOf(fixtures.installations ?? []);
    const apis = repoOf(fixtures.apis ?? []);
    const service = new ConsumerSecretBackfillService(
      providers as any, sources as any, installations as any, apis as any, makeEnvelopeCryptoMock(), store.resolver,
    );
    return { service, store, providers, sources, installations, apis };
  };

  it('moves inline LLM provider keys into managed rows and clears the row, skipping providers already on references', async () => {
    const legacy = Object.assign(new LlmProvider(), {
      id: 'p-1', name: 'Legacy', type: LlmProviderType.OPENAI, organizationId: 'org-1',
      configuration: { apiKey: encryptField('sk-old'), usageApiKey: encryptField('adm-old'), model: 'gpt-4o' },
      credentialId: null, usageCredentialId: null,
    });
    const done = Object.assign(new LlmProvider(), {
      id: 'p-2', name: 'Done', type: LlmProviderType.OPENAI, organizationId: 'org-1', configuration: { model: 'x' }, credentialId: 'c-9', usageCredentialId: null,
    });
    const { service, store, providers } = build({ providers: [legacy, done] });

    const report = await service.run();

    expect(report.llmProviders).toEqual({ moved: 1, skipped: 1, failed: 0 });
    expect(legacy.configuration).toEqual({ model: 'gpt-4o' });
    expect(legacy.credentialId).toBeDefined();
    expect(legacy.usageCredentialId).toBeDefined();
    expect(legacy.getDecryptedApiKey()).toBe('sk-old');
    expect(legacy.getDecryptedUsageApiKey()).toBe('adm-old');
    expect(store.rows).toHaveLength(2);
    expect(providers.save).toHaveBeenCalledTimes(1);
  });

  it('moves MCP authConfig (bearer and headers) into rows and nulls the column', async () => {
    const bearer = Object.assign(new McpSource(), { id: 's-1', name: 'a', organizationId: 'org-1', authType: 'bearer', authConfig: { bearerToken: encryptField('tok') }, credentialId: null });
    const headers = Object.assign(new McpSource(), { id: 's-2', name: 'b', organizationId: 'org-1', authType: 'headers', authConfig: { headers: { 'X-K': encryptField('v') } }, credentialId: null });
    const { service, store } = build({ sources: [bearer, headers] });

    const report = await service.run();

    expect(report.mcpSources).toEqual({ moved: 2, skipped: 0, failed: 0 });
    expect(bearer.authConfig).toBeNull();
    expect(headers.authConfig).toBeNull();
    const bearerRow = store.rows.find((r) => r.id === bearer.credentialId)!;
    const headerRow = store.rows.find((r) => r.id === headers.credentialId)!;
    expect(bearerRow.type).toBe('bearer_token');
    expect(isEncrypted(bearerRow.config.token)).toBe(true);
    expect((await store.resolver.resolve('org-1', bearerRow.id)).config.token).toBe('tok');
    expect((await store.resolver.resolve('org-1', headerRow.id)).config.headers).toEqual({ 'X-K': 'v' });
    expect(bearerRow.metadata.managedBy).toEqual({ kind: 'mcp_source', id: 's-1' });
  });

  it('moves active channel installation blobs and skips revoked ones', async () => {
    const active = Object.assign(new ChannelInstallation(), { id: 'i-1', organizationId: 'org-1', externalTenantId: 'T1', status: 'active', credentials: { bot_token: encryptField('xoxb'), bot_user_id: 'U1' }, credentialId: null });
    const revoked = Object.assign(new ChannelInstallation(), { id: 'i-2', organizationId: 'org-1', externalTenantId: 'T2', status: 'revoked', credentials: { bot_token: encryptField('old') }, credentialId: null });
    const { service, store } = build({ installations: [active, revoked] });

    const report = await service.run();

    expect(report.channelInstallations).toEqual({ moved: 1, skipped: 1, failed: 0 });
    expect(active.credentials).toBeNull();
    expect(revoked.credentials).not.toBeNull();
    const row = store.rows[0];
    expect(active.credentialId).toBe(row.id);
    expect(isEncrypted(row.config.bot_token)).toBe(true);
    expect(row.config.bot_user_id).toBe('U1');
    expect((await store.resolver.resolve('org-1', row.id)).config).toEqual({ bot_token: 'xoxb', bot_user_id: 'U1' });
  });

  it('moves inline API authentication into a row bound to the API and keeps the public part with a reference', async () => {
    const api = Object.assign(new Api(), { id: 'a-1', name: 'Weather', organizationId: 'org-1', authentication: { type: 'api_key', config: { headerName: 'X-Key', apiKey: 'plain', location: 'header' } } });
    const already = Object.assign(new Api(), { id: 'a-2', name: 'Done', organizationId: 'org-1', authentication: { type: 'bearer', config: { credentialId: 'c-1' } } });
    const { service, store } = build({ apis: [api, already] });

    const report = await service.run();

    expect(report.apis).toEqual({ moved: 1, skipped: 1, failed: 0 });
    const row = store.rows[0];
    expect(row.apiId).toBe('a-1');
    expect(row.keyName).toBe('X-Key');
    expect(row.keyLocation).toBe('header');
    expect(isEncrypted(row.config.apiKey)).toBe(true);
    expect(api.authentication).toEqual({ type: 'api_key', config: { headerName: 'X-Key', location: 'header', credentialId: row.id } });
  });

  it('is idempotent: a second run moves nothing', async () => {
    const legacy = Object.assign(new LlmProvider(), { id: 'p-1', name: 'L', type: LlmProviderType.OPENAI, organizationId: 'org-1', configuration: { apiKey: encryptField('k') }, credentialId: null, usageCredentialId: null });
    const { service, store } = build({ providers: [legacy] });
    await service.run();
    const second = await service.run();
    expect(second.llmProviders).toEqual({ moved: 0, skipped: 1, failed: 0 });
    expect(store.rows).toHaveLength(1);
  });

  it('counts a failing row without stopping the run and never logs the value', async () => {
    const bad = Object.assign(new LlmProvider(), { id: 'p-bad', name: 'Bad', type: LlmProviderType.OPENAI, organizationId: 'org-1', configuration: { apiKey: 'encrypted:gcm:not:valid' }, credentialId: null, usageCredentialId: null });
    const good = Object.assign(new LlmProvider(), { id: 'p-ok', name: 'Ok', type: LlmProviderType.OPENAI, organizationId: 'org-1', configuration: { apiKey: encryptField('fine-secret') }, credentialId: null, usageCredentialId: null });
    const { service } = build({ providers: [bad, good] });
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);

    const report = await service.run();

    expect(report.llmProviders).toEqual({ moved: 1, skipped: 0, failed: 1 });
    const logged = [...warn.mock.calls, ...log.mock.calls].map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('fine-secret');
    expect(logged).toContain('moved=1');
  });

  it('does not run on bootstrap in the test environment or when switched off', () => {
    const { service } = build();
    const run = jest.spyOn(service, 'run');
    service.onApplicationBootstrap();
    expect(run).not.toHaveBeenCalled();
  });
});
