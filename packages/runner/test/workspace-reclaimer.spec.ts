import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import {
  ProcessManager,
  type AdapterFactory,
  type ProcessAdapter,
} from '../src/process-manager.js';
import { WorkspaceReclaimer, type ReclaimerLog } from '../src/workspace-reclaimer.js';
import {
  WORKER_PROTOCOL_VERSION,
  parseHeartbeatAck,
  type HeartbeatAckPayload,
  type WorkerEnvelope,
} from '../src/protocol.js';

/**
 * Workspace cleanup, runner half.
 *
 * These run against a REAL ProcessManager (with a fake PTY adapter, as
 * process-manager.spec.ts does) rather than a stubbed one, because the
 * thing under test is whether killWorkspace actually gets called for
 * the right workspaces — a stub would happily pass while the wiring was
 * wrong, which is exactly the defect this closes.
 */

function makeFake(): ProcessAdapter & { signals: string[] } {
  const e = new EventEmitter() as any;
  e.pid = 4321;
  e.signals = [];
  e.write = () => {};
  e.kill = (sig?: string) => { e.signals.push(sig ?? 'SIGTERM'); };
  e.closeInput = () => {};
  return e;
}

function makeFactory(fakes: ProcessAdapter[]): AdapterFactory {
  const make = async () => {
    const f = makeFake();
    fakes.push(f);
    return f;
  };
  return { spawnPty: make, spawnPipe: make };
}

interface Recorded { infos: string[]; warns: string[] }

function makeLog(): ReclaimerLog & Recorded {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info(line: string) { infos.push(line); },
    warn(line: string) { warns.push(line); },
  };
}

/** Build a heartbeat ack envelope correlated to `heartbeatId`. */
function ack(heartbeatId: string, payload: unknown): WorkerEnvelope {
  return {
    v: WORKER_PROTOCOL_VERSION,
    type: 'heartbeat',
    id: heartbeatId,
    seq: 1,
    ts: Date.now(),
    payload,
  };
}

function activeSet(ids: string[]): HeartbeatAckPayload {
  return { ts: Date.now(), workspaces: { active: ids } };
}

