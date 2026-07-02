import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { homedir } from 'os';

import {
  ProcessManager,
  type AdapterFactory,
  type ProcessAdapter,
} from '../src/process-manager.js';
import { dispatchHandler, type HandlerContext } from '../src/handlers.js';
import { CodingSessionManager, type CodingEventPayload } from '../src/coding-sessions.js';
import type { ProbeExec } from '../src/binaries.js';

/**
 * coding.* surface: the runner half of the chat-to-runner bridge. Sessions
 * spawn via the platform's spawn-spec (mock adapters, no real subprocess),
 * output chunks stream out as coding.output events, input lands on stdin,
 * stop signals the child.
 */
type FakeAdapter = ProcessAdapter & {
  emitData(s: string): void;
  emitExit(info: any): void;
  written: string[];
  killed: string[];
};

function fakeAdapter(): FakeAdapter {
  const e = new EventEmitter() as any;
  e.pid = 1;
  e.written = [];
  e.killed = [];
  e.write = (d: string) => e.written.push(d);
  e.kill = (sig: string) => e.killed.push(sig);
  e.closeInput = () => {};
  e.emitData = (s: string) => e.emit('data', s);
  e.emitExit = (info: any) => e.emit('exit', info);
  return e;
}

/** Probe stub: claude + codex installed, everything else missing. */
const probeExec: ProbeExec = async (bin) => {
  if (bin === 'claude') return { stdout: '2.1.0', stderr: '', exitCode: 0, timedOut: false };
  if (bin === 'codex') return { stdout: '1.4.2', stderr: '', exitCode: 0, timedOut: false };
  return { stdout: '', stderr: '', exitCode: 127, timedOut: false };
};

