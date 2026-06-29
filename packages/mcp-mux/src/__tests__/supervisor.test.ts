import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Supervisor } from '../supervisor.js';
import { McpStdioMux } from '../mux.js';
import { FakeFactory, FakeDownstream } from './fakes.js';

/** A log handle that tracks net open count so we can assert zero leaks. */
function makeLogLedger() {
  const ledger = { open: 0, everOpened: 0 };
  return {
    ledger,
    openLog: () => {
      ledger.open++;
      ledger.everOpened++;
      return {
        close: () => {
          ledger.open--;
        },
      };
    },
  };
}

describe('Supervisor', () => {
  let mux: McpStdioMux;
  beforeEach(() => {
    mux = new McpStdioMux({ sweepIntervalMs: 1_000_000 });
  });
  afterEach(() => mux.close());

  it('start() success wires the downstream and reaches running', async () => {
    const factory = new FakeFactory();
    const sup = new Supervisor(factory, mux);
    await sup.start();
    expect(sup.current).toBe('running');
    expect(factory.spawns).toHaveLength(1);
  });

  it('FD-LEAK HAMMER: a log acquired before spawn is released on every failing start', async () => {
    // Their bug: Start() opened a log fd, then errored before registering for
    // Stop() — the fd leaked, and repeated failing attaches drained the budget.
    const { ledger, openLog } = makeLogLedger();
    const factory = new FakeFactory();
    factory.failNext = true; // spawn always throws AFTER the log is opened

    const sup = new Supervisor(factory, mux, { openLog });
    let threw = 0;
    for (let i = 0; i < 500; i++) {
      try {
        await sup.start();
      } catch {
        threw++;
      }
    }
    expect(threw).toBe(500);
    expect(ledger.everOpened).toBe(500); // we really did open it each time
    expect(ledger.open).toBe(0); // …and the error path released every single one
    expect(factory.spawns).toHaveLength(0);
    expect(sup.current).toBe('failed');
  });

  it('reaps the child exactly once (no double-kill) across exit + stop', async () => {
    const factory = new FakeFactory();
    const sup = new Supervisor(factory, mux, { sweepIntervalMs: 1_000_000 });
    await sup.start();
    const child = factory.spawns[0] as FakeDownstream;

    await sup.stop(); // running -> stopped: reap kills once
    expect(child.killed).toBe(1);
    await sup.stop(); // idempotent: no second kill
    expect(child.killed).toBe(1);
  });

  it('does not kill a child that already exited on its own', async () => {
    vi.useFakeTimers();
    const factory = new FakeFactory();
    const sup = new Supervisor(factory, mux);
    await sup.start();
    const child = factory.spawns[0] as FakeDownstream;

    child.die(); // child exits unexpectedly
    expect(sup.current).toBe('respawning');
    expect(child.killed).toBe(0); // reap() must not kill an already-dead child
    sup.stop();
    vi.useRealTimers();
  });

  it('errors in-flight requests and respawns after backoff when the child dies', async () => {
    vi.useFakeTimers();
    const factory = new FakeFactory();
    const sup = new Supervisor(factory, mux, { backoffBaseMs: 3000 });
    await sup.start();
    const first = factory.spawns[0] as FakeDownstream;

    const goneSpy = vi.spyOn(mux, 'onDownstreamGone');
    first.die();
    expect(goneSpy).toHaveBeenCalledOnce(); // in-flight requests errored, map cleared
    expect(sup.current).toBe('respawning');

    await vi.advanceTimersByTimeAsync(3001); // let backoff elapse + start() resolve
    expect(factory.spawns).toHaveLength(2); // a fresh child was spawned
    expect(sup.current).toBe('running');

    sup.stop();
    vi.useRealTimers();
  });

  it('start() after stop() is refused (terminal state)', async () => {
    const sup = new Supervisor(new FakeFactory(), mux);
    await sup.start();
    await sup.stop();
    await expect(sup.start()).rejects.toThrow(/stopped/);
  });
});
