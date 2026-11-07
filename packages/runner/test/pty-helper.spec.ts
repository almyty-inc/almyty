import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  ensureSpawnHelperExecutable,
  explainPtySpawnError,
  nodePtyDir,
  spawnHelperPaths,
  type HelperFs,
} from '../src/pty-helper.js';
/**
 * node-pty 1.1.0 ships its macOS spawn-helper without the execute bit, so
 * every PTY spawn on a Mac failed with "posix_spawnp failed." and no
 * coding session could start, new or resumed.
 */
describe('node-pty spawn-helper', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function ptyDirWithHelper(mode: number, platform = 'darwin', arch = 'arm64'): { dir: string; helper: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pty-helper-'));
    dirs.push(dir);
    const helper = join(dir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
    mkdirSync(join(helper, '..'), { recursive: true });
    writeFileSync(helper, '#!/bin/sh\n');
    chmodSync(helper, mode);
    return { dir, helper };
  }

  it('makes a helper installed as rw-r--r-- executable, rwxr-xr-x', () => {
    const { dir, helper } = ptyDirWithHelper(0o644);
    const result = ensureSpawnHelperExecutable(dir, undefined, 'darwin', 'arm64');
    expect(result).toEqual({ fixed: [helper], failed: [] });
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('leaves a helper that is already executable alone', () => {
    const { dir, helper } = ptyDirWithHelper(0o755);
    expect(ensureSpawnHelperExecutable(dir, undefined, 'darwin', 'arm64')).toEqual({ fixed: [], failed: [] });
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('looks at node-pty\'s own build first, then the prebuild for the platform', () => {
    expect(spawnHelperPaths('/m/node-pty', 'darwin', 'x64')).toEqual([
      '/m/node-pty/build/Release/spawn-helper',
      '/m/node-pty/prebuilds/darwin-x64/spawn-helper',
    ]);
  });

  it('does nothing on Windows, which has no helper', () => {
    expect(spawnHelperPaths('/m/node-pty', 'win32', 'x64')).toEqual([]);
  });

  it('reports a helper it cannot change, and the spawn error then says what to run', () => {
    const fs: HelperFs = {
      exists: () => true,
      isExecutable: () => false,
      mode: () => 0o644,
      chmod: () => { throw new Error('EACCES'); },
    };
    const { failed } = ensureSpawnHelperExecutable('/ro/node-pty', fs, 'darwin', 'arm64');
    expect(failed).toEqual(['/ro/node-pty/build/Release/spawn-helper', '/ro/node-pty/prebuilds/darwin-arm64/spawn-helper']);
    const err = explainPtySpawnError(new Error('posix_spawnp failed.'), failed);
    expect(err.message).toContain('chmod +x /ro/node-pty/build/Release/spawn-helper');
    expect(explainPtySpawnError(new Error('ENOENT'), failed).message).toBe('ENOENT');
  });

  it('finds the installed node-pty', () => {
    expect(nodePtyDir()).toMatch(/node-pty$/);
  });

});
