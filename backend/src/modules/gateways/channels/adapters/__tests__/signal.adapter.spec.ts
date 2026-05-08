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
    it('uses groupId from metadata when present', async () => {
      await adapter.sendResponse(
        { api_url: 'http://x', phone_number: '+1' },
        { message: 'g' },
        { userId: '+1', metadata: { groupId: 'GRP' } },
      );
      const body = parseSentJson(fetchMock.calls[0]);
      expect(body.recipients).toEqual(['GRP']);
    });
    it('skips when api_url or phone_number missing', async () => {
      await adapter.sendResponse({}, { message: 'r' }, { userId: '+1' });
      expect(fetchMock.calls.length).toBe(0);
    });
    it('skips when no recipient available', async () => {
      await adapter.sendResponse({ api_url: 'http://x', phone_number: '+1' }, { message: 'r' }, {});
      expect(fetchMock.calls.length).toBe(0);
    });
  });
});
