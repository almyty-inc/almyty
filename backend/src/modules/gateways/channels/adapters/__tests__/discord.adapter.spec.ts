import { DiscordAdapter } from '../discord.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

const discordMessage = {
  id: '987654321',
  content: 'hi bot',
  author: { id: '111', username: 'alice', bot: false },
  channel_id: '222',
  guild_id: '333',
  timestamp: '2026-05-08T12:00:00Z',
};

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(() => { adapter = new DiscordAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts content/author/channel from a message', () => {
      const r = adapter.normalizeInbound(discordMessage);
      expect(r.text).toBe('hi bot');
      expect(r.userId).toBe('111');
      expect(r.threadId).toBe('222');
      expect(r.metadata?.guildId).toBe('333');
      expect(r.metadata?.source).toBe('discord');
    });
    it('defaults missing fields', () => {
      const r = adapter.normalizeInbound({});
      expect(r.text).toBe('');
      expect(r.userId).toBe('unknown');
    });
  });

  describe('formatOutbound', () => {
    it('produces {content} truncated to 2000 chars', () => {
      const long = 'x'.repeat(3000);
      const r = adapter.formatOutbound({ text: long });
      expect(r.content.length).toBe(2000);
    });
    it('passes short text through', () => {
      expect(adapter.formatOutbound({ text: 'hi' })).toEqual({ content: 'hi' });
    });
  });

  describe('sendResponse', () => {
    it('POSTs to /channels/:id/messages with Bot auth', async () => {
      await adapter.sendResponse(
        { bot_token: 'discord-token' },
        { content: 'reply' },
        { channelId: '222' },
      );
      expect(fetchMock.calls[0].url).toBe('https://discord.com/api/v10/channels/222/messages');
      expect(fetchMock.calls[0].init.headers['Authorization']).toBe('Bot discord-token');
      expect(parseSentJson(fetchMock.calls[0])).toEqual({ content: 'reply' });
    });

    it('swallows errors silently', async () => {
      (globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('boom'));
      await expect(adapter.sendResponse({ bot_token: 't' }, { content: 'x' }, { channelId: '1' })).resolves.toBeUndefined();
    });
  });
});
