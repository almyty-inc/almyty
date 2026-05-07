import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import {
  ProcessManager,
  type AdapterFactory,
  type ProcessAdapter,
} from '../src/process-manager.js';
import { RUNNER_ERROR_CODES, RunnerError } from '../src/types.js';

/**
 * In-memory fake adapter that lets us assert exactly what the manager
 * forwards. emit('data', text) simulates child output; emit('exit', ...)
 * simulates the process exiting.
 */
function makeFake(): ProcessAdapter & {
  writes: string[]; closed: boolean; signals: string[]; emitData(s: string): void; emitExit(info: { exitCode: number | null; signal: string | null }): void;
} {
  const e = new EventEmitter() as any;
  e.pid = 1234;
  e.writes = [];
  e.closed = false;
  e.signals = [];
  e.write = (data: string) => { e.writes.push(data); };
  e.kill = (sig?: string) => { e.signals.push(sig ?? 'SIGTERM'); };
  e.closeInput = () => { e.closed = true; };
  e.emitData = (s: string) => { e.emit('data', s); };
  e.emitExit = (info: { exitCode: number | null; signal: string | null }) => { e.emit('exit', info); };
  return e;
}

function makeFactory(fakes: Map<string, ReturnType<typeof makeFake>>): AdapterFactory {
  return {
    spawnPty: async (opts) => {
      const f = makeFake();
      fakes.set(`pty:${opts.binary}`, f);
      return f;
    },
    spawnPipe: async (opts) => {
      const f = makeFake();
      fakes.set(`pipe:${opts.binary}`, f);
      return f;
    },
  };
}

