/**
 * Mem0Client wire format: endpoint, method, auth header and body for
 * every call the Mem0 backend makes, and the error mapping. All
 * traffic goes through safeFetch, so the egress gate is mocked here.
 */
const safeFetch = jest.fn();
jest.mock('../../../../../common/security/safe-fetch', () => ({ safeFetch }));

import { Mem0Client, Mem0Error, Mem0NotFoundError } from '../mem0.client';

function reply(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function lastCall() {
  const [url, init] = safeFetch.mock.calls[safeFetch.mock.calls.length - 1];
  return { url, init, body: init.body ? JSON.parse(init.body) : undefined };
}

describe('Mem0Client', () => {
  const client = new Mem0Client('key-1', 'https://mem0.example.com/');

  beforeEach(() => safeFetch.mockReset());

  it('rejects a blank API key', () => {
    expect(() => new Mem0Client('  ')).toThrow('Mem0 API key is required');
  });

  it('defaults to the hosted API and sends Token auth', async () => {
    safeFetch.mockResolvedValue(reply(200, { status: 'ok' }));
    await new Mem0Client('key-2').ping();
    const { url, init } = lastCall();
    expect(url).toBe('https://api.mem0.ai/v1/ping/');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Token key-2');
  });

  it('ping fails when the API does not answer ok', async () => {
    safeFetch.mockResolvedValue(reply(200, { status: 'error', message: 'bad key' }));
    await expect(client.ping()).rejects.toThrow('bad key');
  });

  it('add posts messages, user_id and metadata to v3', async () => {
    safeFetch.mockResolvedValue(reply(200, [{ id: 'm1' }]));
    const res = await client.add([{ role: 'user', content: 'hi' }], {
      userId: 'workspace:w1',
      metadata: { almyty_id: 'a1' },
    });
    const { url, init, body } = lastCall();
    expect(url).toBe('https://mem0.example.com/v3/memories/add/');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      user_id: 'workspace:w1',
      metadata: { almyty_id: 'a1' },
    });
    expect(res).toEqual([{ id: 'm1' }]);
  });

  it('search posts query, top_k and filters', async () => {
    safeFetch.mockResolvedValue(reply(200, { results: [] }));
    await client.search('pluto', { filters: { user_id: 'u' }, topK: 3 });
    const { url, body } = lastCall();
    expect(url).toBe('https://mem0.example.com/v3/memories/search/');
    expect(body).toEqual({
      query: 'pluto',
      output_format: 'v1.1',
      top_k: 3,
      filters: { user_id: 'u' },
    });
  });

  it('getAll posts filters with page_size in the query string', async () => {
    safeFetch.mockResolvedValue(reply(200, { results: [], count: 0 }));
    await client.getAll({ filters: { user_id: 'u' }, pageSize: 10 });
    const { url, init, body } = lastCall();
    expect(url).toBe('https://mem0.example.com/v3/memories/?page_size=10');
    expect(init.method).toBe('POST');
    expect(body).toEqual({ filters: { user_id: 'u' } });
  });

  it('get and delete encode the memory id into the path', async () => {
    safeFetch.mockResolvedValue(reply(200, { id: 'a/b' }));
    await client.get('a/b');
    expect(lastCall().url).toBe('https://mem0.example.com/v1/memories/a%2Fb/');
    await client.delete('a/b');
    expect(lastCall().init.method).toBe('DELETE');
    expect(lastCall().url).toBe('https://mem0.example.com/v1/memories/a%2Fb/');
  });

  it('batchDelete sends memory_id objects to v1/batch', async () => {
    safeFetch.mockResolvedValue(reply(200, { message: 'ok' }));
    await client.batchDelete(['x', 'y']);
    const { url, init, body } = lastCall();
    expect(url).toBe('https://mem0.example.com/v1/batch/');
    expect(init.method).toBe('DELETE');
    expect(body).toEqual({ memories: [{ memory_id: 'x' }, { memory_id: 'y' }] });
  });

  it('maps 404 to Mem0NotFoundError and other failures to Mem0Error', async () => {
    safeFetch.mockResolvedValue(reply(404, 'Memory not found'));
    await expect(client.get('gone')).rejects.toBeInstanceOf(Mem0NotFoundError);

    safeFetch.mockResolvedValue(reply(500, ''));
    const err = await client.get('boom').catch((e) => e);
    expect(err).toBeInstanceOf(Mem0Error);
    expect(err).not.toBeInstanceOf(Mem0NotFoundError);
    expect(err.status).toBe(500);
    expect(err.message).toBe('HTTP 500 error');
  });
});
