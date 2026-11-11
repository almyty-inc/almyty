import { accessSync, chmodSync, constants, existsSync, statSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

/**
 * node-pty starts every PTY child on macOS through a small `spawn-helper`
 * binary it ships next to `pty.node`. node-pty 1.1.0 publishes that helper
 * without its execute bit (prebuilds/darwin-*), and npm installs it as it
 * is, so on a Mac every PTY spawn failed with "posix_spawnp failed." --
 * process.spawn, agent.spawn and coding.start alike: no Claude Code or
 * Codex session, cold or resumed, could start. shell.exec, which does not
 * use a PTY, was unaffected.
 *
 * Before the first PTY spawn the runner makes the helper executable for
 * its owner and everyone who may read it. A helper it cannot change (a
 * read-only install) is left alone, and the spawn's own error says what
 * to run.
 */

export interface HelperFs {
  exists(path: string): boolean;
  isExecutable(path: string): boolean;
  mode(path: string): number;
  chmod(path: string, mode: number): void;
}

const realFs: HelperFs = {
  exists: existsSync,
  isExecutable: (p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  mode: (p) => statSync(p).mode & 0o7777,
  chmod: chmodSync,
};

/** Where node-pty keeps the helper for this platform: its own build, then the prebuild. */
export function spawnHelperPaths(ptyDir: string, platform: string = process.platform, arch: string = process.arch): string[] {
  if (platform === 'win32') return [];
  return [
    join(ptyDir, 'build', 'Release', 'spawn-helper'),
    join(ptyDir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
  ];
}

/** node-pty's folder, or null when it cannot be found. */
export function nodePtyDir(): string | null {
  try {
    return dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return null;
  }
}

/**
 * Make each spawn-helper that exists executable. Returns the paths it
 * changed and the ones it could not; does nothing on Windows (no helper).
 */
export function ensureSpawnHelperExecutable(
  ptyDir: string | null = nodePtyDir(),
  fs: HelperFs = realFs,
  platform: string = process.platform,
  arch: string = process.arch,
): { fixed: string[]; failed: string[] } {
  const fixed: string[] = [];
  const failed: string[] = [];
  if (!ptyDir) return { fixed, failed };
  for (const path of spawnHelperPaths(ptyDir, platform, arch)) {
    if (!fs.exists(path) || fs.isExecutable(path)) continue;
    try {
      const mode = fs.mode(path);
      // Execute wherever there is read: rw-r--r-- becomes rwxr-xr-x.
      fs.chmod(path, mode | ((mode & 0o444) >> 2));
      fixed.push(path);
    } catch {
      failed.push(path);
    }
  }
  return { fixed, failed };
}

/** The spawn error, with what to do when it is the helper's missing execute bit. */
export function explainPtySpawnError(err: unknown, failed: string[]): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/posix_spawnp failed/i.test(message) && failed.length) {
    return new Error(`${message} node-pty's spawn-helper is not executable and the runner could not change it; run: chmod +x ${failed.join(' ')}`);
  }
  return err instanceof Error ? err : new Error(message);
}