describe('ProcessManager', () => {
  let fakes: Map<string, ReturnType<typeof makeFake>>;
  let factory: AdapterFactory;
  let mgr: ProcessManager;

  beforeEach(() => {
    fakes = new Map();
    factory = makeFactory(fakes);
    mgr = new ProcessManager(factory, /* maxConcurrent */ 3);
  });

  // ── spawn / read / write / signal ──────────────────────────────────

  it('spawn defaults to PTY', async () => {
    await mgr.spawn('ws-1', { binary: 'echo', args: ['hi'] });
    expect(fakes.has('pty:echo')).toBe(true);
    expect(fakes.has('pipe:echo')).toBe(false);
  });

  it('pty:false routes through pipe spawn', async () => {
    await mgr.spawn('ws-1', { binary: 'cat', args: [], pty: false });
    expect(fakes.has('pipe:cat')).toBe(true);
  });

  it('read drains the buffer between calls', async () => {
    const h = await mgr.spawn('ws-1', { binary: 'echo', args: [] });
    const f = fakes.get('pty:echo')!;
    f.emitData('hello\n');
    f.emitData('world\n');
    expect(mgr.read('ws-1', h.processId).data).toBe('hello\nworld\n');
    // Subsequent read with no new data returns empty.
    expect(mgr.read('ws-1', h.processId).data).toBe('');
    f.emitData('again\n');
    expect(mgr.read('ws-1', h.processId).data).toBe('again\n');
  });

  it('write forwards to the adapter; close_input sends EOF', async () => {
    const h = await mgr.spawn('ws-1', { binary: 'cat', args: [] });
    const f = fakes.get('pty:cat')!;
    mgr.write('ws-1', h.processId, 'line\n');
    expect(f.writes).toEqual(['line\n']);
    mgr.closeInput('ws-1', h.processId);
    expect(f.closed).toBe(true);
  });

  it('signal maps TERM, INT, KILL to SIG-prefixed names', async () => {
    const h = await mgr.spawn('ws-1', { binary: 'sleep', args: ['9999'] });
    const f = fakes.get('pty:sleep')!;
    mgr.signal('ws-1', h.processId, 'TERM');
    mgr.signal('ws-1', h.processId, 'INT');
    mgr.signal('ws-1', h.processId, 'KILL');
    expect(f.signals).toEqual(['SIGTERM', 'SIGINT', 'SIGKILL']);
  });

  it('write on an exited process throws PROCESS_ALREADY_EXITED', async () => {
    const h = await mgr.spawn('ws-1', { binary: 'echo', args: ['hi'] });
    const f = fakes.get('pty:echo')!;
    f.emitExit({ exitCode: 0, signal: null });
    expect(() => mgr.write('ws-1', h.processId, 'x'))
      .toThrow(/already exited/);
  });

  // ── Resource scoping (the audit-grade test) ─────────────────────────

  it('cross-workspace read throws PROCESS_CROSS_WORKSPACE', async () => {
    const h = await mgr.spawn('ws-A', { binary: 'echo', args: [] });
    expect(() => mgr.read('ws-B', h.processId)).toThrow(RunnerError);
    try {
      mgr.read('ws-B', h.processId);
    } catch (err: any) {
      expect(err.code).toBe(RUNNER_ERROR_CODES.PROCESS_CROSS_WORKSPACE);
    }
  });

  it('unknown process_id throws PROCESS_NOT_FOUND', () => {
    expect(() => mgr.read('ws-1', 'no-such-process')).toThrow(/unknown process/);
  });

  // ── Capacity ───────────────────────────────────────────────────────

  it('refuses spawn at maxConcurrent capacity', async () => {
    await mgr.spawn('ws', { binary: 'a', args: [] });
    await mgr.spawn('ws', { binary: 'b', args: [] });
    await mgr.spawn('ws', { binary: 'c', args: [] });
    await expect(mgr.spawn('ws', { binary: 'd', args: [] }))
      .rejects.toThrow(/at capacity/);
  });

  it('exited processes free capacity', async () => {
    const h = await mgr.spawn('ws', { binary: 'a', args: [] });
    await mgr.spawn('ws', { binary: 'b', args: [] });
    await mgr.spawn('ws', { binary: 'c', args: [] });
    const f = fakes.get('pty:a')!;
    f.emitExit({ exitCode: 0, signal: null });
    // After exit, a 4th spawn fits because only 2 are still "running".
    await expect(mgr.spawn('ws', { binary: 'd', args: [] })).resolves.toBeDefined();
  });

  // ── wait_for_idle ──────────────────────────────────────────────────

  it('wait_for_idle returns idle=true after no output for idleMs', async () => {
    const h = await mgr.spawn('ws', { binary: 'sh', args: [] });
    const f = fakes.get('pty:sh')!;
    f.emitData('boot\n');
    const result = await mgr.waitForIdle('ws', h.processId, { idleMs: 60, maxWaitMs: 1_000 });
    expect(result.idle).toBe(true);
    expect(result.data).toBe('boot\n');
  });

  it('wait_for_idle returns idle=false (max-wait fired) when output keeps streaming', async () => {
    const h = await mgr.spawn('ws', { binary: 'noisy', args: [] });
    const f = fakes.get('pty:noisy')!;
    const interval = setInterval(() => f.emitData('chunk '), 25);
    const result = await mgr.waitForIdle('ws', h.processId, { idleMs: 200, maxWaitMs: 250 });
    clearInterval(interval);
    expect(result.idle).toBe(false);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('wait_for_idle returns when the process exits, even before idleMs elapses', async () => {
    const h = await mgr.spawn('ws', { binary: 'sh', args: [] });
    const f = fakes.get('pty:sh')!;
    f.emitData('hi');
    setTimeout(() => f.emitExit({ exitCode: 0, signal: null }), 25);
    const result = await mgr.waitForIdle('ws', h.processId, { idleMs: 5_000, maxWaitMs: 5_000 });
    expect(result.idle).toBe(true);
    expect(result.data).toContain('hi');
  });

  // ── wait ────────────────────────────────────────────────────────────

  it('wait resolves with the exit info', async () => {
    const h = await mgr.spawn('ws', { binary: 'sh', args: [] });
    const f = fakes.get('pty:sh')!;
    setTimeout(() => f.emitExit({ exitCode: 7, signal: null }), 10);
    const result = await mgr.wait('ws', h.processId);
    expect(result).toEqual({ exitCode: 7, signal: null });
  });

  it('wait with a timeout throws TIMEOUT when the deadline fires first', async () => {
    const h = await mgr.spawn('ws', { binary: 'sh', args: [] });
    await expect(mgr.wait('ws', h.processId, 30)).rejects.toMatchObject({
      code: RUNNER_ERROR_CODES.TIMEOUT,
    });
  });

  // ── list / killWorkspace ───────────────────────────────────────────

  it('list filters by workspaceId when given', async () => {
    const a = await mgr.spawn('ws-A', { binary: 'a', args: [] });
    const b = await mgr.spawn('ws-B', { binary: 'b', args: [] });
    expect(mgr.list('ws-A').map(h => h.processId)).toEqual([a.processId]);
    expect(mgr.list('ws-B').map(h => h.processId)).toEqual([b.processId]);
    expect(mgr.list().length).toBe(2);
  });

  it('killWorkspace SIGKILLs and forgets every process for that workspace', async () => {
    await mgr.spawn('ws-A', { binary: 'a', args: [] });
    await mgr.spawn('ws-A', { binary: 'b', args: [] });
    await mgr.spawn('ws-B', { binary: 'c', args: [] });
    const killed = await mgr.killWorkspace('ws-A');
    expect(killed).toBe(2);
    expect(mgr.list('ws-A')).toHaveLength(0);
    expect(mgr.list('ws-B')).toHaveLength(1);
  });
});
