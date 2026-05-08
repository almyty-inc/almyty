import { ChatWidgetAdapter } from '../chat-widget.adapter';

describe('ChatWidgetAdapter', () => {
  const adapter = new ChatWidgetAdapter();

  describe('normalizeInbound', () => {
    it('extracts message/userId/sessionId', () => {
      const r = adapter.normalizeInbound({ message: 'hi', userId: 'u1', sessionId: 's1' });
      expect(r.text).toBe('hi');
      expect(r.userId).toBe('u1');
      expect(r.threadId).toBe('s1');
      expect(r.metadata?.source).toBe('chat_widget');
    });
    it('falls back to text key + sessionId-as-userId for anonymous', () => {
      const r = adapter.normalizeInbound({ text: 'hello', sessionId: 'anon-1' });
      expect(r.userId).toBe('anon-1');
      expect(r.threadId).toBe('anon-1');
    });
    it('defaults userId to "anonymous" when neither present', () => {
      const r = adapter.normalizeInbound({});
      expect(r.userId).toBe('anonymous');
    });
  });

  describe('formatOutbound', () => {
    it('produces {message, attachments}', () => {
      expect(adapter.formatOutbound({ text: 'reply' })).toEqual({ message: 'reply', attachments: undefined });
    });
    it('preserves attachments', () => {
      const r = adapter.formatOutbound({ text: 'r', attachments: [{ url: 'u', type: 't', name: 'n' }] });
      expect(r.attachments).toEqual([{ url: 'u', type: 't', name: 'n' }]);
    });
  });

  describe('sendResponse', () => {
    it('is a no-op (widget polls / SSE — no push)', async () => {
      // Should resolve cleanly without making any external call.
      await expect(adapter.sendResponse({}, { message: 'r' }, {})).resolves.toBeUndefined();
    });
  });
});
