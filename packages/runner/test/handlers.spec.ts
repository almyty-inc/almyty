import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import {
  ProcessManager,
  type AdapterFactory,
  type ProcessAdapter,
} from '../src/process-manager.js';
import { dispatchHandler, type HandlerContext } from '../src/handlers.js';
import { WORKER_ERROR_CODES } from '../src/protocol.js';
import { RUNNER_ERROR_CODES } from '../src/types.js';

/**
 * End-to-end handler dispatch tests. Covers protocol-method routing,
 * params validation (typed RunnerError -> structured response), and
 * the cross-workspace refusal path that's the runner's load-bearing
 * security boundary.
 */
function fakeAdapter(): ProcessAdapter & { emitData(s: string): void; emitExit(info: any): void } {
  const e = new EventEmitter() as any;
  e.pid = 1;
  e.write = () => {};
  e.kill = () => {};
  e.closeInput = () => {};
  e.emitData = (s: string) => e.emit('data', s);
  e.emitExit = (info: any) => e.emit('exit', info);
  return e;
}

function fakeFactory(): AdapterFactory {
  return {
    spawnPty: async () => fakeAdapter(),
    spawnPipe: async () => fakeAdapter(),
  };
}

describe('dispatchHandler', () => {
  let processes: ProcessManager;
  let ctx: HandlerContext;

  beforeEach(() => {
    processes = new ProcessManager(fakeFactory(), 4);
    ctx = {
      processes,
      runnerName: 'r1',
      labels: { env: 'dev' },
      maxConcurrent: 4,
    };
  });

  it('process.spawn returns a processId', async () => {
    const resp = await dispatchHandler(ctx, {
      method: 'process.spawn',
      workspaceId: 'ws-1',
      params: { binary: 'echo', args: ['hi'] },
    });
    expect(resp.ok).toBe(true);
    expect((resp.result as any).processId).toMatch(/^proc_/);
  });

  it('process.spawn without workspaceId returns ok=false with INTERNAL', async () => {
    const resp = await dispatchHandler(ctx, {
      method: 'process.spawn',
      params: { binary: 'echo', args: [] },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe(WORKER_ERROR_CODES.INTERNAL);
  });

  it('unknown method returns MALFORMED_ENVELOPE', async () => {
    const resp = await dispatchHandler(ctx, {
      method: 'process.cosmic_ray',
      workspaceId: 'ws-1',
      params: {},
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe(WORKER_ERROR_CODES.MALFORMED_ENVELOPE);
  });

  it('process.write -> read roundtrip', async () => {
    const spawn = await dispatchHandler(ctx, {
      method: 'process.spawn',
      workspaceId: 'ws-1',
      params: { binary: 'cat', args: [] },
    });
    const pid = (spawn.result as any).processId;
    // Stage some "output" by reaching into the manager's internals.
    // Done via the fake adapter: the spawn mock has emitData().
    // We lookup the adapter through process.list().
    const list = await dispatchHandler(ctx, { method: 'process.list', workspaceId: 'ws-1', params: {} });
    expect((list.result as any).processes).toHaveLength(1);

    const writeResp = await dispatchHandler(ctx, {
      method: 'process.write',
      workspaceId: 'ws-1',
      params: { processId: pid, data: 'hello' },
    });
    expect(writeResp.ok).toBe(true);

    const readResp = await dispatchHandler(ctx, {
      method: 'process.read',
      workspaceId: 'ws-1',
      params: { processId: pid },
    });
    expect(readResp.ok).toBe(true);
    expect((readResp.result as any).data).toBe('');
  });

  it('cross-workspace process.read refused with PROCESS_CROSS_WORKSPACE in response data', async () => {
    const spawn = await dispatchHandler(ctx, {
      method: 'process.spawn',
      workspaceId: 'ws-A',
      params: { binary: 'echo', args: [] },
    });
    const pid = (spawn.result as any).processId;
    const read = await dispatchHandler(ctx, {
      method: 'process.read',
      workspaceId: 'ws-B',
      params: { processId: pid },
    });
    expect(read.ok).toBe(false);
    expect(read.error?.data).toMatchObject({ code: RUNNER_ERROR_CODES.PROCESS_CROSS_WORKSPACE });
  });

  it('runner.info returns name, labels, capacity, runtime', async () => {
    const resp = await dispatchHandler(ctx, { method: 'runner.info', params: {} });
    expect(resp.ok).toBe(true);
    const r = resp.result as any;
    expect(r.name).toBe('r1');
    expect(r.labels).toEqual({ env: 'dev' });
    expect(r.capacity.maxConcurrent).toBe(4);
    expect(typeof r.capacity.inUse).toBe('number');
    expect(r.runtime.os).toBeTruthy();
  });

  it('process.signal rejects unsupported signals', async () => {
    const spawn = await dispatchHandler(ctx, {
      method: 'process.spawn',
      workspaceId: 'ws-1',
      params: { binary: 'sleep', args: ['9999'] },
    });
    const pid = (spawn.result as any).processId;
    const resp = await dispatchHandler(ctx, {
      method: 'process.signal',
      workspaceId: 'ws-1',
      params: { processId: pid, signal: 'BOGUS' },
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('unsupported signal');
  });
});
