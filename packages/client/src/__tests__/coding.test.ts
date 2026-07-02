/**
 * Runner + coding-session client surface (the chat-to-runner bridge).
 * Mock fetch verifies URL shaping, request bodies, envelope unwrapping,
 * and that the coding event stream terminates on coding.exit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlmytyClient } from '../client.js';
import type { StreamEvent } from '../client.js';

const BASE = 'https://api.test.almyty.com';
const TOKEN = 'test-token-123';
const RUNNER = 'a4d2b1c0-0000-0000-0000-000000000001';
const SID = 'cs_11111111-2222-3333-4444-555566667777';

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
  });
}

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

describe('AlmytyClient coding bridge', () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('listRunners maps runner rows and detected coding CLIs', async () => {
    globalThis.fetch = mockFetch(200, {
      success: true,
      data: [{
        id: RUNNER,
        name: 'mac-studio',
        state: 'online',
        labels: { env: 'dev' },
        runtimeInfo: {
          codingAgents: [
            { id: 'claude', displayName: 'Claude Code', binary: 'claude', version: '2.1.0' },
          ],
        },
      }],
    });
    const client = new AlmytyClient(BASE, TOKEN);
    const runners = await client.listRunners();
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe(`${BASE}/runners`);
    expect(runners).toHaveLength(1);
    expect(runners[0].name).toBe('mac-studio');
    expect(runners[0].state).toBe('online');
    expect(runners[0].codingAgents).toEqual([
      { id: 'claude', displayName: 'Claude Code', binary: 'claude', version: '2.1.0' },
    ]);
  });

  it('listRunners tolerates runners without runtimeInfo', async () => {
    globalThis.fetch = mockFetch(200, { data: [{ id: RUNNER, name: 'bare' }] });
    const client = new AlmytyClient(BASE, TOKEN);
    const runners = await client.listRunners();
    expect(runners[0].codingAgents).toEqual([]);
  });

  it('startCodingSession POSTs agent + task and unwraps the session', async () => {
    globalThis.fetch = mockFetch(200, {
      success: true,
      data: { sessionId: SID, agent: 'claude', status: 'running' },
    });
    const client = new AlmytyClient(BASE, TOKEN);
    const session = await client.startCodingSession(RUNNER, {
      agent: 'claude',
      task: 'fix the login bug',
      cwd: '/home/me',
    });
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(`${BASE}/runners/${RUNNER}/coding/sessions`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      agent: 'claude',
      task: 'fix the login bug',
      cwd: '/home/me',
    });
    expect(session.sessionId).toBe(SID);
  });

  it('sendCodingInput and stopCodingSession hit the per-session routes', async () => {
    globalThis.fetch = mockFetch(200, { success: true, data: {} });
    const client = new AlmytyClient(BASE, TOKEN);

    await client.sendCodingInput(RUNNER, SID, 'yes, proceed');
    let [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(`${BASE}/runners/${RUNNER}/coding/sessions/${SID}/input`);
    expect(JSON.parse(init.body)).toEqual({ data: 'yes, proceed' });

    await client.stopCodingSession(RUNNER, SID, true);
    [url, init] = (globalThis.fetch as any).mock.calls[1];
    expect(url).toBe(`${BASE}/runners/${RUNNER}/coding/sessions/${SID}/stop`);
    expect(JSON.parse(init.body)).toEqual({ force: true });
  });

  it('listRunnerCodingAgents unwraps the agents array', async () => {
    globalThis.fetch = mockFetch(200, {
      success: true,
      data: { agents: [{ id: 'codex', displayName: 'Codex', binary: 'codex' }] },
    });
    const client = new AlmytyClient(BASE, TOKEN);
    const agents = await client.listRunnerCodingAgents(RUNNER);
    expect((globalThis.fetch as any).mock.calls[0][0])
      .toBe(`${BASE}/runners/${RUNNER}/coding/agents`);
    expect(agents).toEqual([{ id: 'codex', displayName: 'Codex', binary: 'codex' }]);
  });

  it('streamCodingEvents delivers output events and terminates on coding.exit', async () => {
    const sse = [
      `event: coding.output\ndata: {"type":"coding.output","sessionId":"${SID}","data":"hello\\n","seq":1}\n\n`,
      `event: coding.exit\ndata: {"type":"coding.exit","sessionId":"${SID}","exitCode":0}\n\n`,
      'event: extra\ndata: {"type":"extra"}\n\n',
    ];
    globalThis.fetch = mockSSEResponse(sse);
    const client = new AlmytyClient(BASE, TOKEN);

    const events: StreamEvent[] = [];
    await client.streamCodingEvents(RUNNER, SID, (e) => events.push(e));

    expect((globalThis.fetch as any).mock.calls[0][0])
      .toBe(`${BASE}/runners/${RUNNER}/coding/sessions/${SID}/events`);
    // Terminates on coding.exit; 'extra' never delivered.
    expect(events.map((e) => e.type)).toEqual(['coding.output', 'coding.exit']);
    expect((events[0].data as any).data).toBe('hello\n');
  });
});
