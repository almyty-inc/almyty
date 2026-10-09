import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import {
  enroll,
  EnrollmentError,
  readEnrollSettings,
  RunnerCredential,
} from '../src/enroll.js';
import { FAKE_TOKEN, FakeHostedApi, startFakeHostedApi } from './fake-hosted-api.js';

vi.mock('../src/runtime-info.js', () => ({
  RUNNER_VERSION: 'test',
  detectRuntimeInfo: async () => ({
    os: 'linux', arch: 'x64', hostname: 'hr-ws-1', cpuCount: 1, memoryMb: 2048,
    runnerVersion: 'test', binaries: { git: '/usr/bin/git' }, codingAgents: [],
  }),
}));

const RUNTIME = {
  os: 'linux', arch: 'x64', hostname: 'hr-ws-1', cpuCount: 1, memoryMb: 2048,
  runnerVersion: 'test', binaries: {}, codingAgents: [],
};

let api: FakeHostedApi;
beforeEach(async () => { api = await startFakeHostedApi(); });
afterEach(async () => { await api.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('readEnrollSettings', () => {
  it('reads the token and the API URL the Deployment sets, and takes the token out of the environment', () => {
    const env: Record<string, string | undefined> = { ALMYTY_ENROLLMENT_TOKEN: ` ${FAKE_TOKEN}\n`, ALMYTY_API_URL: 'https://api.example.com/' };
    const s = readEnrollSettings(env);
    expect(s).toEqual({ backendUrl: 'https://api.example.com', enrollPath: '/runners/enroll', token: FAKE_TOKEN });
    expect(env).not.toHaveProperty('ALMYTY_ENROLLMENT_TOKEN');
  });

  it('reads the token from a mounted file when no variable carries it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'enroll-token-'));
    try {
      writeFileSync(join(dir, 'token'), `${FAKE_TOKEN}\n`);
      const env: Record<string, string | undefined> = { ALMYTY_ENROLLMENT_TOKEN_FILE: join(dir, 'token'), ALMYTY_API_URL: 'https://api.example.com' };
      expect(readEnrollSettings(env).token).toBe(FAKE_TOKEN);
      expect(env).not.toHaveProperty('ALMYTY_ENROLLMENT_TOKEN_FILE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails without a token, without an API URL, and for plain http to a remote host', () => {
    expect(() => readEnrollSettings({ ALMYTY_API_URL: 'https://api.example.com' })).toThrow(EnrollmentError);
    expect(() => readEnrollSettings({ ALMYTY_ENROLLMENT_TOKEN: 't' })).toThrow(/ALMYTY_API_URL/);
    expect(() => readEnrollSettings({ ALMYTY_ENROLLMENT_TOKEN: 't', ALMYTY_API_URL: 'http://api.example.com' })).toThrow(/insecure/);
    expect(() => readEnrollSettings({ ALMYTY_ENROLLMENT_TOKEN_FILE: '/nonexistent/token', ALMYTY_API_URL: 'https://a.example' })).toThrow(/cannot read/);
  });

  it('lets --url override the variable', () => {
    expect(readEnrollSettings({ ALMYTY_ENROLLMENT_TOKEN: 't', ALMYTY_API_URL: 'https://a.example' }, { url: 'http://localhost:4000' }).backendUrl)
      .toBe('http://localhost:4000');
  });
});

describe('enroll', () => {
  it('trades the token once for a runner credential', async () => {
    const r = await enroll({ backendUrl: api.url, enrollPath: '/runners/enroll', token: FAKE_TOKEN }, { runtimeInfo: RUNTIME as any });
    expect(r.runnerId).toBe('11111111-2222-4333-8444-555555555555');
    expect(r.credential).toBe(api.issued[0]);
    expect(r.streamPath).toBe('/runners/hosted/stream');
    expect(r.renewPath).toBe('/runners/hosted/credential');
    expect(r.effectiveConfig.allowedCwdRoots).toEqual(['/workspace']);
    expect(api.enrollBodies[0]).toEqual({ token: FAKE_TOKEN, runtimeInfo: RUNTIME });

    // Single use: the same token again is refused, and the error does not repeat it.
    const again = await enroll({ backendUrl: api.url, enrollPath: '/runners/enroll', token: FAKE_TOKEN }, { runtimeInfo: RUNTIME as any })
      .catch((e) => e);
    expect(again).toBeInstanceOf(EnrollmentError);
    expect(again.status).toBe(401);
    expect(again.message).toMatch(/enrollment refused: 401 This enrollment token is not valid/);
    expect(again.message).not.toContain(FAKE_TOKEN);
  });

  it('reports an unreachable API as an enrollment failure', async () => {
    const url = api.url;
    await api.close();
    await expect(enroll({ backendUrl: url, enrollPath: '/runners/enroll', token: FAKE_TOKEN }, { runtimeInfo: RUNTIME as any }))
      .rejects.toThrow(/enrollment request failed/);
    api = await startFakeHostedApi();
  });

  it('refuses an answer without a credential', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { runnerId: 'r' } }), { status: 200 }));
    await expect(enroll({ backendUrl: 'https://a.example', enrollPath: '/runners/enroll', token: 't' }, { runtimeInfo: RUNTIME as any }, fetchStub))
      .rejects.toThrow(/without a runner id, credential/);
  });

  it('redacts the token if a server ever echoes it', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: `bad token ${FAKE_TOKEN}` }), { status: 400 }));
    const err = await enroll({ backendUrl: 'https://a.example', enrollPath: '/runners/enroll', token: FAKE_TOKEN }, { runtimeInfo: RUNTIME as any }, fetchStub)
      .catch((e) => e);
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain(FAKE_TOKEN);
  });
});

