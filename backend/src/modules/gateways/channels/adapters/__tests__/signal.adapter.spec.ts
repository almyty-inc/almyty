import { SignalAdapter } from '../signal.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

const signalEnvelope = {
  envelope: {
    source: '+15551234567',
    sourceNumber: '+15551234567',
    timestamp: 1700000000000,
    dataMessage: { message: 'hi bot', timestamp: 1700000000000 },
  },
};

describe('SignalAdapter', () => {
  let adapter: SignalAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new SignalAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts source/message/timestamp from a 1-on-1 envelope', () => {
      const r = adapter.normalizeInbound(signalEnvelope);
      expect(r.text).toBe('hi bot');
      expect(r.userId).toBe('+15551234567');
      expect(r.threadId).toBe('+15551234567');
      expect(r.metadata?.source).toBe('signal');
    });
    it('uses groupId as threadId when present', () => {
      const grp = {
        envelope: { source: '+1', sourceNumber: '+1', dataMessage: { message: 'gm', groupInfo: { groupId: 'GRP1' } } },
      };
      const r = adapter.normalizeInbound(grp);
      expect(r.threadId).toBe('GRP1');
      expect(r.metadata?.groupId).toBe('GRP1');
    });
    it('reads syncMessage.sentMessage (linked-device / note-to-self)', () => {
      const sync = {
        envelope: {
          source: '+1', sourceNumber: '+1',
          syncMessage: { sentMessage: { message: 'synced', timestamp: 5 } },
        },
      };
      const r = adapter.normalizeInbound(sync);
      expect(r.text).toBe('synced');
      expect(r.metadata?.timestamp).toBe(5);
    });
    it('maps bridge attachments to normalized attachments', () => {
      const withAtt = {
        envelope: {
          source: '+1',
          dataMessage: {
            message: 'see attached',
            attachments: [{ contentType: 'image/png', filename: 'pic.png', id: 'att-1', size: 10 }],
          },
        },
      };
      const r = adapter.normalizeInbound(withAtt);
      expect(r.attachments).toEqual([{ url: 'att-1', type: 'image/png', name: 'pic.png' }]);
    });
    it('falls back to sourceNumber/sourceUuid for userId', () => {
      const r = adapter.normalizeInbound({ envelope: { sourceUuid: 'uuid-1', dataMessage: { message: 'x' } } });
      expect(r.userId).toBe('uuid-1');
    });
  });

  describe('formatOutbound', () => {
    it('produces {message}', () => {
      expect(adapter.formatOutbound({ text: 'r' })).toEqual({ message: 'r' });
    });
  });

  describe('sendResponse', () => {
    it('POSTs to {api_url}/v2/send for direct message', async () => {
      await adapter.sendResponse(
        { api_url: 'http://signal-cli:8080', phone_number: '+15559999999' },
        { message: 'reply' },
        { userId: '+15551234567' },
      );
      expect(fetchMock.calls[0].url).toBe('http://signal-cli:8080/v2/send');
      const body = parseSentJson(fetchMock.calls[0]);
      expect(body).toEqual({
        message: 'reply',
        number: '+15559999999',
        recipients: ['+15551234567'],
      });
    });
    it('addresses groups with the bridge "group." prefix', async () => {
      await adapter.sendResponse(
        { api_url: 'http://x', phone_number: '+1' },
        { message: 'g' },
        { userId: '+1', metadata: { groupId: 'GRP' } },
      );
      const body = parseSentJson(fetchMock.calls[0]);
      expect(body.recipients).toEqual(['group.GRP']);
    });
    it('does not double-prefix an already-prefixed group id', async () => {
      await adapter.sendResponse(
        { api_url: 'http://x', phone_number: '+1' },
        { message: 'g' },
        { userId: '+1', metadata: { groupId: 'group.GRP' } },
      );
      expect(parseSentJson(fetchMock.calls[0]).recipients).toEqual(['group.GRP']);
    });
    it('falls back to threadId as recipient when userId missing', async () => {
      await adapter.sendResponse(
        { api_url: 'http://x', phone_number: '+1' },
        { message: 'r' },
        { threadId: '+15551230000' },
      );
      expect(parseSentJson(fetchMock.calls[0]).recipients).toEqual(['+15551230000']);
    });
    /**
     * The bridge is HTTP and its body can be anything, so the status is
     * the verdict and the text is the detail worth keeping. This one
     * already noticed the rejection — it just logged it and returned,
     * which the dispatch path could not tell from a delivered reply.
     */
    it('refuses when the bridge rejects the send, with its status and body', async () => {
      fetchMock.setNextResponse({ ok: false, status: 400, text: 'Unregistered user' });
      await expect(
        adapter.sendResponse(
          { api_url: 'http://x', phone_number: '+1' },
          { message: 'r' },
          { userId: '+2' },
        ),
      ).rejects.toThrow(/400.*Unregistered user/);
    });
    it('refuses rather than skipping when api_url or phone_number is missing', async () => {
      await expect(adapter.sendResponse({}, { message: 'r' }, { userId: '+1' })).rejects.toThrow(
        /api_url is not configured/,
      );
      expect(fetchMock.calls.length).toBe(0);
    });
    it('refuses rather than skipping when no recipient is available', async () => {
      await expect(
        adapter.sendResponse({ api_url: 'http://x', phone_number: '+1' }, { message: 'r' }, {}),
      ).rejects.toThrow(/no sender or group to reply to/);
      expect(fetchMock.calls.length).toBe(0);
    });
  });
});
