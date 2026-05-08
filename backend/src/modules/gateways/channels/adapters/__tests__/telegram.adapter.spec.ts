import { TelegramAdapter } from '../telegram.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

const tgUpdate = {
  update_id: 42,
  message: {
    message_id: 100,
    from: { id: 555, first_name: 'Alice', is_bot: false },
    chat: { id: 555, type: 'private' },
    date: 1700000000,
    text: '/start',
  },
};

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new TelegramAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts message text/from/chat', () => {
      const r = adapter.normalizeInbound(tgUpdate);
      expect(r.text).toBe('/start');
      expect(r.userId).toBe('555');
      expect(r.threadId).toBe('555');
      expect(r.metadata?.chatId).toBe(555);
      expect(r.metadata?.messageId).toBe(100);
    });
    it('handles raw message payload (no update wrapper)', () => {
      const r = adapter.normalizeInbound(tgUpdate.message);
      expect(r.text).toBe('/start');
    });
    it('defaults missing fields', () => {
      const r = adapter.normalizeInbound({});
      expect(r.text).toBe('');
      expect(r.userId).toBe('unknown');
    });
  });

  describe('formatOutbound', () => {
    it('produces {text} payload', () => {
      expect(adapter.formatOutbound({ text: 'reply' })).toEqual({ text: 'reply' });
    });
  });

  describe('sendResponse', () => {
    it('POSTs to bot{token}/sendMessage with chat_id', async () => {
      await adapter.sendResponse(
        { bot_token: '123:abc' },
        { text: 'hi' },
        { chatId: 555 },
      );
      expect(fetchMock.calls[0].url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
      expect(parseSentJson(fetchMock.calls[0])).toEqual({ chat_id: 555, text: 'hi' });
    });
    it('swallows errors', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('x'));
      await expect(adapter.sendResponse({ bot_token: 't' }, { text: 'x' }, { chatId: 1 })).resolves.toBeUndefined();
    });
  });
});
