import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { ApisService } from '../apis.service';
import { ApiKeyService } from '../api-key.service';
import { ApisCredentialsController } from '../apis-credentials.controller';
import { Api, ApiType } from '../../../entities/api.entity';
import { Credential, CredentialType } from '../../../entities/credential.entity';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { ToolAuthService } from '../../tools/services/tool-auth.service';
import { encryptField, isEncrypted } from '../../../common/security/field-crypto';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';

/**
 * The API page's one Key card. Pasting a key writes a Credential (the
 * single secret store) that the tool executor then sends; connecting an
 * account points the API at a connection instead. Real ApisService,
 * resolver and ToolAuthService over the truthful in-memory tables: the
 * assertion that matters is what an actual tool call puts on the wire.
 */
const ORG = 'org-1';

function setup() {
  const apis: FakeRepository<Api> = fakeRepository<Api>({ make: () => new Api(), idPrefix: 'api' });
  const credentials: FakeRepository<Credential> = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
  const envelope = makeEnvelopeCryptoMock();
  const resolver = new CredentialRefResolver(credentials as any, envelope);
  const accessPolicy = { assertCanScopeToTeam: jest.fn(), canAccess: jest.fn(async () => ({ allowed: true })) };
  const audit = { logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn() };
  const apisService = new ApisService(
    apis as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    audit as any, {} as any, {} as any, {} as any, accessPolicy as any, resolver,
  );
  const keys = new ApiKeyService(credentials as any, apisService, resolver);
  const toolAuth = new ToolAuthService(credentials as any, { get: jest.fn() } as any, envelope, resolver);

  apis.seed({
    id: 'pets',
    organizationId: ORG,
    name: 'Petstore',
    type: ApiType.OPENAPI,
    baseUrl: 'https://petstore.example.com/v2',
    visibility: 'org',
    authentication: { type: 'api_key', config: { headerName: 'X-Pets-Key', location: 'header' } },
  } as any);

  /** What a tool call to the API sends, the way the executor builds it. */
  const sent = async () => {
    const config: any = { headers: {} };
    await toolAuth.applyApiAuth(config, apis.row('pets')!, { organizationId: ORG, userId: 'user-1' } as any);
    return { headers: config.headers, params: config.params };
  };
  const active = () => credentials.rows().filter((c) => c.apiId === 'pets' && c.isActive);
  return { apis, credentials, keys, sent, active };
}

