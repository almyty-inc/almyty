import { ChatWidgetAdapter } from '../chat-widget.adapter';

describe('ChatWidgetAdapter', () => {
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let adapter: ChatWidgetAdapter;

  beforeEach(() => {
    eventRepository = {
      create: jest.fn((v) => v),
      save: jest.fn(async (v) => ({ id: 'evt-1', ...v })),
    };
    adapter = new ChatWidgetAdapter(eventRepository as any);
  });

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
    const threadContext = {
      threadId: 'thread-1',
      gatewayId: 'gw-1',
      organizationId: 'org-1',
      runId: 'run-1',
    };

    it('persists the reply as an outbound widget_message channel event', async () => {
      await adapter.sendResponse({}, { message: 'reply', attachments: undefined }, threadContext);
      expect(eventRepository.save).toHaveBeenCalledTimes(1);
      const saved = eventRepository.save.mock.calls[0][0];
      expect(saved).toEqual({
        organizationId: 'org-1',
        gatewayId: 'gw-1',
        channelType: 'chat_widget',
        direction: 'outbound',
        status: 'processed',
        payload: {
          kind: 'widget_message',
          threadId: 'thread-1',
          message: 'reply',
          attachments: null,
        },
        runId: 'run-1',
      });
    });

    it('persists attachments when present', async () => {
      await adapter.sendResponse(
        {},
        { message: 'r', attachments: [{ url: 'u', type: 't', name: 'n' }] },
        threadContext,
      );
      const saved = eventRepository.save.mock.calls[0][0];
      expect(saved.payload.attachments).toEqual([{ url: 'u', type: 't', name: 'n' }]);
    });

    it('drops (does not persist, does not throw) without gateway/thread context', async () => {
      await expect(adapter.sendResponse({}, { message: 'r' }, {})).resolves.toBeUndefined();
      await expect(adapter.sendResponse({}, { message: 'r' }, { threadId: 't' })).resolves.toBeUndefined();
      expect(eventRepository.save).not.toHaveBeenCalled();
    });
  });
});