describe('RunnerCredential', () => {
  async function enrolled(): Promise<RunnerCredential & { fatal: string[] }> {
    const r = await enroll({ backendUrl: api.url, enrollPath: '/runners/enroll', token: FAKE_TOKEN }, { runtimeInfo: RUNTIME as any });
    const fatal: string[] = [];
    const c = new RunnerCredential({
      backendUrl: api.url, renewPath: r.renewPath, credential: r.credential, expiresAt: r.expiresAt,
      onFatal: (reason) => fatal.push(reason),
    }) as RunnerCredential & { fatal: string[] };
    c.fatal = fatal;
    return c;
  }

  it('renews at three quarters of the lifetime', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const c = new RunnerCredential({
      backendUrl: 'https://a.example', renewPath: '/r', credential: 'c',
      expiresAt: new Date(now + 60 * 60_000), onFatal: () => {}, now: () => now,
    });
    expect(c.renewDelay()).toBe(45 * 60_000);
  });

  it('swaps in the renewed credential, which the API then accepts', async () => {
    const c = await enrolled();
    expect(await c.renew()).toBe(true);
    expect(c.current()).toBe(api.issued[1]);
    expect(api.requests.at(-1)).toMatchObject({ path: '/runners/hosted/credential', authorization: `Bearer ${api.issued[0]}` });
    expect(await c.renew()).toBe(true);
    expect(c.current()).toBe(api.issued[2]);
    c.stop();
  });

  it('renews on its own timer before the credential expires', async () => {
    api.credentialTtlSeconds = 0.4;
    const c = await enrolled();
    c.start();
    // The fake records a credential before the runner has read the reply.
    await vi.waitFor(() => {
      expect(api.issued.length).toBeGreaterThanOrEqual(2);
      expect(c.current()).toBe(api.issued[api.issued.length - 1]);
    }, { timeout: 3000 });
    c.stop();
  });

  it('gives up when the hosted runner is gone (404) or the credential is refused (401)', async () => {
    const c = await enrolled();
    api.renewStatus = 404;
    expect(await c.renew()).toBe(false);
    expect(c.fatal[0]).toMatch(/credential renewal refused: 404/);
    c.stop();
  });

  it('retries a failure while there is time, and gives up when there is none', async () => {
    let now = 0;
    const timers: Array<{ fn: () => void; delay: number }> = [];
    const fetchStub = vi.fn().mockResolvedValue(new Response('upstream down', { status: 502 }));
    const fatal: string[] = [];
    const c = new RunnerCredential({
      backendUrl: 'https://a.example', renewPath: '/r', credential: 'c', expiresAt: new Date(10 * 60_000),
      onFatal: (r) => fatal.push(r), fetch: fetchStub, now: () => now,
      setTimeoutFn: ((fn: () => void, delay: number) => { timers.push({ fn, delay }); return timers.length as any; }) as any,
      clearTimeoutFn: (() => {}) as any,
    });
    expect(await c.renew()).toBe(false);
    expect(fatal).toEqual([]);
    expect(timers.at(-1)?.delay).toBe(30_000);
    now = 10 * 60_000 - 10_000;
    expect(await c.renew()).toBe(false);
    expect(fatal[0]).toMatch(/expires before another try/);
  });
});