describe('coding.* handlers', () => {
  let processes: ProcessManager;
  let coding: CodingSessionManager;
  let ctx: HandlerContext;
  let lastAdapter: FakeAdapter;
  let lastSpawnOpts: any;
  let events: CodingEventPayload[];

  beforeEach(() => {
    events = [];
    const factory: AdapterFactory = {
      spawnPty: async (opts) => { lastSpawnOpts = opts; return (lastAdapter = fakeAdapter()); },
      spawnPipe: async (opts) => { lastSpawnOpts = opts; return (lastAdapter = fakeAdapter()); },
    };
    processes = new ProcessManager(factory, 4);
    coding = new CodingSessionManager(processes, (p) => events.push(p));
    ctx = {
      processes,
      coding,
      probeExec,
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

  async function start(params: Record<string, unknown> = {}) {
    return dispatchHandler(ctx, {
      method: 'coding.start',
      params: { agent: 'claude', task: 'fix the login bug', ...params },
    });
  }

  it('coding.list returns only the installed CLIs from the registry probe', async () => {
    const resp = await dispatchHandler(ctx, { method: 'coding.list', params: {} });
    expect(resp.ok).toBe(true);
    const ids = (resp.result as any).agents.map((a: any) => a.id).sort();
    expect(ids).toEqual(['claude', 'codex']);
    const claude = (resp.result as any).agents.find((a: any) => a.id === 'claude');
    expect(claude.version).toBe('2.1.0');
  });

  it('coding.start spawns per spawn-spec: auto-approve args, task as final arg, pipe mode', async () => {
    const resp = await start();
    expect(resp.ok).toBe(true);
    const r = resp.result as any;
    expect(r.sessionId).toMatch(/^cs_/);
    expect(r.agent).toBe('claude');
    expect(r.binary).toBe('claude');
    expect(r.status).toBe('running');
    expect(r.cwd).toBe(homedir()); // default cwd
    expect(lastSpawnOpts.binary).toBe('claude');
    expect(lastSpawnOpts.args).toContain('--dangerously-skip-permissions');
    expect(lastSpawnOpts.args[lastSpawnOpts.args.length - 1]).toBe('fix the login bug');
    expect(lastSpawnOpts.pty).toBe(false); // line-based stdio v1, no PTY
  });

  it('coding.start honors an explicit cwd and model pin', async () => {
    const resp = await start({ cwd: '/tmp/repo', model: 'opus' });
    expect((resp.result as any).cwd).toBe('/tmp/repo');
    expect(lastSpawnOpts.cwd).toBe('/tmp/repo');
    expect(lastSpawnOpts.args).toContain('--model');
    expect(lastSpawnOpts.args).toContain('opus');
  });

  it('coding.start rejects unknown agents and missing tasks', async () => {
    const bad = await dispatchHandler(ctx, {
      method: 'coding.start',
      params: { agent: 'not-a-cli', task: 'x' },
    });
    expect(bad.ok).toBe(false);
    const noTask = await dispatchHandler(ctx, {
      method: 'coding.start',
      params: { agent: 'claude' },
    });
    expect(noTask.ok).toBe(false);
  });

  it('output chunks are ANSI-stripped and emitted as coding.output events', async () => {
    const resp = await start();
    const sessionId = (resp.result as any).sessionId;

    lastAdapter.emitData('\x1b[1mreading\x1b[0m files...\n');
    lastAdapter.emitData('done\n');

    const output = events.filter((e) => e.kind === 'coding.output') as any[];
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({ sessionId, agent: 'claude', data: 'reading files...\n', seq: 1 });
    expect(output[1]).toMatchObject({ data: 'done\n', seq: 2 });
  });

  it('coding.input writes the line (newline-terminated) to stdin', async () => {
    const resp = await start();
    const sessionId = (resp.result as any).sessionId;

    const input = await dispatchHandler(ctx, {
      method: 'coding.input',
      params: { sessionId, data: 'yes, proceed' },
    });
    expect(input.ok).toBe(true);
    expect(lastAdapter.written).toEqual(['yes, proceed\n']);
  });

  it('coding.status reports one session or lists all', async () => {
    const resp = await start();
    const sessionId = (resp.result as any).sessionId;

    const one = await dispatchHandler(ctx, { method: 'coding.status', params: { sessionId } });
    expect((one.result as any).status).toBe('running');
    expect((one.result as any).sessionId).toBe(sessionId);

    const all = await dispatchHandler(ctx, { method: 'coding.status', params: {} });
    expect((all.result as any).sessions).toHaveLength(1);
  });

  it('coding.stop signals TERM (KILL with force) and exit emits coding.exit', async () => {
    const resp = await start();
    const sessionId = (resp.result as any).sessionId;

    const stop = await dispatchHandler(ctx, { method: 'coding.stop', params: { sessionId } });
    expect(stop.ok).toBe(true);
    expect(lastAdapter.killed).toEqual(['SIGTERM']);

    lastAdapter.emitExit({ exitCode: null, signal: 'SIGTERM' });
    const exit = events.find((e) => e.kind === 'coding.exit') as any;
    expect(exit).toMatchObject({ sessionId, agent: 'claude', signal: 'SIGTERM' });

    // Second stop after exit is idempotent (no further signal).
    const again = await dispatchHandler(ctx, { method: 'coding.stop', params: { sessionId } });
    expect(again.ok).toBe(true);
    expect(lastAdapter.killed).toEqual(['SIGTERM']);
    expect((again.result as any).status).toBe('killed');
  });

  it('coding.input after exit fails with a typed error', async () => {
    const resp = await start();
    const sessionId = (resp.result as any).sessionId;
    lastAdapter.emitExit({ exitCode: 0, signal: null });

    const input = await dispatchHandler(ctx, {
      method: 'coding.input',
      params: { sessionId, data: 'hello' },
    });
    expect(input.ok).toBe(false);
    expect((input.error?.data as any)?.code).toBe('process_already_exited');
  });

  it('unknown session ids fail loudly', async () => {
    const resp = await dispatchHandler(ctx, {
      method: 'coding.status',
      params: { sessionId: 'cs_nope' },
    });
    expect(resp.ok).toBe(false);
  });

  it('multiple concurrent sessions stream independently', async () => {
    const first = await start();
    const firstAdapter = lastAdapter;
    const second = await start({ agent: 'codex', task: 'write tests' });
    const s1 = (first.result as any).sessionId;
    const s2 = (second.result as any).sessionId;
    expect(s1).not.toBe(s2);

    firstAdapter.emitData('from one\n');
    lastAdapter.emitData('from two\n');

    const output = events.filter((e) => e.kind === 'coding.output') as any[];
    expect(output.map((e) => [e.sessionId, e.data])).toEqual([
      [s1, 'from one\n'],
      [s2, 'from two\n'],
    ]);
  });

  it('coding.* without a wired manager returns a structured error', async () => {
    ctx.coding = undefined;
    const resp = await dispatchHandler(ctx, {
      method: 'coding.start',
      params: { agent: 'claude', task: 'x' },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('not available');
  });

  it('execution policy applies to coding.start (denied binary refuses to spawn)', async () => {
    ctx.config = { ...ctx.config, denyPatterns: ['claude'] };
    const spy = vi.fn();
    const resp = await start();
    expect(resp.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    // Nothing spawned, nothing registered.
    const all = await dispatchHandler(ctx, { method: 'coding.status', params: {} });
    expect((all.result as any).sessions).toHaveLength(0);
  });
});
