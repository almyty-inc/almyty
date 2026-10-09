import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelToken, readModelAccess, startModelProxy } from '../src/model-proxy.js';
import { prepareHostedWorkspace } from '../src/hosted-setup.js';

/** Plainly fake pod tokens; nothing real. */
const FAKE_POD_TOKEN = 'almyty_pod_fake-token-for-tests';
const RENEWED_POD_TOKEN = 'almyty_pod_fake-renewed-token-for-tests';

interface Seen { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }

/** A fake almyty API: answers /v1/messages with a short event stream and records what it got. */
async function fakeApi(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Almyty-Hosted-Runner': 'hr-1' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('the pod model token, read from the environment', () => {
  it('is taken out of the environment once read, so nothing the runner starts inherits it', () => {
    const env: Record<string, string | undefined> = {
      ALMYTY_MODEL_TOKEN: FAKE_POD_TOKEN,
      ALMYTY_MODEL_TOKEN_EXPIRES_AT: '2026-10-08T13:00:00.000Z',
      ALMYTY_MODEL_PROXY_PORT: '4319',
      ALMYTY_MODEL_RENEW_PATH: '/runners/hosted/model-token',
    };
    const access = readModelAccess(env);
    expect(access).toEqual({ token: FAKE_POD_TOKEN, expiresAt: new Date('2026-10-08T13:00:00.000Z'), port: 4319, renewPath: '/runners/hosted/model-token' });
    expect(env.ALMYTY_MODEL_TOKEN).toBeUndefined();
    expect(env.ALMYTY_MODEL_TOKEN_EXPIRES_AT).toBeUndefined();
  });

  it('is nothing without a token or a port (a runner outside a hosted pod), and is still scrubbed', () => {
    const env: Record<string, string | undefined> = { ALMYTY_MODEL_TOKEN: FAKE_POD_TOKEN };
    expect(readModelAccess(env)).toBeNull();
    expect(env.ALMYTY_MODEL_TOKEN).toBeUndefined();
    expect(readModelAccess({ ALMYTY_MODEL_PROXY_PORT: '4319' })).toBeNull();
  });
});

describe('the loopback model proxy', () => {
  it('forwards a CLI\'s call to the API with the current pod token in place of whatever the CLI sent, streaming the answer back', async () => {
    const api = await fakeApi();
    closers.push(api.close);
    let current = FAKE_POD_TOKEN;
    const proxy = await startModelProxy({ backendUrl: api.url, port: 0, token: () => current });
    closers.push(proxy.close);

    const body = JSON.stringify({ model: 'claude-sonnet-4-5', stream: true, tools: [{ name: 'Bash' }], messages: [] });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'almyty-pod-local', Authorization: 'Bearer almyty-pod-local', 'anthropic-version': '2023-06-01' },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-almyty-hosted-runner')).toBe('hr-1');
    expect(await res.text()).toContain('message_stop');
    expect(api.seen[0]).toMatchObject({ method: 'POST', url: '/v1/messages?beta=true', body });
    expect(api.seen[0].headers.authorization).toBe(`Bearer ${FAKE_POD_TOKEN}`);
    expect(api.seen[0].headers['x-api-key']).toBeUndefined();
    expect(api.seen[0].headers['anthropic-version']).toBe('2023-06-01');

    // A renewed token is used from the next call on, without the CLI noticing.
    current = RENEWED_POD_TOKEN;
    await (await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: 'POST', body: '{}' })).text();
    expect(api.seen[1].headers.authorization).toBe(`Bearer ${RENEWED_POD_TOKEN}`);
  });

  it('serves the model endpoints only, on loopback only', async () => {
    const api = await fakeApi();
    closers.push(api.close);
    const proxy = await startModelProxy({ backendUrl: api.url, port: 0, token: () => FAKE_POD_TOKEN });
    closers.push(proxy.close);
    const res = await fetch(`http://127.0.0.1:${proxy.port}/runners/hosted/credential`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(api.seen).toHaveLength(0);
    expect((proxy.server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('answers 502 when almyty cannot be reached', async () => {
    const proxy = await startModelProxy({ backendUrl: 'http://127.0.0.1:9', port: 0, token: () => FAKE_POD_TOKEN });
    closers.push(proxy.close);
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
  });
});

describe('renewing the pod model token', () => {
  const okFetch = (token: string, expiresAt: string) =>
    vi.fn(async () => new Response(JSON.stringify({ success: true, data: { token, expiresAt } }), { status: 200 }));

  it('renews with the current token at three quarters of its life, and uses the new one from then on', async () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const fetchImpl = okFetch(RENEWED_POD_TOKEN, '2026-10-08T14:00:00Z');
    const timers: number[] = [];
    const holder = new ModelToken({
      backendUrl: 'https://api.almyty.test', renewPath: '/runners/hosted/model-token', token: FAKE_POD_TOKEN,
      expiresAt: new Date('2026-10-08T13:00:00Z'), fetch: fetchImpl as any, now: () => now,
      setTimeoutFn: ((_: any, ms: number) => { timers.push(ms); return 0 as any; }) as any, clearTimeoutFn: (() => undefined) as any,
    });
    holder.start();
    expect(timers[0]).toBe(45 * 60_000);
    expect(await holder.renew()).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as any;
    expect(url).toBe('https://api.almyty.test/runners/hosted/model-token');
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_POD_TOKEN}`);
    expect(holder.current()).toBe(RENEWED_POD_TOKEN);
    expect(holder.expiry()).toEqual(new Date('2026-10-08T14:00:00Z'));
  });

  it('renews at once when the pod did not say when the token expires', () => {
    const holder = new ModelToken({ backendUrl: 'https://api.almyty.test', renewPath: '/x', token: FAKE_POD_TOKEN, expiresAt: null });
    expect(holder.renewDelay()).toBe(0);
  });

  it('stops renewing when the API refuses (the pod is being stopped), without taking the runner down', async () => {
    const lines: string[] = [];
    const holder = new ModelToken({
      backendUrl: 'https://api.almyty.test', renewPath: '/x', token: FAKE_POD_TOKEN, expiresAt: new Date(Date.now() + 3_600_000),
      fetch: (async () => new Response('{"message":"This pod token is not valid"}', { status: 401 })) as any, log: (l) => lines.push(l),
    });
    expect(await holder.renew()).toBe(false);
    expect(holder.current()).toBe(FAKE_POD_TOKEN);
    expect(lines.join('\n')).toMatch(/refused \(401\)/);
    expect(lines.join('\n')).not.toContain(FAKE_POD_TOKEN);
  });
});

describe('an inherited, read-only workspace', () => {
  it('is not set up: nothing is cloned or written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ro-ws-'));
    const run = vi.fn();
    const outcome = await prepareHostedWorkspace({
      env: { ALMYTY_WORKSPACE_ROOT: root, ALMYTY_WORKSPACE_READ_ONLY: 'true', ALMYTY_REPO_URL: 'https://github.com/acme/app', ALMYTY_SETUP_SCRIPT: 'npm ci' },
      run: run as any, log: () => undefined, warn: () => undefined,
    });
    expect(outcome).toMatchObject({ ok: true, cloned: false, setupRan: false });
    expect(run).not.toHaveBeenCalled();
    expect(() => readFileSync(join(root, '.almyty', 'env-version'))).toThrow();
  });
});
