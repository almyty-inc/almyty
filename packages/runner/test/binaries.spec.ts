import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { probe, probeAll, realExec, type ProbeExec } from '../src/binaries.js';

/**
 * Binary probe behavior. The execImpl injection point lets us cover
 * each branch (missing, present-with-stdout, present-with-stderr,
 * empty-but-exit-zero, timeout) without spawning real subprocesses.
 */
describe('probe', () => {
  it('returns null when the binary is not on PATH (exit 127)', async () => {
    const exec: ProbeExec = async () =>
      ({ stdout: '', stderr: '', exitCode: 127, timedOut: false });
    expect(await probe('nonesuch', exec)).toBeNull();
  });

  it('returns the first line of stdout for normal --version output', async () => {
    const exec: ProbeExec = async () =>
      ({ stdout: 'v20.18.0\n  more details\n', stderr: '', exitCode: 0, timedOut: false });
    expect(await probe('node', exec)).toBe('v20.18.0');
  });

  it('falls back to stderr when stdout is empty (cargo / rustc style)', async () => {
    const exec: ProbeExec = async () =>
      ({ stdout: '', stderr: 'cargo 1.79.0 (something)\n', exitCode: 0, timedOut: false });
    expect(await probe('cargo', exec)).toBe('cargo 1.79.0 (something)');
  });

  it("returns 'unknown' when binary exits 0 but emits no output", async () => {
    const exec: ProbeExec = async () =>
      ({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
    expect(await probe('weird', exec)).toBe('unknown');
  });

  it('returns null when every flag attempt times out', async () => {
    const exec: ProbeExec = async () =>
      ({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    expect(await probe('hangy', exec)).toBeNull();
  });

  it('tries multiple version flags before giving up', async () => {
    let calls = 0;
    const exec: ProbeExec = async (_bin, args) => {
      calls++;
      if (args[0] === '--version') {
        return { stdout: '', stderr: '', exitCode: 1, timedOut: false };
      }
      if (args[0] === '-V') {
        return { stdout: 'tool 1.2.3', stderr: '', exitCode: 0, timedOut: false };
      }
      return { stdout: '', stderr: '', exitCode: 1, timedOut: false };
    };
    expect(await probe('tool', exec)).toBe('tool 1.2.3');
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('probeAll', () => {
  it('runs probes in parallel and returns the full map', async () => {
    const exec: ProbeExec = async (bin) => {
      if (bin === 'node') return { stdout: 'v20.0.0', stderr: '', exitCode: 0, timedOut: false };
      if (bin === 'git') return { stdout: 'git version 2.47.0', stderr: '', exitCode: 0, timedOut: false };
      return { stdout: '', stderr: '', exitCode: 127, timedOut: false };
    };
    const result = await probeAll(['node', 'git', 'absent'], exec);
    expect(result).toEqual({
      node: 'v20.0.0',
      git: 'git version 2.47.0',
      absent: null,
    });
  });
});

describe('detectRuntimeInfo probes each binary once', () => {
  it('shares one probe per binary between the catalog and coding-agent detection', async () => {
    const { detectRuntimeInfo } = await import('../src/runtime-info.js');
    const { DEFAULT_BINARY_PROBE_LIST } = await import('../src/config.js');
    const starts = new Map<string, number>();
    const exec: ProbeExec = async (bin) => {
      starts.set(bin, (starts.get(bin) ?? 0) + 1);
      if (bin === 'claude' || bin === 'aider') return { stdout: `${bin} 1.0.0\n`, stderr: '', exitCode: 0, timedOut: false };
      return { stdout: '', stderr: '', exitCode: 127, timedOut: false };
    };
    const info = await detectRuntimeInfo({ binaries: DEFAULT_BINARY_PROBE_LIST, exec });
    // Every coding CLI is in both lists; each was started twice at once.
    const twice = [...starts].filter(([, n]) => n > 1).map(([b]) => b);
    expect(twice).toEqual([]);
    expect(info.binaries.claude).toBe('claude 1.0.0');
    expect(info.codingAgents.map((a) => a.id).sort()).toEqual(['aider', 'claude']);
  });
});

describe('probeTimeoutMs', () => {
  it('defaults to 10 s and takes ALMYTY_PROBE_TIMEOUT_MS when it is a positive integer', async () => {
    const { probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS } = await import('../src/binaries.js');
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(10_000);
    expect(probeTimeoutMs({})).toBe(10_000);
    expect(probeTimeoutMs({ ALMYTY_PROBE_TIMEOUT_MS: '3000' })).toBe(3000);
    expect(probeTimeoutMs({ ALMYTY_PROBE_TIMEOUT_MS: '0' })).toBe(10_000);
    expect(probeTimeoutMs({ ALMYTY_PROBE_TIMEOUT_MS: 'soon' })).toBe(10_000);
  });
});

/**
 * The real probe against binaries that leave a child holding stdout, the
 * way the mise shims for python/pip did in the gate's fresh HOME: the
 * shim was killed at the timeout, its child kept the pipe, and `runner
 * start` sat after "starting" without registering for as long as that
 * child lived. Each case here waited the child's 30 s before the fix.
 */
describe.skipIf(process.platform === 'win32')('realExec bounds the whole probe', () => {
  let dir = '';
  let savedTimeout: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runner-probe-'));
    savedTimeout = process.env.ALMYTY_PROBE_TIMEOUT_MS;
  });
  afterEach(() => {
    if (savedTimeout === undefined) delete process.env.ALMYTY_PROBE_TIMEOUT_MS;
    else process.env.ALMYTY_PROBE_TIMEOUT_MS = savedTimeout;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A script that starts `sleep 30` sharing its stdout, records its pid, then runs `rest`. */
  function script(name: string, rest: string): { bin: string; childPid: () => number } {
    const bin = join(dir, name);
    const pidFile = join(dir, `${name}.pid`);
    writeFileSync(bin, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\n${rest}\n`);
    chmodSync(bin, 0o755);
    return { bin, childPid: () => Number(readFileSync(pidFile, 'utf-8').trim()) };
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('settles at the timeout and kills what the hung binary started', async () => {
    const { bin, childPid } = script('hangs', 'sleep 30');
    // Long enough for the script to have started its child before the kill.
    process.env.ALMYTY_PROBE_TIMEOUT_MS = '1500';
    const t0 = Date.now();
    const result = await realExec(bin, ['--version']);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4_000);
    const pid = childPid();
    await expect.poll(() => alive(pid), { timeout: 2_000 }).toBe(false);
  }, 15_000);

  it('returns the version once the binary exits, without waiting for a child still holding stdout', async () => {
    const { bin, childPid } = script('answers', "echo 'tool 1.2.3'\nexit 0");
    process.env.ALMYTY_PROBE_TIMEOUT_MS = '20000';
    const t0 = Date.now();
    expect(await probe(bin, realExec)).toBe('tool 1.2.3');
    expect(Date.now() - t0).toBeLessThan(3_000);
    process.kill(childPid(), 'SIGKILL');
  });
});
