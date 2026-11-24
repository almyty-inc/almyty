import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';

import { ApisService } from '../apis.service';
import { ApiKeyService } from '../api-key.service';
import { Api, ApiType } from '../../../entities/api.entity';
import { Credential, CredentialType } from '../../../entities/credential.entity';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { OAuth2Service } from '../../credentials/oauth2.service';
import { OAuth2Controller } from '../../credentials/oauth2.controller';
import { missingScopes, scopeUnion } from '../../credentials/oauth2-scopes';
import { ToolAuthService } from '../../tools/services/tool-auth.service';
import { decryptField } from '../../../common/security/field-crypto';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { FakeRedis } from '../../../test/fake-redis';

/**
 * One Google account, three APIs imported from Google's discovery
 * documents (Calendar, Gmail, Tasks), one OAuth client. Each API used to
 * get a sign-in of its own, so the person consented three times. Now the
 * second API reuses the first sign-in when it covers it, and otherwise
 * adds its access to that same sign-in with an incremental consent
 * (include_granted_scopes) on the same OAuth client.
 *
 * Real ApiKeyService, OAuth2Service, resolver and ToolAuthService over the
 * in-memory tables; only Google's token endpoint is faked.
 */
const ORG = 'org-northwind';
const USER = 'user-ava';
const G = 'https://www.googleapis.com/auth/';
const CALENDAR = [`${G}calendar.readonly`, `${G}calendar.events.readonly`];
const GMAIL = [`${G}gmail.readonly`];
const TASKS = [`${G}tasks.readonly`];

function googleApi(id: string, name: string, scopes: string[]) {
  return {
    id,
    organizationId: ORG,
    name,
    type: ApiType.OPENAPI,
    baseUrl: 'https://www.googleapis.com',
    visibility: 'org',
    authentication: {
      type: 'oauth2',
      config: { flow: 'authorizationCode', authUrl: 'https://accounts.google.com/o/oauth2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes },
    },
  } as any;
}

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
  const oauth2 = new OAuth2Service(credentials as any, new FakeRedis() as any, envelope);
  const keys = new ApiKeyService(credentials as any, apisService, resolver, oauth2);
  keys.onModuleInit();
  const toolAuth = new ToolAuthService(credentials as any, { get: jest.fn() } as any, envelope, resolver);

  apis.seed(googleApi('calendar', 'Google Calendar', CALENDAR));
  apis.seed(googleApi('gmail', 'Gmail', GMAIL));
  apis.seed(googleApi('tasks', 'Google Tasks', TASKS));
  apis.seed(googleApi('calendar-lite', 'Calendar (read events)', [`${G}calendar.readonly`]));

  /** The Authorization header a tool call to `apiId` sends. */
  const sent = async (apiId: string) => {
    const config: any = { headers: {} };
    await toolAuth.applyApiAuth(config, apis.row(apiId)!, { organizationId: ORG, userId: USER } as any);
    return config.headers.Authorization;
  };
  const signIns = () => credentials.rows().filter((c) => c.type === CredentialType.OAUTH2);
  return { apis, credentials, keys, oauth2, sent, signIns };
}