describe('enroll mode end to end (RunnerDaemon.startEnrolled against the fake API)', () => {
  it('enrolls, sets up, holds the hosted stream with the credential, heartbeats, and never prints a secret', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'almyty-enroll-state-'));
    vi.stubEnv('ALMYTY_RUNNER_STATE_DIR', stateDir);
    vi.resetModules();
    const { RunnerDaemon } = await import('../src/daemon.js');
    const out: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
    const env: Record<string, string | undefined> = { ALMYTY_ENROLLMENT_TOKEN: FAKE_TOKEN, ALMYTY_API_URL: api.url };
    const prepare = vi.fn().mockResolvedValue({ ok: true });
    const exit = vi.fn();
    const daemon = new RunnerDaemon();
    try {
      // Resolves while the stream is still open: the heartbeat must not
      // wait for the stream to end.
      await daemon.startEnrolled({ env, prepare, exit, installSignals: false });
      expect(prepare).toHaveBeenCalledWith({ env });
      expect(env).not.toHaveProperty('ALMYTY_ENROLLMENT_TOKEN');
      expect(process.env.ALMYTY_ENROLLMENT_TOKEN).toBeUndefined();

      await vi.waitFor(() => {
        expect(api.openStreams).toBe(1);
        expect(api.envelopes.map((e) => e.type)).toEqual(expect.arrayContaining(['event', 'heartbeat']));
      });
      const credential = api.issued[0];
      const hello = api.envelopes.find((e) => e.payload?.kind === 'runner.hello');
      expect(hello.payload.runnerId).toBe('11111111-2222-4333-8444-555555555555');
      const streamCalls = api.requests.filter((r) => r.path === '/runners/hosted/stream');
      expect(streamCalls.length).toBeGreaterThanOrEqual(3);
      for (const r of streamCalls) expect(r.authorization).toBe(`Bearer ${credential}`);
      // Never the login route, never the self-hosted stream.
      expect(api.requests.some((r) => r.path === '/runners/register' || r.path === '/runners/stream')).toBe(false);

      const printed = out.join('');
      expect(printed).toContain('enrolled as 11111111-2222-4333-8444-555555555555');
      expect(printed).not.toContain(FAKE_TOKEN);
      expect(printed).not.toContain(credential);
      // The state file is for `almyty runner status`; it never holds the credential.
      for (const f of readdirSync(stateDir)) {
        expect(readFileSync(join(stateDir, f), 'utf-8')).not.toContain(credential);
      }
      expect(exit).not.toHaveBeenCalled();
    } finally {
      await daemon.shutdown();
      outSpy.mockRestore();
      errSpy.mockRestore();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('fails with an EnrollmentError on a spent token, before touching the workspace', async () => {
    vi.resetModules();
    const { RunnerDaemon } = await import('../src/daemon.js');
    const { EnrollmentError: FreshEnrollmentError } = await import('../src/enroll.js');
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const prepare = vi.fn();
    try {
      await enroll({ backendUrl: api.url, enrollPath: '/runners/enroll', token: FAKE_TOKEN }, { runtimeInfo: RUNTIME as any });
      const err = await new RunnerDaemon()
        .startEnrolled({ env: { ALMYTY_ENROLLMENT_TOKEN: FAKE_TOKEN, ALMYTY_API_URL: api.url }, prepare, installSignals: false })
        .catch((e) => e);
      expect(err).toBeInstanceOf(FreshEnrollmentError);
      expect(err.message).toMatch(/401/);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      outSpy.mockRestore();
    }
  });

  it('exits non-zero when renewal is refused', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'almyty-enroll-state-'));
    vi.stubEnv('ALMYTY_RUNNER_STATE_DIR', stateDir);
    vi.resetModules();
    const { RunnerDaemon } = await import('../src/daemon.js');
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    api.credentialTtlSeconds = 0.4;
    api.renewStatus = 404;
    const exit = vi.fn();
    const daemon = new RunnerDaemon();
    try {
      await daemon.startEnrolled({
        env: { ALMYTY_ENROLLMENT_TOKEN: FAKE_TOKEN, ALMYTY_API_URL: api.url },
        prepare: vi.fn().mockResolvedValue({ ok: true }), exit, installSignals: false,
      });
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 3000 });
    } finally {
      await daemon.shutdown();
      outSpy.mockRestore();
      errSpy.mockRestore();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('serves the pod model token to the coding CLIs through the loopback proxy, and keeps it out of their environment', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'almyty-enroll-state-'));
    vi.stubEnv('ALMYTY_RUNNER_STATE_DIR', stateDir);
    vi.resetModules();
    const { RunnerDaemon } = await import('../src/daemon.js');
    const out: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const podToken = 'almyty_pod_fake-token-for-tests';
    const env: Record<string, string | undefined> = {
      ALMYTY_ENROLLMENT_TOKEN: FAKE_TOKEN, ALMYTY_API_URL: api.url,
      ALMYTY_MODEL_TOKEN: podToken, ALMYTY_MODEL_TOKEN_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
      ALMYTY_MODEL_PROXY_PORT: String(port), ALMYTY_MODEL_RENEW_PATH: '/runners/hosted/model-token',
    };
    const daemon = new RunnerDaemon();
    try {
      await daemon.startEnrolled({ env, prepare: vi.fn().mockResolvedValue({ ok: true }), exit: vi.fn(), installSignals: false });
      expect(env).not.toHaveProperty('ALMYTY_MODEL_TOKEN');
      expect(out.join('')).toContain(`model proxy listening on 127.0.0.1:${port}`);
      await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'almyty-pod-local' }, body: '{}' }).then((r) => r.text());
      const call = api.requests.find((r) => r.path === '/v1/messages');
      expect(call?.authorization).toBe(`Bearer ${podToken}`);
      expect(out.join('')).not.toContain(podToken);
    } finally {
      await daemon.shutdown();
      outSpy.mockRestore();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('holds every command to the environment\'s ALMYTY_ALLOW_BINARIES', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'almyty-enroll-state-'));
    vi.stubEnv('ALMYTY_RUNNER_STATE_DIR', stateDir);
    vi.resetModules();
    const { RunnerDaemon } = await import('../src/daemon.js');
    const out: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
    const daemon = new RunnerDaemon();
    try {
      await daemon.startEnrolled({
        env: { ALMYTY_ENROLLMENT_TOKEN: FAKE_TOKEN, ALMYTY_API_URL: api.url, ALMYTY_ALLOW_BINARIES: '["git","npm"]' },
        prepare: vi.fn().mockResolvedValue({ ok: true }), exit: vi.fn(), installSignals: false,
      });
      expect(out.join('')).toContain('binaries limited to 2');
      await vi.waitFor(() => expect(api.openStreams).toBe(1));
      api.push({
        v: 1, type: 'request', id: 'req-allow-1', ts: Date.now(),
        payload: { method: 'shell.exec', params: { command: 'git status && curl https://example.com' }, workspaceId: 'ws-1', workspaceCwd: '/workspace' },
      });
      await vi.waitFor(() => expect(api.envelopes.some((e) => e.type === 'response' && e.id === 'req-allow-1')).toBe(true));
      const response = api.envelopes.find((e) => e.type === 'response' && e.id === 'req-allow-1');
      expect(response.payload.ok).toBe(false);
      expect(response.payload.error.message).toMatch(/not in allowBinaries: curl/);
    } finally {
      await daemon.shutdown();
      outSpy.mockRestore();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('refuses to start, without spending the token, on an allowlist it cannot read', async () => {
    vi.resetModules();
    const { RunnerDaemon } = await import('../src/daemon.js');
    const { EnrollmentError: FreshEnrollmentError } = await import('../src/enroll.js');
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const prepare = vi.fn();
    try {
      const err = await new RunnerDaemon()
        .startEnrolled({
          env: { ALMYTY_ENROLLMENT_TOKEN: FAKE_TOKEN, ALMYTY_API_URL: api.url, ALMYTY_ALLOW_BINARIES: 'git,npm' },
          prepare, installSignals: false,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(FreshEnrollmentError);
      expect(err.message).toMatch(/ALMYTY_ALLOW_BINARIES/);
      expect(api.enrollBodies).toEqual([]);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      outSpy.mockRestore();
    }
  });
});
