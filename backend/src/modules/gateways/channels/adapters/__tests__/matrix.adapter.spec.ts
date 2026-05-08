import { MatrixAdapter } from '../matrix.adapter';
import { installFetchMock, parseSentJson } from './test-helpers';

const matrixEvent = {
  event_id: '$abc',
  type: 'm.room.message',
  sender: '@alice:matrix.org',
  room_id: '!room1:matrix.org',
  content: { body: 'hi bot', msgtype: 'm.text' },
};

describe('MatrixAdapter', () => {
  let adapter: MatrixAdapter;
  let fetchMock: ReturnType<typeof installFetchMock>;
  beforeEach(() => { adapter = new MatrixAdapter(); fetchMock = installFetchMock(); });
  afterEach(() => fetchMock.restore());

  describe('normalizeInbound', () => {
    it('extracts body/sender/room from event', () => {
      const r = adapter.normalizeInbound(matrixEvent);
      expect(r.text).toBe('hi bot');
      expect(r.userId).toBe('@alice:matrix.org');
      expect(r.threadId).toBe('!room1:matrix.org');
      expect(r.metadata?.eventId).toBe('$abc');
      expect(r.metadata?.eventType).toBe('m.room.message');
      expect(r.metadata?.source).toBe('matrix');
    });
    it('handles missing content', () => {
      expect(adapter.normalizeInbound({}).text).toBe('');
    });
  });

  describe('formatOutbound', () => {
    it('produces m.text payload', () => {
      expect(adapter.formatOutbound({ text: 'reply' })).toEqual({ msgtype: 'm.text', body: 'reply' });
    });
  });

  describe('sendResponse', () => {
    it('PUTs to /_matrix/client/r0/rooms/{room}/send/m.room.message/{txnId}', async () => {
      await adapter.sendResponse(
        { homeserver_url: 'https://matrix.org', access_token: 'tok-1' },
        { msgtype: 'm.text', body: 'reply' },
        { threadId: '!room1:matrix.org' },
      );
      expect(fetchMock.calls[0].url).toMatch(/^https:\/\/matrix\.org\/_matrix\/client\/r0\/rooms\/!room1%3Amatrix\.org\/send\/m\.room\.message\/m\d+$/);
      expect(fetchMock.calls[0].init.method).toBe('PUT');
      expect(fetchMock.calls[0].init.headers['Authorization']).toBe('Bearer tok-1');
      expect(parseSentJson(fetchMock.calls[0])).toEqual({ msgtype: 'm.text', body: 'reply' });
    });
    it('skips when homeserver_url/access_token/room_id missing', async () => {
      await adapter.sendResponse({}, { msgtype: 'm.text', body: 'r' }, {});
      expect(fetchMock.calls.length).toBe(0);
    });
  });
});
