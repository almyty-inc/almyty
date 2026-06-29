import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import {
  ProcessManager,
  type AdapterFactory,
  type ProcessAdapter,
} from '../src/process-manager.js';
import { dispatchHandler, type HandlerContext } from '../src/handlers.js';

/**
 * agent.* surface: list the catalog, spawn a coding CLI with the platform's
 * spec (headless auth + config-dir isolation + auto-approve), and classify a
 * live pane non-destructively. The capturing factory hands us the adapter so we
 * can drive PTY output and assert the status classification.
 */
type FakeAdapter = ProcessAdapter & { emitData(s: string): void; emitExit(info: any): void };

function fakeAdapter(): FakeAdapter {
  const e = new EventEmitter() as any;
  e.pid = 1;
  e.write = () => {};
  e.kill = () => {};
  e.closeInput = () => {};
  e.emitData = (s: string) => e.emit('data', s);
  e.emitExit = (info: any) => e.emit('exit', info);
  return e;
}

describe('agent.* handlers', () => {
  let processes: ProcessManager;
  let ctx: HandlerContext;
  let lastAdapter: FakeAdapter;

  beforeEach(() => {
    const factory: AdapterFactory = {
      spawnPty: async () => (lastAdapter = fakeAdapter()),
      spawnPipe: async () => (lastAdapter = fakeAdapter()),
    };
    processes = new ProcessManager(factory, 4);
    ctx = {
      processes,
      runnerName: 'r1',
      labels: {},
      maxConcurrent: 4,
      config: {
        defaultIsolation: 'host',
        maxConcurrent: 4,
        allowedCwdRoots: [],
        denyPatterns: [],
        networkBlocked: false,
        installBlocked: false,
      },
    };
  });

  it('agent.list returns the platform catalog', async () => {
    const resp = await dispatchHandler(ctx, { method: 'agent.list', params: {} });
    expect(resp.ok).toBe(true);
    const ids = (resp.result as any).platforms.map((p: any) => p.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(ids).toContain('gemini');
  });

  it('agent.spawn builds the platform spec (auto-approve + key + config isolation)', async () => {
    const resp = await dispatchHandler(ctx, {
      method: 'agent.spawn',
      workspaceId: 'ws-1',
      params: { platform: 'claude', apiKey: 'sk-ant', configDir: '/tmp/m1' },
    });
    expect(resp.ok).toBe(true);
    const r = resp.result as any;
    expect(r.platform).toBe('claude');
    expect(r.binary).toBe('claude');
    expect(r.args).toContain('--dangerously-skip-permissions');
    expect(r.processId).toMatch(/^proc_/);

    const list = await dispatchHandler(ctx, { method: 'process.list', workspaceId: 'ws-1', params: {} });
    expect((list.result as any).processes).toHaveLength(1);
  });

  it('agent.spawn rejects an unknown platform', async () => {
    const resp = await dispatchHandler(ctx, {
      method: 'agent.spawn',
      workspaceId: 'ws-1',
      params: { platform: 'not-a-cli' },
    });
    expect(resp.ok).toBe(false);
  });

  it('agent.status classifies busy then idle from the live pane', async () => {
    const spawn = await dispatchHandler(ctx, {
      method: 'agent.spawn',
      workspaceId: 'ws-1',
      params: { platform: 'gemini', autoApprove: false },
    });
    const processId = (spawn.result as any).processId;

    lastAdapter.emitData('thinking hard...\n  esc to interrupt\n');
    let st = await dispatchHandler(ctx, {
      method: 'agent.status',
      workspaceId: 'ws-1',
      params: { processId },
    });
    expect(st.ok).toBe(true);
    expect((st.result as any).platform).toBe('gemini'); // resolved from binary
    expect((st.result as any).status).toBe('busy');

    // Real TUI repaints the frame from the top: cursor-home + erase-display,
    // then the idle prompt. The stale "esc to interrupt" frame is discarded.
    lastAdapter.emitData('\x1b[H\x1b[2Jall done\ngemini> ');
    st = await dispatchHandler(ctx, {
      method: 'agent.status',
      workspaceId: 'ws-1',
      params: { processId },
    });
    expect((st.result as any).status).toBe('idle');
  });

  it('agent.status reports exited once the pane is gone', async () => {
    const spawn = await dispatchHandler(ctx, {
      method: 'agent.spawn',
      workspaceId: 'ws-1',
      params: { platform: 'claude' },
    });
    const processId = (spawn.result as any).processId;
    lastAdapter.emitExit({ exitCode: 0, signal: null });
    const st = await dispatchHandler(ctx, {
      method: 'agent.status',
      workspaceId: 'ws-1',
      params: { processId },
    });
    expect((st.result as any).status).toBe('exited');
    expect((st.result as any).processStatus).toBe('exited');
  });
});
