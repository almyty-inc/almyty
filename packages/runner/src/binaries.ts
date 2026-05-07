import { spawn } from 'child_process';

const VERSION_TIMEOUT_MS = 1500;

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
    }, VERSION_TIMEOUT_MS);
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
 * Probe a list of binaries concurrently. Bounded by the OS subprocess
 * cap implicitly; in practice a 15-binary probe finishes well under
 * a second on macOS/Linux.
 */
export async function probeAll(
  names: string[],
  execImpl: ProbeExec = realExec,
): Promise<Record<string, string | null>> {
  const entries = await Promise.all(names.map(async n => [n, await probe(n, execImpl)] as const));
  return Object.fromEntries(entries);
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  return idx === -1 ? s : s.slice(0, idx);
}
