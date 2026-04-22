/**
 * Tests for AlmytyClient.
 *
 * Uses a mock fetch to verify HTTP behavior, request shaping,
 * response unwrapping, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlmytyClient, GatewayClient } from '../client.js';
import type { StreamEvent } from '../client.js';

const BASE = 'https://api.test.almyty.com';
const TOKEN = 'test-token-123';

function mockFetch(status: number, body: unknown, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(headers),
  });
}

describe('AlmytyClient', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  describe('constructor', () => {
    it('should strip trailing slash from baseUrl', () => {
      const client = new AlmytyClient('https://api.test.almyty.com/', TOKEN);
      globalThis.fetch = mockFetch(200, { data: [] });
      client.listAgents();
      expect((globalThis.fetch as any).mock.calls[0][0]).toBe('https://api.test.almyty.com/agents');
    });
  });

  describe('listAgents', () => {
    it('should unwrap { data: [...] } envelope', async () => {
      const agents = [
        { id: 'a1', name: 'Agent One', mode: 'autonomous', status: 'active' },
        { id: 'a2', name: 'Agent Two', mode: 'workflow', status: 'active' },
      ];
      globalThis.fetch = mockFetch(200, { data: agents });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.listAgents();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('a1');
      expect(result[1].name).toBe('Agent Two');
    });

    it('should unwrap nested { data: { data: [...] } } envelope', async () => {
      const agents = [{ id: 'a1', name: 'Agent One' }];
      globalThis.fetch = mockFetch(200, { data: { data: agents } });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.listAgents();
      expect(result).toHaveLength(1);
    });

    it('should handle raw array response', async () => {
      const agents = [{ id: 'a1', name: 'Agent One' }];
      globalThis.fetch = mockFetch(200, agents);
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.listAgents();
      expect(result).toHaveLength(1);
    });

    it('should send Authorization header', async () => {
      globalThis.fetch = mockFetch(200, { data: [] });
      const client = new AlmytyClient(BASE, TOKEN);
      await client.listAgents();

      const call = (globalThis.fetch as any).mock.calls[0];
      expect(call[1].headers.Authorization).toBe('Bearer test-token-123');
    });
  });

  describe('getAgent', () => {
    it('should unwrap { data: {...} } envelope', async () => {
      const agent = { id: 'a1', name: 'Agent One', mode: 'autonomous' };
      globalThis.fetch = mockFetch(200, { data: agent });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.getAgent('a1');
      expect(result.id).toBe('a1');
      expect(result.name).toBe('Agent One');
    });

    it('should URL-encode agent ID', async () => {
      globalThis.fetch = mockFetch(200, { data: { id: 'a/b', name: 'test' } });
      const client = new AlmytyClient(BASE, TOKEN);
      await client.getAgent('a/b');

      const url = (globalThis.fetch as any).mock.calls[0][0];
      expect(url).toContain('/agents/a%2Fb');
    });
  });

  describe('findAgentByNameOrId', () => {
    it('should fetch by UUID directly', async () => {
      const uuid = '12345678-1234-1234-1234-123456789abc';
      const agent = { id: uuid, name: 'Test Agent', mode: 'autonomous' };
      globalThis.fetch = mockFetch(200, { data: agent });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.findAgentByNameOrId(uuid);
      expect(result?.id).toBe(uuid);
      // Should have made exactly 1 call (direct get, not list)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('should fall back to name search for non-UUID', async () => {
      const agents = [
        { id: 'a1', name: 'My Agent', mode: 'autonomous' },
        { id: 'a2', name: 'Other Agent', mode: 'workflow' },
      ];
      globalThis.fetch = mockFetch(200, { data: agents });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.findAgentByNameOrId('my agent');
      expect(result?.id).toBe('a1');
    });

    it('should match by slug', async () => {
      const agents = [
        { id: 'a1', name: 'My Agent', slug: 'my-agent', mode: 'autonomous' },
      ];
      globalThis.fetch = mockFetch(200, { data: agents });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.findAgentByNameOrId('my-agent');
      expect(result?.id).toBe('a1');
    });

    it('should return null when no match', async () => {
      globalThis.fetch = mockFetch(200, { data: [] });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.findAgentByNameOrId('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('startRun', () => {
    it('should POST to /agents/:id/runs with input', async () => {
      const run = { id: 'run-1', status: 'running', conversationId: 'conv-1' };
      globalThis.fetch = mockFetch(201, { data: run });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.startRun('a1', 'Hello');
      expect(result.id).toBe('run-1');
      expect(result.conversationId).toBe('conv-1');

      const call = (globalThis.fetch as any).mock.calls[0];
      expect(call[0]).toContain('/agents/a1/runs');
      expect(call[1].method).toBe('POST');
      const body = JSON.parse(call[1].body);
      expect(body.input).toBe('Hello');
    });

    it('should pass conversationId when provided', async () => {
      const run = { id: 'run-2', status: 'running', conversationId: 'conv-existing' };
      globalThis.fetch = mockFetch(201, { data: run });
      const client = new AlmytyClient(BASE, TOKEN);

      await client.startRun('a1', 'Follow-up', { conversationId: 'conv-existing' });

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.conversationId).toBe('conv-existing');
    });

    it('should pass run limits when provided', async () => {
      const run = { id: 'run-3', status: 'running' };
      globalThis.fetch = mockFetch(201, { data: run });
      const client = new AlmytyClient(BASE, TOKEN);

      await client.startRun('a1', 'Test', { maxSteps: 10, maxCostCents: 50 });

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.maxSteps).toBe(10);
      expect(body.maxCostCents).toBe(50);
    });

    it('should not include undefined options in body', async () => {
      const run = { id: 'run-4', status: 'running' };
      globalThis.fetch = mockFetch(201, { data: run });
      const client = new AlmytyClient(BASE, TOKEN);

      await client.startRun('a1', 'Test');

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body).toEqual({ input: 'Test' });
      expect('conversationId' in body).toBe(false);
      expect('maxSteps' in body).toBe(false);
    });
  });

  describe('getRun', () => {
    it('should GET run by agentId and runId', async () => {
      const run = { id: 'run-1', status: 'completed', output: 'Answer' };
      globalThis.fetch = mockFetch(200, { data: run });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.getRun('a1', 'run-1');
      expect(result.status).toBe('completed');
      expect(result.output).toBe('Answer');
    });
  });

  describe('listRuns', () => {
    it('should paginate runs', async () => {
      const runs = [{ id: 'run-1', status: 'completed' }];
      globalThis.fetch = mockFetch(200, { data: runs, pagination: { total: 5 } });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.listRuns('a1', 2, 10);
      expect(result.total).toBe(5);
      expect(result.data).toHaveLength(1);

      const url = (globalThis.fetch as any).mock.calls[0][0];
      expect(url).toContain('page=2');
      expect(url).toContain('limit=10');
    });
  });

  describe('sendRunInput', () => {
    it('should POST input to run', async () => {
      globalThis.fetch = mockFetch(200, {});
      const client = new AlmytyClient(BASE, TOKEN);

      await client.sendRunInput('a1', 'run-1', 'More input');

      const call = (globalThis.fetch as any).mock.calls[0];
      expect(call[0]).toContain('/runs/run-1/input');
      const body = JSON.parse(call[1].body);
      expect(body.input).toBe('More input');
    });
  });

  describe('cancelRun', () => {
    it('should POST to cancel endpoint', async () => {
      globalThis.fetch = mockFetch(200, {});
      const client = new AlmytyClient(BASE, TOKEN);

      await client.cancelRun('a1', 'run-1');

      const call = (globalThis.fetch as any).mock.calls[0];
      expect(call[0]).toContain('/runs/run-1/cancel');
      expect(call[1].method).toBe('POST');
    });
  });

  describe('pollRun', () => {
    it('should return immediately when run is completed', async () => {
      const run = { id: 'run-1', status: 'completed', output: 'Done' };
      globalThis.fetch = mockFetch(200, { data: run });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.pollRun('a1', 'run-1');
      expect(result.status).toBe('completed');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('should return when run reaches waiting_input', async () => {
      const run = { id: 'run-1', status: 'waiting_input' };
      globalThis.fetch = mockFetch(200, { data: run });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.pollRun('a1', 'run-1');
      expect(result.status).toBe('waiting_input');
    });

    it('should call onStep when steps change', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const run = callCount < 3
          ? { id: 'run-1', status: 'running', steps: Array(callCount).fill({}) }
          : { id: 'run-1', status: 'completed', steps: [{}] };
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: run }),
          text: () => Promise.resolve(''),
        });
      });

      const client = new AlmytyClient(BASE, TOKEN);
      const onStep = vi.fn();

      await client.pollRun('a1', 'run-1', { intervalMs: 10, onStep });
      expect(onStep).toHaveBeenCalled();
    });

    it('should throw on timeout', async () => {
      const run = { id: 'run-1', status: 'running', steps: [] };
      globalThis.fetch = mockFetch(200, { data: run });
      const client = new AlmytyClient(BASE, TOKEN);

      await expect(
        client.pollRun('a1', 'run-1', { intervalMs: 10, timeoutMs: 50 }),
      ).rejects.toThrow('did not finish');
    });
  });

  describe('error handling', () => {
    it('should throw on 401 with auth message', async () => {
      globalThis.fetch = mockFetch(401, { error: 'Unauthorized' });
      const client = new AlmytyClient(BASE, TOKEN);

      await expect(client.listAgents()).rejects.toThrow('Authentication failed');
    });

    it('should throw on 500 with status and body', async () => {
      globalThis.fetch = mockFetch(500, { error: 'Internal error' });
      const client = new AlmytyClient(BASE, TOKEN);

      await expect(client.listAgents()).rejects.toThrow('API error 500');
    });

    it('should handle 204 no-content', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: () => Promise.reject(new Error('no body')),
        text: () => Promise.resolve(''),
      });
      const client = new AlmytyClient(BASE, TOKEN);

      await expect(client.cancelRun('a1', 'run-1')).resolves.not.toThrow();
    });
  });

  describe('invokeAgent', () => {
    it('should POST to invoke endpoint', async () => {
      globalThis.fetch = mockFetch(200, { data: { output: 'Result' } });
      const client = new AlmytyClient(BASE, TOKEN);

      const result = await client.invokeAgent('a1', { message: 'Hello' });
      expect(result.output).toBe('Result');

      const call = (globalThis.fetch as any).mock.calls[0];
      expect(call[0]).toContain('/agents/a1/invoke');
      const body = JSON.parse(call[1].body);
      expect(body.input.message).toBe('Hello');
    });
  });

  describe('streamSSE', () => {
    function mockSSEResponse(chunks: string[]) {
      let idx = 0;
      const reader = {
        read: vi.fn().mockImplementation(() => {
          if (idx >= chunks.length) return Promise.resolve({ done: true, value: undefined });
          const value = new TextEncoder().encode(chunks[idx++]);
          return Promise.resolve({ done: false, value });
        }),
        releaseLock: vi.fn(),
      };
      return vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { getReader: () => reader },
      });
    }

    it('should parse SSE events and call handler', async () => {
      const sseData = [
        'event: llm.started\ndata: {"type":"llm.started","data":{"step":0}}\n\n',
        'event: llm.chunk\ndata: {"type":"llm.chunk","data":{"content":"Hello"}}\n\n',
        'event: run.completed\ndata: {"type":"run.completed","data":{"output":"Hello world"}}\n\n',
      ];
      globalThis.fetch = mockSSEResponse(sseData);
      const client = new AlmytyClient(BASE, TOKEN);

      const events: StreamEvent[] = [];
      await client.streamSSE('/test/stream', (e) => events.push(e));

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('llm.started');
      expect(events[1].type).toBe('llm.chunk');
      expect((events[1].data as any).data?.content ?? (events[1].data as any).content).toBe('Hello');
      expect(events[2].type).toBe('run.completed');
    });

    it('should stop on terminal events', async () => {
      const sseData = [
        'event: run.completed\ndata: {"type":"run.completed","data":{"output":"done"}}\n\n',
        'event: extra\ndata: {"type":"extra"}\n\n',
      ];
      globalThis.fetch = mockSSEResponse(sseData);
      const client = new AlmytyClient(BASE, TOKEN);

      const events: StreamEvent[] = [];
      await client.streamSSE('/test/stream', (e) => events.push(e));

      // Should stop after run.completed, not process 'extra'
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run.completed');
    });

    it('should handle stream errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Server error'),
      });
      const client = new AlmytyClient(BASE, TOKEN);

      await expect(client.streamSSE('/test/stream', () => {})).rejects.toThrow('SSE 500');
    });
  });
});

describe('GatewayClient', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('should route requests through /:org/:slug prefix', async () => {
    globalThis.fetch = mockFetch(200, { data: { id: 'a1', name: 'Test', mode: 'autonomous' } });
    const client = new AlmytyClient(BASE, TOKEN);
    const gw = client.gateway('myorg', 'my-agent');

    await gw.getInfo();
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe(`${BASE}/myorg/my-agent`);
  });

  it('should POST to /runs for startRun', async () => {
    globalThis.fetch = mockFetch(201, { data: { id: 'run-1', status: 'running', conversationId: 'conv-1' } });
    const client = new AlmytyClient(BASE, TOKEN);
    const gw = client.gateway('myorg', 'my-agent');

    const run = await gw.startRun('Hello');
    expect(run.id).toBe('run-1');
    expect(run.conversationId).toBe('conv-1');

    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toBe(`${BASE}/myorg/my-agent/runs`);
  });

  it('should pass conversationId in startRun body', async () => {
    globalThis.fetch = mockFetch(201, { data: { id: 'run-2', status: 'running' } });
    const client = new AlmytyClient(BASE, TOKEN);
    const gw = client.gateway('myorg', 'my-agent');

    await gw.startRun('Follow-up', { conversationId: 'conv-existing' });
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.conversationId).toBe('conv-existing');
  });

  it('should GET /runs/:id for getRun', async () => {
    globalThis.fetch = mockFetch(200, { data: { id: 'run-1', status: 'completed', output: 'done' } });
    const client = new AlmytyClient(BASE, TOKEN);
    const gw = client.gateway('myorg', 'my-agent');

    const run = await gw.getRun('run-1');
    expect(run.status).toBe('completed');
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe(`${BASE}/myorg/my-agent/runs/run-1`);
  });

  it('should POST to /runs/:id/cancel', async () => {
    globalThis.fetch = mockFetch(200, {});
    const client = new AlmytyClient(BASE, TOKEN);
    const gw = client.gateway('myorg', 'my-agent');

    await gw.cancelRun('run-1');
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toBe(`${BASE}/myorg/my-agent/runs/run-1/cancel`);
  });

  it('should POST to /runs/:id/input', async () => {
    globalThis.fetch = mockFetch(200, {});
    const client = new AlmytyClient(BASE, TOKEN);
    const gw = client.gateway('myorg', 'my-agent');

    await gw.sendRunInput('run-1', 'more context');
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.input).toBe('more context');
  });

  it('should streamRun and fall back to getRun', async () => {
    let callIdx = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      callIdx++;
      if (url.includes('/stream')) {
        // SSE stream that ends immediately
        const reader = {
          read: vi.fn().mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode('event: run.completed\ndata: {"type":"run.completed","data":{"output":"streamed"}}\n\n'),
          }).mockResolvedValue({ done: true, value: undefined }),
          releaseLock: vi.fn(),
        };
        return Promise.resolve({ ok: true, status: 200, body: { getReader: () => reader } });
      }
      // getRun fallback
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { id: 'run-1', status: 'completed', output: 'streamed' } }),
        text: () => Promise.resolve(''),
      });
    });

    const client = new AlmytyClient(BASE, TOKEN);
    const gw = client.gateway('myorg', 'my-agent');
    const events: StreamEvent[] = [];

    const result = await gw.streamRun('run-1', (e) => events.push(e));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe('completed');
  });
});
