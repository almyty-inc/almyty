import { spawn } from 'child_process';

// Generous on purpose: a timeout reports the binary as missing, so the
// backend never routes to it. gemini and aider take 1.2-1.4 s for
// `--version` on their own (a Node bundle and a Python import of litellm);
// probed alongside two dozen others in the runner-env image, 1.5 s missed
// gemini, and a one-CPU hosted pod under gVisor is slower still. A missing
// binary still answers at once (ENOENT), and a timeout ends the probe of
// that binary without trying the other flags. ALMYTY_PROBE_TIMEOUT_MS
// overrides it.
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/** The per-binary probe timeout: ALMYTY_PROBE_TIMEOUT_MS when it is a positive integer. */
export function probeTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number((env.ALMYTY_PROBE_TIMEOUT_MS ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PROBE_TIMEOUT_MS;
}

/**
 * Probe `binary --version` (or equivalent) with a tight timeout.
 * Returns the first non-empty line of stdout/stderr the binary emits,
 * or `null` if the binary is not on PATH or did not respond inside
 * the timeout. Some tools print version to stderr (cargo, rustc); we
 * accept output from either stream.
 *
 * The probe runs on a few binaries that don't accept --version (none
 * in the default list at the moment, but `aider` and others have
 * special-cased flags in the past). We pick a list of fallback flags
 * per-binary; if none of them produce output, we still return null
 * rather than mis-reporting the binary as missing.
 */
const VERSION_FLAGS_DEFAULT = ['--version', '-V', '-v', 'version'];
const PER_BINARY_FLAGS: Record<string, string[]> = {
  // gemini's CLI prints version on plain `gemini --version`, no special.
  // claude code prints version on `claude --version` since the
  // 1.0 stable release; older nightlies needed `--help`.
  // Keep the mapping empty until we hit a binary that needs an override.
};

export interface BinaryProbe {
  name: string;
  /**
   * Override the default exec function. Tests inject a stub that
   * returns canned stdout/stderr/exit without spawning a real
   * subprocess. Default implementation calls child_process.spawn.
   */
  exec?: ProbeExec;
}

export type ProbeExec = (
  bin: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;

export const realExec: ProbeExec = (bin, args) => {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // ENOENT or similar; surface as exit code 127 (command not found).
      resolve({ stdout: '', stderr: '', exitCode: 127, timedOut: false });
      return;
    }
    child.on('error', () => {
      resolve({ stdout: '', stderr: '', exitCode: 127, timedOut: false });
    });
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* */ }
    }, probeTimeoutMs());
    timer.unref?.();
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });
};

/**
 * Probe a single binary. Returns the version string (first line of
 * stdout or stderr) or `null` if absent. Empty output with exit 0 is
 * still treated as truthy presence — the binary is on PATH and exits
 * cleanly, so it counts; we report 'unknown' so the catalog reflects
 * presence even when version output is empty.
 */
export async function probe(name: string, execImpl: ProbeExec = realExec): Promise<string | null> {
  const flags = [...(PER_BINARY_FLAGS[name] ?? []), ...VERSION_FLAGS_DEFAULT];
  for (const flag of flags) {
    const result = await execImpl(name, [flag]);
    if (result.timedOut) return null;
    if (result.exitCode === 127) {
      // Command not found across all flags - try next, but this
      // usually fails for everything else too.
      return null;
    }
    const out = (result.stdout || result.stderr).trim();
    if (out.length > 0) {
      return firstLine(out);
    }
    if (result.exitCode === 0) {
      // Exited cleanly but said nothing. Treat as present-but-unknown.
      return 'unknown';
    }
    // Non-zero exit, no output: try next flag.
  }
  return null;
}

/**
 * Probe a list of binaries concurrently. Pass `probeFn` to share probes
 * with another caller (detectRuntimeInfo shares one memoized prober with
 * coding-agent detection, so no binary is spawned twice).
 */
export async function probeAll(
  names: string[],
  execImpl: ProbeExec = realExec,
  probeFn: (name: string) => Promise<string | null> = (n) => probe(n, execImpl),
): Promise<Record<string, string | null>> {
  const entries = await Promise.all(names.map(async n => [n, await probeFn(n)] as const));
  return Object.fromEntries(entries);
}

/**
 * A prober that runs each binary's probe at most once. The binary
 * catalog and the coding-agent detection ask about the same CLIs (every
 * coding CLI is in the default probe list too); probed separately, every
 * one of them was started twice at once. On a one-CPU hosted pod under
 * gVisor, where `aider --version` and `gemini --version` cost seconds of
 * CPU each, the duplicates roughly doubled the time to come online.
 */
export function memoizeProbe(execImpl: ProbeExec = realExec): (name: string) => Promise<string | null> {
  const seen = new Map<string, Promise<string | null>>();
  return (name) => {
    let p = seen.get(name);
    if (!p) {
      p = probe(name, execImpl);
      seen.set(name, p);
    }
    return p;
  };
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  return idx === -1 ? s : s.slice(0, idx);
}
