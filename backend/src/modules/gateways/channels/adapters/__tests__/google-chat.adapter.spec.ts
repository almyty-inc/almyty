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
    it('returns true when no verification_token configured', async () => {
      expect(await adapter.verifyWebhook({}, {}, {})).toBe(true);
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
    it('skips when webhook_url missing', async () => {
      await adapter.sendResponse({}, { text: 'r' }, {});
      expect(fetchMock.calls.length).toBe(0);
    });
  });
});