describe('the API key', () => {
  it('pasting a key stores it as a Credential for the API, never on the API row, and tool calls send it', async () => {
    const { apis, keys, sent, active } = setup();

    const view = await keys.set('pets', ORG, 'user-1', { key: 'pk-live-1' });

    const [row] = active();
    expect(row).toMatchObject({ apiId: 'pets', organizationId: ORG, type: CredentialType.API_KEY, keyName: 'X-Pets-Key', keyLocation: 'header' });
    expect(isEncrypted(row.config.apiKey)).toBe(true);
    expect(JSON.stringify(apis.row('pets'))).not.toContain('pk-live-1');
    expect(apis.row('pets')!.authentication).toEqual({
      type: 'api_key',
      config: { headerName: 'X-Pets-Key', location: 'header', credentialId: row.id },
    });
    expect(view).toMatchObject({ type: 'api_key', headerName: 'X-Pets-Key', location: 'header', source: 'key', credential: { id: row.id } });
    expect(JSON.stringify(view)).not.toContain('pk-live-1');
    expect((await sent()).headers).toEqual({ 'X-Pets-Key': 'pk-live-1' });
  });

  it('replacing the key rotates the same Credential, and a renamed header is kept on it', async () => {
    const { keys, sent, active } = setup();
    await keys.set('pets', ORG, 'user-1', { key: 'pk-1' });
    const first = active()[0].id;

    await keys.set('pets', ORG, 'user-1', { key: 'pk-2', headerName: 'X-Api-Token', location: 'query' });

    expect(active().map((c) => c.id)).toEqual([first]);
    expect(active()[0]).toMatchObject({ keyName: 'X-Api-Token', keyLocation: 'query' });
    expect(await sent()).toEqual({ headers: {}, params: { 'X-Api-Token': 'pk-2' } });
  });

  it('one key per API: an older upstream credential stops being used once a key is pasted', async () => {
    const { credentials, keys, sent, active } = setup();
    // What the old "Upstream credentials" card left behind, newer than anything else.
    credentials.seed({
      id: 'old-upstream', organizationId: ORG, apiId: 'pets', name: 'Old key', type: CredentialType.BEARER_TOKEN,
      config: { token: encryptField('old-token') }, isActive: true, createdAt: new Date('2030-01-01'),
    } as any);
    expect((await sent()).headers).toEqual({ Authorization: 'Bearer old-token' });

    await keys.set('pets', ORG, 'user-1', { key: 'pk-new' });

    expect(active()).toHaveLength(1);
    expect(credentials.row('old-upstream')!.isActive).toBe(false);
    expect((await sent()).headers).toEqual({ 'X-Pets-Key': 'pk-new' });
  });

  it('connecting an account points the API at the connection, drops the pasted key, and calls send the connection\'s key', async () => {
    const { apis, credentials, keys, sent, active } = setup();
    await keys.set('pets', ORG, 'user-1', { key: 'pk-pasted' });
    credentials.seed({
      id: 'conn-1', organizationId: ORG, name: 'Petstore account', type: CredentialType.API_KEY, connectorKey: 'toolsource-openapi',
      accountLabel: 'ops@example.com', config: { apiKey: encryptField('pk-from-connection') }, isActive: true, visibility: 'org',
    } as any);

    const view = await keys.set('pets', ORG, 'user-1', { connectionId: 'conn-1' });

    expect(apis.row('pets')!.authentication).toEqual({
      type: 'api_key',
      config: { headerName: 'X-Pets-Key', location: 'header', connectionId: 'conn-1' },
    });
    expect(active()).toHaveLength(0);
    expect(view).toMatchObject({ source: 'connection', connection: { id: 'conn-1', name: 'Petstore account', accountLabel: 'ops@example.com' }, credential: null });
    expect((await sent()).headers).toEqual({ 'X-Pets-Key': 'pk-from-connection' });
  });

  it('refuses a connection with no key to send, and one of another organization', async () => {
    const { credentials, keys } = setup();
    credentials.seed({ id: 'no-key', organizationId: ORG, name: 'Bucket', type: CredentialType.CUSTOM, connectorKey: 's3', config: { region: 'eu' }, isActive: true, visibility: 'org' } as any);
    credentials.seed({ id: 'theirs', organizationId: 'org-2', name: 'Theirs', type: CredentialType.API_KEY, connectorKey: 'x', config: { apiKey: encryptField('k') }, isActive: true, visibility: 'org' } as any);

    await expect(keys.set('pets', ORG, 'user-1', { connectionId: 'no-key' })).rejects.toThrow("This account has no key almyty can send");
    await expect(keys.set('pets', ORG, 'user-1', { connectionId: 'theirs' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removing the key stops sending one and keeps how it would be sent', async () => {
    const { apis, keys, sent, active } = setup();
    await keys.set('pets', ORG, 'user-1', { key: 'pk-1' });

    const view = await keys.remove('pets', ORG, 'user-1');

    expect(active()).toHaveLength(0);
    expect(apis.row('pets')!.authentication).toEqual({ type: 'api_key', config: { headerName: 'X-Pets-Key', location: 'header' } });
    expect(view).toMatchObject({ type: 'api_key', headerName: 'X-Pets-Key', source: null });
    expect((await sent()).headers).toEqual({});
  });

  it('asks for the username with a basic-auth password', async () => {
    const { keys, sent } = setup();
    await expect(keys.set('pets', ORG, 'user-1', { type: 'basic', key: 'pw' })).rejects.toBeInstanceOf(BadRequestException);
    await keys.set('pets', ORG, 'user-1', { type: 'basic', username: 'ada', key: 'pw' });
    expect((await sent()).headers).toEqual({ Authorization: `Basic ${Buffer.from('ada:pw').toString('base64')}` });
  });

  it('does not reach an API of another organization', async () => {
    const { keys } = setup();
    await expect(keys.get('pets', 'org-2', { id: 'user-1' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(keys.set('pets', 'org-2', 'user-1', { key: 'k' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('members can see it; only admins and owners change it', () => {
    const roles = (m: keyof ApisCredentialsController) => Reflect.getMetadata(ROLES_KEY, ApisCredentialsController.prototype[m]);
    expect(roles('getKey')).toEqual(['member', 'admin', 'owner']);
    expect(roles('setKey')).toEqual(['admin', 'owner']);
    expect(roles('removeKey')).toEqual(['admin', 'owner']);
  });
});
