import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpStdioMux } from '../mux.js';
import { RPC } from '../types.js';
import { FakeDownstream, FakeSession } from './fakes.js';

/** Drain the write-queue (an async .then chain) — one microtask turn isn't enough. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('McpStdioMux', () => {
  let mux: McpStdioMux;
  let ds: FakeDownstream;

  beforeEach(() => {
    mux = new McpStdioMux({ sweepIntervalMs: 1_000_000 }); // disable auto-sweep in tests
    ds = new FakeDownstream();
    mux.setDownstream(ds);
  });
  afterEach(() => mux.close());

  it('rewrites colliding ids across sessions and routes each response home', async () => {
    const a = new FakeSession('A');
    const b = new FakeSession('B');
    mux.addSession(a);
    mux.addSession(b);

    a.client({ jsonrpc: '2.0', id: 1, method: 'ping' }); // both use id:1
    b.client({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await flush(); // let the write queue drain

    // Downstream saw two DISTINCT proxy ids, never a collision.
    expect(ds.written).toHaveLength(2);
    const idA = ds.idOfWrite(0);
    const idB = ds.idOfWrite(1);
    expect(idA).not.toBe(idB);

    // Respond out of order; each session gets its OWN original id:1 back.
    ds.emitLine({ jsonrpc: '2.0', id: idB, result: { who: 'B' } });
    ds.emitLine({ jsonrpc: '2.0', id: idA, result: { who: 'A' } });

    expect(a.last()).toEqual({ jsonrpc: '2.0', id: 1, result: { who: 'A' } });
    expect(b.last()).toEqual({ jsonrpc: '2.0', id: 1, result: { who: 'B' } });
    expect(mux.inFlight).toBe(0);
  });

  it('serializes frames to the downstream under concurrency (no interleave)', async () => {
    ds.writeDelayMs = 5;
    const s = new FakeSession('S');
    mux.addSession(s);
    for (let i = 0; i < 20; i++) s.client({ jsonrpc: '2.0', id: i, method: 'm' });
    // Wait for the whole chain to drain.
    await new Promise((r) => setTimeout(r, 200));
    expect(ds.written).toHaveLength(20);
    // Every written frame is one valid JSON object, and proxy ids are strictly increasing.
    const ids = ds.written.map((w) => JSON.parse(w).id);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]);
  });

  it('forwards notifications (no id) without allocating a mapping', async () => {
    const s = new FakeSession('S');
    mux.addSession(s);
    s.client({ jsonrpc: '2.0', method: 'notify' }); // no id
    await flush();
    expect(ds.written).toHaveLength(1);
    expect(mux.inFlight).toBe(0);
  });

  it('drops responses for unknown / duplicate ids without double-routing', async () => {
    const s = new FakeSession('S');
    mux.addSession(s);
    s.client({ jsonrpc: '2.0', id: 7, method: 'm' });
    await flush();
    const pid = ds.idOfWrite(0);

    ds.emitLine({ jsonrpc: '2.0', id: 99999, result: {} }); // never sent
    expect(s.sent).toHaveLength(0);

    ds.emitLine({ jsonrpc: '2.0', id: pid, result: { ok: true } }); // the real one
    expect(s.sent).toHaveLength(1);
    ds.emitLine({ jsonrpc: '2.0', id: pid, result: { dupe: true } }); // duplicate
    expect(s.sent).toHaveLength(1); // not re-routed
  });

  it('tears down one session without touching another session in-flight', async () => {
    const a = new FakeSession('A');
    const b = new FakeSession('B');
    mux.addSession(a);
    mux.addSession(b);
    a.client({ jsonrpc: '2.0', id: 1, method: 'm' });
    a.client({ jsonrpc: '2.0', id: 2, method: 'm' });
    b.client({ jsonrpc: '2.0', id: 1, method: 'm' });
    await flush();
    const aPid = ds.idOfWrite(0);
    const bPid = ds.idOfWrite(2);
    expect(mux.inFlight).toBe(3);

    b.close(); // tear down B only
    expect(mux.inFlight).toBe(2); // B's one mapping gone; A's two remain

    // Late response for B is dropped, not misrouted; A still routes.
    ds.emitLine({ jsonrpc: '2.0', id: bPid, result: {} });
    expect(b.sent).toHaveLength(0);
    ds.emitLine({ jsonrpc: '2.0', id: aPid, result: { ok: true } });
    expect(a.last().id).toBe(1);
  });

  it('errors every in-flight session and clears the map when the downstream is gone', async () => {
    const a = new FakeSession('A');
    const b = new FakeSession('B');
    mux.addSession(a);
    mux.addSession(b);
    a.client({ jsonrpc: '2.0', id: 1, method: 'm' });
    b.client({ jsonrpc: '2.0', id: 1, method: 'm' });
    await flush();
    expect(mux.inFlight).toBe(2);

    mux.onDownstreamGone('crash');
    expect(mux.inFlight).toBe(0);
    expect(a.last().error.code).toBe(RPC.DOWNSTREAM_GONE);
    expect(b.last().error.code).toBe(RPC.DOWNSTREAM_GONE);
  });

  it('broadcasts server-initiated (method-bearing) downstream messages to all sessions', () => {
    const a = new FakeSession('A');
    const b = new FakeSession('B');
    mux.addSession(a);
    mux.addSession(b);
    ds.emitLine({ jsonrpc: '2.0', method: 'notifications/progress', params: { p: 1 } });
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('TTL-sweeps stale requests and errors the owning session', () => {
    vi.useFakeTimers();
    const m = new McpStdioMux({ requestTtlMs: 100, sweepIntervalMs: 50 });
    const d = new FakeDownstream();
    m.setDownstream(d);
    const s = new FakeSession('S');
    m.addSession(s);
    s.client({ jsonrpc: '2.0', id: 1, method: 'm' });
    vi.advanceTimersByTime(5); // flush write queue microtasks via timer tick
    return Promise.resolve().then(() => {
      expect(m.inFlight).toBe(1);
      vi.advanceTimersByTime(200); // past TTL + a sweep
      expect(m.inFlight).toBe(0);
      expect(s.last().error.code).toBe(RPC.DOWNSTREAM_TIMEOUT);
      m.close();
      vi.useRealTimers();
    });
  });
});
