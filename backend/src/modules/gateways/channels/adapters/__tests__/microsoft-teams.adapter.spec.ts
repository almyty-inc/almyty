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
});
