import { MicrosoftTeamsAdapter } from '../microsoft-teams.adapter';
import { installFetchMock, parseSentJson, parseSentForm } from './test-helpers';

const teamsActivity = {
  id: 'a1',
  text: 'hi bot',
  from: { id: '29:user-aad', aadObjectId: 'user-aad' },
  conversation: { id: 'a:conv1' },
  channelId: 'msteams',
  serviceUrl: 'https://smba.trafficmanager.net/teams/',
  channelData: { tenant: { id: 'tenant-1' } },
};

describe('MicrosoftTeamsAdapter', () => {
  let adapter: MicrosoftTeamsAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new MicrosoftTeamsAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts text/from/conversation/serviceUrl from a Bot Framework activity', () => {
      const r = adapter.normalizeInbound(teamsActivity);
      expect(r.text).toBe('hi bot');
      expect(r.userId).toBe('29:user-aad');
      expect(r.threadId).toBe('a:conv1');
      expect(r.metadata?.serviceUrl).toBe('https://smba.trafficmanager.net/teams/');
      expect(r.metadata?.tenantId).toBe('tenant-1');
      expect(r.metadata?.source).toBe('microsoft_teams');
    });
    it('falls back to aadObjectId when from.id is absent', () => {
      const r = adapter.normalizeInbound({ ...teamsActivity, from: { aadObjectId: 'aad-only' } });
      expect(r.userId).toBe('aad-only');
    });
  });

  describe('formatOutbound', () => {
    it('produces a Bot Framework message activity', () => {
      expect(adapter.formatOutbound({ text: 'reply' })).toEqual({ type: 'message', text: 'reply' });
    });
  });

  describe('sendResponse', () => {
    it('exchanges bot creds for an access token then POSTs to the conversation', async () => {
      // Token endpoint responds with access_token, then conversation activity POST
      fetchMock.setNextResponse({ json: { access_token: 'tok-123' } });
      let callIndex = 0;
      const original = (globalThis as any).fetch;
      (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
        const captured = { url, init };
        fetchMock.calls.push(captured);
        callIndex++;
        if (callIndex === 1) {
          return { ok: true, status: 200, json: async () => ({ access_token: 'tok-123' }), text: async () => '' };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      });

      await adapter.sendResponse(
        { bot_id: 'app-id', bot_password: 'app-secret' },
        { type: 'message', text: 'reply' },
        { metadata: { serviceUrl: 'https://smba.trafficmanager.net/teams/', conversationId: 'a:conv1' } },
      );

      expect(fetchMock.calls.length).toBe(2);
      expect(fetchMock.calls[0].url).toContain('login.microsoftonline.com');
      const tokenForm = parseSentForm(fetchMock.calls[0]);
      expect(tokenForm.client_id).toBe('app-id');
      expect(tokenForm.client_secret).toBe('app-secret');
      expect(tokenForm.grant_type).toBe('client_credentials');

      expect(fetchMock.calls[1].url).toBe('https://smba.trafficmanager.net/teams//v3/conversations/a:conv1/activities');
      expect(fetchMock.calls[1].init.headers['Authorization']).toBe('Bearer tok-123');
      expect(parseSentJson(fetchMock.calls[1])).toEqual({ type: 'message', text: 'reply' });

      (globalThis as any).fetch = original;
    });

    it('returns silently when serviceUrl/conversationId missing', async () => {
      await adapter.sendResponse({ bot_id: 'a', bot_password: 'b' }, { type: 'message', text: 'x' }, {});
      expect(fetchMock.calls.length).toBe(0);
    });
  });

  describe('verifyWebhook (Bot Framework JWT)', () => {
    const crypto = require('crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const KID = 'test-key-1';
    const BOT_ID = 'bot-app-id';
    const config = { bot_id: BOT_ID };

    const b64url = (obj: any) => Buffer.from(JSON.stringify(obj)).toString('base64url');

    const makeJwt = (
      claimOverrides: Record<string, any> = {},
      headerOverrides: Record<string, any> = {},
      signKey: any = privateKey,
    ) => {
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: 'RS256', typ: 'JWT', kid: KID, ...headerOverrides };
      const claims = {
        iss: 'https://api.botframework.com',
        aud: BOT_ID,
        exp: now + 3600,
        nbf: now - 60,
        serviceurl: 'https://smba.trafficmanager.net/teams/',
        ...claimOverrides,
      };
      const signingInput = `${b64url(header)}.${b64url(claims)}`;
      const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), signKey);
      return `${signingInput}.${signature.toString('base64url')}`;
    };

    /** fetch mock serving the OpenID metadata + JWKS documents. */
    const installJwksFetch = () => {
      const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };
      const fetchSpy = jest.fn(async (url: string) => {
        if (String(url).includes('openidconfiguration')) {
          return { ok: true, status: 200, json: async () => ({ jwks_uri: 'https://login.botframework.com/v1/.well-known/keys' }) };
        }
        if (String(url).includes('keys')) {
          return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      (globalThis as any).fetch = fetchSpy;
      return fetchSpy;
    };

    it('accepts a valid Bot Framework JWT', async () => {
      installJwksFetch();
      const ok = await adapter.verifyWebhook(teamsActivity, { authorization: `Bearer ${makeJwt()}` }, config);
      expect(ok).toBe(true);
    });

    it('caches the JWKS across verifications (metadata fetched once)', async () => {
      const fetchSpy = installJwksFetch();
      await adapter.verifyWebhook(teamsActivity, { authorization: `Bearer ${makeJwt()}` }, config);
      await adapter.verifyWebhook(teamsActivity, { authorization: `Bearer ${makeJwt()}` }, config);
      // one openidconfiguration fetch + one jwks fetch, total 2
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('rejects a JWT signed by a different key', async () => {
      installJwksFetch();
      const jwt = makeJwt({}, {}, otherPair.privateKey);
      expect(await adapter.verifyWebhook(teamsActivity, { authorization: `Bearer ${jwt}` }, config)).toBe(false);
    });

    it('rejects a wrong audience', async () => {
      installJwksFetch();
      const jwt = makeJwt({ aud: 'someone-else' });
      expect(await adapter.verifyWebhook(teamsActivity, { authorization: `Bearer ${jwt}` }, config)).toBe(false);
    });

    it('rejects a wrong issuer', async () => {
      installJwksFetch();
      const jwt = makeJwt({ iss: 'https://evil.example.com' });
      expect(await adapter.verifyWebhook(teamsActivity, { authorization: `Bearer ${jwt}` }, config)).toBe(false);
    });

    it('rejects an expired token (beyond skew)', async () => {
      installJwksFetch();
      const now = Math.floor(Date.now() / 1000);
      const jwt = makeJwt({ exp: now - 3600 });
      expect(await adapter.verifyWebhook(teamsActivity, { authorization: `Bearer ${jwt}` }, config)).toBe(false);
    });

    it('rejects a non-RS256 alg (alg=none downgrade)', async () => {
      installJwksFetch();
      const header = { alg: 'none', typ: 'JWT', kid: KID };
      const claims = { iss: 'https://api.botframework.com', aud: BOT_ID, exp: Math.floor(Date.now() / 1000) + 3600 };
      const jwt = `${b64url(header)}.${b64url(claims)}.`;
      expect(await adapter.verifyWebhook(teamsActivity, { authorization: `Bearer ${jwt}` }, config)).toBe(false);
    });

    it('rejects an unknown kid', async () => {
      installJwksFetch();
      const jwt = makeJwt({}, { kid: 'rotated-away' });
      expect(await adapter.verifyWebhook(teamsActivity, { authorization: `Bearer ${jwt}` }, config)).toBe(false);
    });

    it('rejects a missing/malformed Authorization header', async () => {
      installJwksFetch();
      expect(await adapter.verifyWebhook(teamsActivity, {}, config)).toBe(false);
      expect(await adapter.verifyWebhook(teamsActivity, { authorization: 'Basic abc' }, config)).toBe(false);
      expect(await adapter.verifyWebhook(teamsActivity, { authorization: 'Bearer not-a-jwt' }, config)).toBe(false);
    });

    it('skips verification when bot_id is not configured', async () => {
      const fetchSpy = installJwksFetch();
      expect(await adapter.verifyWebhook(teamsActivity, {}, {})).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
