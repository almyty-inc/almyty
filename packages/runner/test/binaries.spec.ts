import { describe, it, expect } from 'vitest';

import { probe, probeAll, type ProbeExec } from '../src/binaries.js';

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