describe('parseHeartbeatAck', () => {
  it('reads an explicit set', () => {
    expect(parseHeartbeatAck(activeSet(['ws-1', 'ws-2']))).toEqual({
      ok: true,
      activeWorkspaceIds: ['ws-1', 'ws-2'],
    });
  });

  it('an explicitly empty set is a real answer, not an absent one', () => {
    expect(parseHeartbeatAck(activeSet([]))).toEqual({ ok: true, activeWorkspaceIds: [] });
  });

  it('a missing workspaces key is absent, never "nothing is active"', () => {
    expect(parseHeartbeatAck({ ts: 1 })).toEqual({ ok: false, reason: 'absent' });
    expect(parseHeartbeatAck({ ts: 1, workspaces: null })).toEqual({ ok: false, reason: 'absent' });
  });

  it('anything unreadable is malformed', () => {
    const cases: unknown[] = [
      undefined,
      null,
      'nope',
      [],
      { ts: 1, workspaces: 'ws-1' },
      { ts: 1, workspaces: [] },
      { ts: 1, workspaces: {} },
      { ts: 1, workspaces: { active: 'ws-1' } },
      { ts: 1, workspaces: { active: ['ws-1', 7] } },
      { ts: 1, workspaces: { active: ['ws-1', ''] } },
      { ts: 1, workspaces: { active: [null] } },
    ];
    for (const c of cases) {
      expect(parseHeartbeatAck(c), JSON.stringify(c ?? null)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});

describe('WorkspaceReclaimer', () => {
  let fakes: ProcessAdapter[];
  let mgr: ProcessManager;
  let log: ReclaimerLog & Recorded;
  let reclaimer: WorkspaceReclaimer;

  beforeEach(() => {
    fakes = [];
    mgr = new ProcessManager(makeFactory(fakes), 8);
    log = makeLog();
    reclaimer = new WorkspaceReclaimer(mgr, log);
  });

  /** Send a heartbeat "at" `sentAt` and return its envelope id. */
  function beat(id: string, sentAt = Date.now() + 60_000): string {
    reclaimer.noteSent(id, sentAt);
    return id;
  }

  it('kills processes for a workspace the ack no longer lists', async () => {
    await mgr.spawn('ws-gone', { binary: 'sleep', args: ['100'] });
    await mgr.spawn('ws-kept', { binary: 'sleep', args: ['100'] });

    const reclaimed = await reclaimer.onAck(ack(beat('hb-1'), activeSet(['ws-kept'])));

    expect(reclaimed).toEqual(['ws-gone']);
    expect(mgr.list('ws-gone')).toHaveLength(0);
    expect(mgr.list('ws-kept')).toHaveLength(1);
    expect((fakes[0] as any).signals).toEqual(['SIGKILL']);
    expect((fakes[1] as any).signals).toEqual([]);
  });

  it('names the workspace and the reason in the log the user sees', async () => {
    await mgr.spawn('ws-gone', { binary: 'sleep', args: ['100'] });
    await mgr.spawn('ws-gone', { binary: 'sleep', args: ['200'] });

    await reclaimer.onAck(ack(beat('hb-1'), activeSet([])));

    expect(log.infos).toEqual([
      'workspace ws-gone reclaimed: killed 2 process(es) because the backend no longer lists it as active',
    ]);
  });

  it('leaves a workspace that is still listed alone', async () => {
    await mgr.spawn('ws-1', { binary: 'sleep', args: ['100'] });

    const reclaimed = await reclaimer.onAck(ack(beat('hb-1'), activeSet(['ws-1'])));

    expect(reclaimed).toEqual([]);
    expect(mgr.list('ws-1')).toHaveLength(1);
    expect((fakes[0] as any).signals).toEqual([]);
    expect(log.infos).toEqual([]);
  });

  it('an ack with no workspace set kills nothing and says so', async () => {
    await mgr.spawn('ws-1', { binary: 'sleep', args: ['100'] });

    const reclaimed = await reclaimer.onAck(ack(beat('hb-1'), { ts: Date.now() }));

    expect(reclaimed).toEqual([]);
    expect(mgr.list('ws-1')).toHaveLength(1);
    expect((fakes[0] as any).signals).toEqual([]);
    expect(log.infos).toEqual([]);
    expect(log.warns.join('\n')).toContain('carried no workspace set; reclaiming nothing');
  });

  it('a malformed workspace set kills nothing and says so', async () => {
    await mgr.spawn('ws-1', { binary: 'sleep', args: ['100'] });

    const reclaimed = await reclaimer.onAck(
      ack(beat('hb-1'), { ts: Date.now(), workspaces: { active: 'ws-1' } }),
    );

    expect(reclaimed).toEqual([]);
    expect(mgr.list('ws-1')).toHaveLength(1);
    expect((fakes[0] as any).signals).toEqual([]);
    expect(log.warns.join('\n')).toContain('unreadable workspace set; reclaiming nothing');
  });

  it('an ack that matches no heartbeat we sent kills nothing', async () => {
    await mgr.spawn('ws-1', { binary: 'sleep', args: ['100'] });

    // No noteSent for this id: a replayed frame, or one that was never ours.
    const reclaimed = await reclaimer.onAck(ack('hb-unknown', activeSet([])));

    expect(reclaimed).toEqual([]);
    expect(mgr.list('ws-1')).toHaveLength(1);
    expect(log.warns.join('\n')).toContain('does not match an outstanding heartbeat');
  });

  it('is idempotent across repeated heartbeats: one kill, one log line', async () => {
    await mgr.spawn('ws-gone', { binary: 'sleep', args: ['100'] });

    const first = await reclaimer.onAck(ack(beat('hb-1'), activeSet([])));
    const second = await reclaimer.onAck(ack(beat('hb-2'), activeSet([])));
    const third = await reclaimer.onAck(ack(beat('hb-3'), activeSet([])));

    expect(first).toEqual(['ws-gone']);
    expect(second).toEqual([]);
    expect(third).toEqual([]);
    expect(log.infos).toHaveLength(1);
    expect((fakes[0] as any).signals).toEqual(['SIGKILL']);
  });

  it('replaying the same ack does not kill a second time', async () => {
    await mgr.spawn('ws-gone', { binary: 'sleep', args: ['100'] });
    const env = ack(beat('hb-1'), activeSet([]));

    expect(await reclaimer.onAck(env)).toEqual(['ws-gone']);
    // Same envelope again, as the stream's Last-Event-ID replay would deliver it.
    expect(await reclaimer.onAck(env)).toEqual([]);
    expect(log.infos).toHaveLength(1);
  });

  it('does not kill a workspace that started after the heartbeat was sent', async () => {
    // The backend built its answer when it received the beat; a workspace
    // that only started work afterwards could not have been in it.
    const sentAt = Date.now() - 60_000;
    await mgr.spawn('ws-new', { binary: 'sleep', args: ['100'] });

    const reclaimed = await reclaimer.onAck(ack(beat('hb-1', sentAt), activeSet([])));

    expect(reclaimed).toEqual([]);
    expect(mgr.list('ws-new')).toHaveLength(1);
    expect((fakes[0] as any).signals).toEqual([]);
  });

  it('ignores envelopes that are not heartbeat acks', async () => {
    await mgr.spawn('ws-1', { binary: 'sleep', args: ['100'] });
    beat('hb-1');

    const reclaimed = await reclaimer.onAck({
      v: WORKER_PROTOCOL_VERSION,
      type: 'event',
      id: 'hb-1',
      ts: Date.now(),
      payload: activeSet([]),
    });

    expect(reclaimed).toEqual([]);
    expect(mgr.list('ws-1')).toHaveLength(1);
  });
});
