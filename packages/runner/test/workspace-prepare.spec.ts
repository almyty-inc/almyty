import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ProcessManager } from '../src/process-manager.js';
import { dispatchHandler, workspaceFolderRoot, type HandlerContext } from '../src/handlers.js';
import type { RunnerConfig } from '../src/types.js';

/**
 * `workspace.prepare`: the backend asks the runner for a folder when an
 * agent run needs a workspace and has none. The runner decides where it
 * goes (it alone knows its home and cwd roots), makes it, and answers the
 * absolute path the backend then records as the workspace's cwd.
 */
const HOST: RunnerConfig = {
  defaultIsolation: 'host',
  maxConcurrent: 4,
  allowedCwdRoots: [],
  denyPatterns: [],
  networkBlocked: false,
  installBlocked: true,
};

let scratch: string;
let ctx: HandlerContext;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ws-prepare-')));
  ctx = {
    processes: new ProcessManager({ spawnPty: async () => { throw new Error('no'); }, spawnPipe: async () => { throw new Error('no'); } }, 4),
    runnerName: 'r1',
    labels: {},
    maxConcurrent: 4,
    config: { ...HOST },
    workspacesRoot: join(scratch, 'workspaces'),
  };
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const prepare = (name: unknown) => dispatchHandler(ctx, { method: 'workspace.prepare', params: { name } });

describe('workspace.prepare', () => {
  it('makes the folder and answers its absolute path', async () => {
    const resp = await prepare('support-bot-1a2b3c4d');
    expect(resp.ok).toBe(true);
    const cwd = (resp.result as { cwd: string }).cwd;
    expect(cwd).toBe(join(scratch, 'workspaces', 'support-bot-1a2b3c4d'));
    expect(statSync(cwd).isDirectory()).toBe(true);
  });

  it('is idempotent: the same name is the same folder, files kept', async () => {
    const first = (await prepare('agent-run')).result as { cwd: string };
    writeFileSync(join(first.cwd, 'notes.txt'), 'kept');
    const again = await prepare('agent-run');
    expect(again.ok).toBe(true);
    expect((again.result as { cwd: string }).cwd).toBe(first.cwd);
    expect(statSync(join(first.cwd, 'notes.txt')).isFile()).toBe(true);
  });

  it.each(['../escape', 'a/b', 'UPPER', '', '-lead', 'x'.repeat(81)])('refuses a path-like or malformed name %j', async (name) => {
    const resp = await prepare(name);
    expect(resp.ok).toBe(false);
  });

  it('holds the folder to allowedCwdRoots', async () => {
    ctx.config = { ...HOST, allowedCwdRoots: [join(scratch, 'allowed')] };
    const resp = await prepare('outside');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('allowedCwdRoots');
  });

  it('refuses when the runner refuses every command (container isolation)', async () => {
    ctx.config = { ...HOST, defaultIsolation: 'container' };
    const resp = await prepare('any');
    expect(resp.ok).toBe(false);
  });
});

describe('workspaceFolderRoot', () => {
  it('goes under the first allowed root when roots are configured', () => {
    expect(workspaceFolderRoot({ ...HOST, allowedCwdRoots: ['/srv/work', '/tmp'] }, '/home/me')).toBe('/srv/work/almyty-workspaces');
  });

  it('goes under ~/.almyty/workspaces otherwise', () => {
    expect(workspaceFolderRoot(HOST, '/home/me')).toBe('/home/me/.almyty/workspaces');
  });

  it('the default folder passes the root check when the first root is used', async () => {
    const root = join(scratch, 'allowed');
    ctx.config = { ...HOST, allowedCwdRoots: [root] };
    ctx.workspacesRoot = undefined;
    const resp = await prepare('inside');
    expect(resp.ok).toBe(true);
    expect((resp.result as { cwd: string }).cwd).toBe(join(root, 'almyty-workspaces', 'inside'));
  });
});
