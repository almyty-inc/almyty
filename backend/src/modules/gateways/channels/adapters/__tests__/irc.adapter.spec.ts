import { IrcAdapter } from '../irc.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

describe('IrcAdapter', () => {
  let adapter: IrcAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new IrcAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts text/nick/channel from a webhook bridge payload', () => {
      const r = adapter.normalizeInbound({
        text: 'hello',
        nick: 'alice',
        channel: '#general',
        server: 'irc.example.com',
      });
      expect(r.text).toBe('hello');
      expect(r.userId).toBe('alice');
      expect(r.threadId).toBe('#general');
      expect(r.metadata?.server).toBe('irc.example.com');
      expect(r.metadata?.source).toBe('irc');
    });
    it('falls back to message/from/username keys', () => {
      const r = adapter.normalizeInbound({ message: 'hi', username: 'bob' });
      expect(r.text).toBe('hi');
      expect(r.userId).toBe('bob');
    });
  });

  describe('formatOutbound', () => {
    it('produces {text}', () => {
      expect(adapter.formatOutbound({ text: 'r' })).toEqual({ text: 'r' });
    });
  });

  describe('sendResponse', () => {
    it('POSTs to the configured webhook bridge URL', async () => {
      await adapter.sendResponse(
        { webhook_url: 'https://bridge.example/webhook', nick: 'almytybot' },
        { text: 'reply' },
        { threadId: '#dev' },
      );
      expect(fetchMock.calls[0].url).toBe('https://bridge.example/webhook');
      expect(parseSentJson(fetchMock.calls[0])).toEqual({
        text: 'reply',
        channel: '#dev',
        username: 'almytybot',
      });
    });
    it('falls back to config.channel when threadId missing', async () => {
      await adapter.sendResponse(
        { webhook_url: 'https://bridge.example/webhook', channel: '#fallback' },
        { text: 'r' },
        {},
      );
      expect(parseSentJson(fetchMock.calls[0]).channel).toBe('#fallback');
    });
    it('skips when webhook_url missing', async () => {
      await adapter.sendResponse({}, { text: 'r' }, { threadId: '#x' });
      expect(fetchMock.calls.length).toBe(0);
    });
  });
});