describe('one Google sign-in for several Google APIs', () => {
  const originalFetch = global.fetch;
  let tokenAnswers: Array<Record<string, any>>;
  let exchanges: URLSearchParams[];

  beforeEach(() => {
    tokenAnswers = [];
    exchanges = [];
    global.fetch = jest.fn(async (_url: any, init: any) => {
      exchanges.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify(tokenAnswers.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  /** Ava signs in on the Calendar API's page, as before. */
  async function signInOnCalendar(world: ReturnType<typeof setup>) {
    const { state } = await world.oauth2.generateAuthorizationUrl({
      organizationId: ORG, userId: USER, apiId: 'calendar', clientId: 'northwind-client', clientSecret: 'northwind-secret',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: CALENDAR, credentialName: 'Google Calendar sign-in',
    });
    tokenAnswers.push({ access_token: 'at-calendar', refresh_token: 'rt-1', expires_in: 3600, scope: CALENDAR.join(' '), token_type: 'Bearer' });
    const { credentialId } = await world.oauth2.handleCallback('code-1', state);
    return credentialId;
  }

  it('offers the existing sign-in to the other APIs and says which scopes each one still needs', async () => {
    const world = setup();
    const id = await signInOnCalendar(world);

    expect(await world.keys.sharedSignIns('calendar', ORG, USER)).toEqual([]); // its own sign-in is not "another"
    expect(await world.keys.sharedSignIns('gmail', ORG, USER)).toEqual([
      expect.objectContaining({ id, name: 'Google Calendar sign-in', grantedScopes: CALENDAR, missingScopes: GMAIL, canAddAccess: true }),
    ]);
    expect(await world.keys.sharedSignIns('calendar-lite', ORG, USER)).toEqual([expect.objectContaining({ id, missingScopes: [] })]);
    // Never a secret in what the page gets.
    expect(JSON.stringify(await world.keys.sharedSignIns('gmail', ORG, USER))).not.toMatch(/at-calendar|rt-1|northwind-secret/);
  });

  it('an API the sign-in already covers just uses it: no consent, and calls send its token', async () => {
    const world = setup();
    const id = await signInOnCalendar(world);

    const result = await world.keys.useSharedSignIn('calendar-lite', ORG, USER, id);

    expect(result.authorizationUrl).toBeNull();
    expect(result.key).toMatchObject({ source: 'connection', connection: { id } });
    expect(world.signIns()).toHaveLength(1);
    expect(await world.sent('calendar-lite')).toBe('Bearer at-calendar');
    expect(await world.sent('calendar')).toBe('Bearer at-calendar');
  });

  it('missing scopes start an incremental consent on the same sign-in and client, asking for the union', async () => {
    const world = setup();
    const id = await signInOnCalendar(world);

    const { key, authorizationUrl } = await world.keys.useSharedSignIn('gmail', ORG, USER, id, { returnTo: '/apis/gmail' });

    expect(key).toBeNull();
    const url = new URL(authorizationUrl!);
    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('client_id')).toBe('northwind-client');
    expect(url.searchParams.get('scope')!.split(' ')).toEqual([...CALENDAR, ...GMAIL]);
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('the consent stores the new token on the existing sign-in, keeps its refresh token, and points both APIs at it', async () => {
    const world = setup();
    const id = await signInOnCalendar(world);
    const { authorizationUrl } = await world.keys.useSharedSignIn('gmail', ORG, USER, id, { returnTo: '/apis/gmail' });
    const state = new URL(authorizationUrl!).searchParams.get('state')!;

    // Google answers an incremental consent with every scope the grant now holds, and often no new refresh token.
    tokenAnswers.push({ access_token: 'at-combined', expires_in: 3600, scope: [...CALENDAR, ...GMAIL].join(' '), token_type: 'Bearer' });
    const result = await world.oauth2.handleCallback('code-2', state);

    expect(result).toEqual({ credentialId: id, returnTo: '/apis/gmail' });
    expect(exchanges[1].get('client_id')).toBe('northwind-client');
    expect(world.signIns()).toHaveLength(1); // no second credential
    const row = world.credentials.row(id)!;
    expect(decryptField(row.config.accessToken)).toBe('at-combined');
    expect(decryptField(row.config.refreshToken)).toBe('rt-1');
    expect(row.config.accessToken).not.toBe('at-combined'); // still encrypted at rest
    expect(row.scopesGranted).toEqual([...CALENDAR, ...GMAIL]);

    expect(world.apis.row('gmail')!.authentication!.config.connectionId).toBe(id);
    // Calendar now points at the sign-in instead of owning it, so changing one API's key cannot switch the other's off.
    expect(world.apis.row('calendar')!.authentication!.config.connectionId).toBe(id);
    expect(row.apiId).toBeNull();
    expect(await world.sent('gmail')).toBe('Bearer at-combined');
    expect(await world.sent('calendar')).toBe('Bearer at-combined');

    await world.keys.remove('gmail', ORG, USER);
    expect(world.credentials.row(id)!.isActive).toBe(true);
    expect(await world.sent('calendar')).toBe('Bearer at-combined');

    // Tasks is then one more incremental consent on the same sign-in.
    const tasks = await world.keys.useSharedSignIn('tasks', ORG, USER, id);
    expect(new URL(tasks.authorizationUrl!).searchParams.get('scope')!.split(' ')).toEqual([...CALENDAR, ...GMAIL, ...TASKS]);
  });

  it('keeps read-only scopes read-only: never asks for a wider scope, nor one the API does not list', async () => {
    const world = setup();
    const id = await signInOnCalendar(world);

    await expect(world.keys.useSharedSignIn('gmail', ORG, USER, id, { scopes: [`${G}gmail.modify`] })).rejects.toBeInstanceOf(BadRequestException);

    const { authorizationUrl } = await world.keys.useSharedSignIn('gmail', ORG, USER, id);
    const asked = new URL(authorizationUrl!).searchParams.get('scope')!.split(' ');
    expect(asked).toEqual([...CALENDAR, ...GMAIL]);
    expect(asked.every((s) => s.endsWith('.readonly'))).toBe(true);
    expect(asked).not.toContain(`${G}gmail.modify`);
    expect(asked).not.toContain(`${G}calendar`);

    // The arithmetic itself: exact strings, never rewritten.
    expect(missingScopes([`${G}gmail.modify`], GMAIL)).toEqual(GMAIL);
    expect(scopeUnion(GMAIL, GMAIL)).toEqual(GMAIL);
  });

  it('the public authorize route cannot aim a consent at an existing sign-in', async () => {
    const world = setup();
    const id = await signInOnCalendar(world);
    const controller = new OAuth2Controller(world.oauth2);

    const res = await controller.authorize(
      {
        extendCredentialId: id, clientId: 'northwind-client', clientSecret: 'someone-elses-secret',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: GMAIL,
      },
      { user: { currentOrganizationId: ORG, id: 'user-mallory' } },
    );
    expect(new URL(res.data.authorizationUrl).searchParams.has('include_granted_scopes')).toBe(false);
    tokenAnswers.push({ access_token: 'at-mallory', refresh_token: 'rt-m', expires_in: 3600, scope: GMAIL.join(' ') });
    const made = await world.oauth2.handleCallback('code-3', res.data.state);

    expect(made.credentialId).not.toBe(id);
    expect(decryptField(world.credentials.row(id)!.config.accessToken)).toBe('at-calendar');
  });

  it('a sign-in whose access token expired still resolves, and the call sends the renewed token', async () => {
    const world = setup();
    const id = await signInOnCalendar(world);
    await world.keys.useSharedSignIn('calendar-lite', ORG, USER, id);
    await world.credentials.update({ id } as any, { expiresAt: new Date(Date.now() - 60_000) } as any);

    const refreshed = { ...world.credentials.row(id)!, config: { ...world.credentials.row(id)!.config }, expiresAt: new Date(Date.now() + 3600_000) };
    const credService = { refreshOAuthToken: jest.fn(async () => Object.assign(new Credential(), refreshed, { config: { ...refreshed.config, accessToken: 'at-renewed' } })) };
    const toolAuth = new ToolAuthService(world.credentials as any, { get: jest.fn(() => credService) } as any, makeEnvelopeCryptoMock(), new CredentialRefResolver(world.credentials as any, makeEnvelopeCryptoMock()));
    const config: any = { headers: {} };
    await toolAuth.applyApiAuth(config, world.apis.row('calendar-lite')!, { organizationId: ORG, userId: USER } as any);

    expect(credService.refreshOAuthToken).toHaveBeenCalled();
    expect(config.headers.Authorization).toBe('Bearer at-renewed');
  });
});
