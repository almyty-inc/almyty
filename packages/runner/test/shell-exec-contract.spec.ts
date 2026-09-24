import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ProcessManager } from '../src/process-manager.js';
import { dispatchHandler, type HandlerContext } from '../src/handlers.js';
import { RUNNER_ERROR_CODES } from '../src/types.js';

/**
 * shell.exec as the backend actually calls it.
 *
 * The tool the backend publishes for this method
 * (runner-capability.publisher.ts) takes `command`, plus a `cwd`
 * "relative to the workspace root". The handler read `cmd` and ignored
 * `cwd` entirely, so every call through the published tool failed with
 * "cmd is required" -- and a call that did get through ran in the
 * daemon's own working directory, past `allowedCwdRoots`, which the
 * policy only ever applied to process.spawn.
 */
function ctx(allowedCwdRoots: string[] = []): HandlerContext {
  return {
    processes: new ProcessManager({ spawnPty: async () => { throw new Error('unused'); }, spawnPipe: async () => { throw new Error('unused'); } } as any, 1),
    runnerName: 'r1',
    labels: {},
    maxConcurrent: 1,
    config: {
      defaultIsolation: 'host',
      maxConcurrent: 1,
      allowedCwdRoots,
      denyPatterns: [],
      networkBlocked: false,
      installBlocked: false,
    },
  };
}

describe('shell.exec with the published parameters', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runner-shell-')));
  const workspace = join(root, 'ws');
  mkdirSync(join(workspace, 'sub'), { recursive: true });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'runner-outside-')));

  it('runs `command`', async () => {
    const resp = await dispatchHandler(ctx(), {
      method: 'shell.exec',
      workspaceId: 'ws-1',
      params: { command: 'echo hi' },
    });
    expect(resp.ok).toBe(true);
    expect((resp.result as any).stdout).toBe('hi\n');
  });

  it('runs in the workspace root by default', async () => {
    const resp = await dispatchHandler(ctx([root]), {
      method: 'shell.exec',
      workspaceId: 'ws-1',
      workspaceCwd: workspace,
      params: { command: 'pwd -P' },
    });
    expect(resp.ok).toBe(true);
    expect((resp.result as any).stdout.trim()).toBe(workspace);
  });

  it('resolves `cwd` relative to the workspace root', async () => {
    const resp = await dispatchHandler(ctx([root]), {
      method: 'shell.exec',
      workspaceId: 'ws-1',
      workspaceCwd: workspace,
      params: { command: 'pwd -P', cwd: 'sub' },
    });
    expect(resp.ok).toBe(true);
    expect((resp.result as any).stdout.trim()).toBe(join(workspace, 'sub'));
  });

  it('refuses a `cwd` that climbs outside allowedCwdRoots', async () => {
    const resp = await dispatchHandler(ctx([root]), {
      method: 'shell.exec',
      workspaceId: 'ws-1',
      workspaceCwd: workspace,
      params: { command: 'pwd', cwd: outside },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.data).toMatchObject({ code: RUNNER_ERROR_CODES.PATH_DENIED });
  });

  it('refuses to run in the daemon\'s own directory when allowedCwdRoots is set and no cwd is known', async () => {
    const resp = await dispatchHandler(ctx([root]), {
      method: 'shell.exec',
      workspaceId: 'ws-1',
      params: { command: 'pwd' },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.data).toMatchObject({ code: RUNNER_ERROR_CODES.PATH_DENIED });
  });
});
