import { GoogleChatAdapter } from '../google-chat.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

const gchatEvent = {
  type: 'MESSAGE',
  message: {
    name: 'spaces/AAA/messages/BBB',
    text: 'hello',
    sender: { name: 'users/123', displayName: 'Alice' },
    thread: { name: 'spaces/AAA/threads/T1' },
  },
  space: { name: 'spaces/AAA', displayName: 'Eng' },
};

describe('GoogleChatAdapter', () => {
  let adapter: GoogleChatAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new GoogleChatAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts text/sender/thread/space from MESSAGE event', () => {
      const r = adapter.normalizeInbound(gchatEvent);
      expect(r.text).toBe('hello');
      expect(r.userId).toBe('users/123');
      expect(r.threadId).toBe('spaces/AAA/threads/T1');
      expect(r.metadata?.spaceId).toBe('spaces/AAA');
      expect(r.metadata?.spaceName).toBe('Eng');
      expect(r.metadata?.source).toBe('google_chat');
    });
    it('handles raw message payload', () => {
      const r = adapter.normalizeInbound(gchatEvent.message);
      expect(r.text).toBe('hello');
    });
  });

  describe('formatOutbound', () => {
    it('produces {text} payload', () => {
      expect(adapter.formatOutbound({ text: 'r' })).toEqual({ text: 'r' });
    });
  });

  describe('verifyWebhook', () => {
    it('refuses inbound when no verification_token is configured', async () => {
      expect(await adapter.verifyWebhook({}, {}, {})).toBe(false);
    });
    it('accepts matching bearer token', async () => {
      expect(await adapter.verifyWebhook({}, { authorization: 'Bearer abc' }, { verification_token: 'abc' })).toBe(true);
    });
    it('rejects mismatched bearer token', async () => {
      expect(await adapter.verifyWebhook({}, { authorization: 'Bearer wrong' }, { verification_token: 'abc' })).toBe(false);
    });
  });

  describe('sendResponse', () => {
    it('POSTs to incoming-webhook URL with thread', async () => {
      await adapter.sendResponse(
        { webhook_url: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=K&token=T' },
        { text: 'reply' },
        { threadId: 'spaces/AAA/threads/T1' },
      );
      expect(fetchMock.calls[0].url).toContain('chat.googleapis.com');
      expect(parseSentJson(fetchMock.calls[0])).toEqual({
        text: 'reply',
        thread: { name: 'spaces/AAA/threads/T1' },
      });
    });
    it('refuses rather than skipping when webhook_url is missing', async () => {
      await expect(adapter.sendResponse({}, { text: 'r' }, {})).rejects.toThrow(
        /webhook_url is not configured/,
      );
      expect(fetchMock.calls.length).toBe(0);
    });

    /**
     * Google Chat refuses with a status and `{error: {message, status}}`
     * — a deleted space, a revoked webhook, a thread name from another
     * space. Discarding it filed each as a delivered reply.
     */
    it('refuses a space-webhook rejection and keeps Google\'s message and status', async () => {
      fetchMock.setNextResponse({
        ok: false,
        status: 404,
        json: { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } },
      });
      await expect(
        adapter.sendResponse({ webhook_url: 'https://chat.googleapis.com/v1/spaces/AAA/messages' }, { text: 'r' }, {}),
      ).rejects.toThrow(/Requested entity was not found.*NOT_FOUND/);
    });

    it('does not swallow a network failure', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('offline'));
      await expect(
        adapter.sendResponse({ webhook_url: 'https://chat.googleapis.com/v1/spaces/AAA/messages' }, { text: 'r' }, {}),
      ).rejects.toThrow('offline');
    });
  });
});
