import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunnerDaemon } from '../src/daemon.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@almyty/client', () => ({
  resolveCredentialsOrExit: () => ({ token: 'local-test', url: 'http://127.0.0.1:43219', organizationId: 'chosen-org' }),
}));
vi.mock('../src/runtime-info.js', () => ({
  RUNNER_VERSION: 'test',
  detectRuntimeInfo: async () => ({ hostname: 'studio.local', binaries: {} }),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('runner registration from shared login', () => {
  it('uses the login organization and API URL and lets the server keep a renamed runner', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'test stops before connecting' });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new RunnerDaemon().start({})).rejects.toThrow('register failed');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:43219/runners/register');
    expect(options.headers['X-Organization-Id']).toBe('chosen-org');
    expect(JSON.parse(options.body)).not.toHaveProperty('name');
    expect(JSON.parse(options.body).runtimeInfo.hostname).toBe('studio.local');
  });
  it('sends an explicitly chosen name and organization override', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'test stops before connecting' });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new RunnerDaemon().start({ name: 'custom', organizationId: 'override-org' })).rejects.toThrow('register failed');
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body).name).toBe('custom');
    expect(options.headers['X-Organization-Id']).toBe('override-org');
  });
});

describe('isolated daemon state', () => {
  it('reads only the explicitly selected state directory', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'almyty-runner-state-test-'));
    try {
      vi.stubEnv('ALMYTY_RUNNER_STATE_DIR', stateDir);
      vi.resetModules();
      writeFileSync(join(stateDir, 'status.json'), JSON.stringify({ pid: process.pid, runnerName: 'test-runner' }));
      const { readStatus } = await import('../src/daemon.js');
      expect(readStatus()?.runnerName).toBe('test-runner');
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});
