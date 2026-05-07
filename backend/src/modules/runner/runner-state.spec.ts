import { RunnerState } from '../../entities/runner.entity';
import {
  HEARTBEAT_INTERVAL_MS,
  STALE_THRESHOLD_MS,
  OFFLINE_GRACE_MS,
  Event,
  RunnerSnapshot,
  canAcceptWork,
  isTerminal,
  nextState,
} from './runner-state';

/**
 * Pure-function tests over the FSM. One test per transition listed
 * in the spec, plus the negative-space tests (events that should NOT
 * change state). The helpers below let each case read like a sentence.
 */
describe('runner-state nextState', () => {
  const now = new Date('2026-05-07T10:00:00Z');
  const longAgo = new Date(now.getTime() - STALE_THRESHOLD_MS - 5_000);
  const sortaAgo = new Date(now.getTime() - HEARTBEAT_INTERVAL_MS - 1_000);

  function snap(state: RunnerState, lastHeartbeatAt: Date | null = sortaAgo): RunnerSnapshot {
    return { state, lastHeartbeatAt };
  }

  // ── heartbeat ───────────────────────────────────────────────────────

  it('heartbeat brings REGISTERED to ONLINE when no workspaces', () => {
    expect(
      nextState(snap(RunnerState.REGISTERED, null), {
        kind: 'heartbeat', at: now, workspaceCount: 0,
      }),
    ).toBe(RunnerState.ONLINE);
  });

  it('heartbeat brings REGISTERED to BUSY when workspaces > 0', () => {
    expect(
      nextState(snap(RunnerState.REGISTERED, null), {
        kind: 'heartbeat', at: now, workspaceCount: 2,
      }),
    ).toBe(RunnerState.BUSY);
  });

  it('heartbeat from STALE recovers to ONLINE within grace window', () => {
    expect(
      nextState(snap(RunnerState.STALE, longAgo), {
        kind: 'heartbeat', at: now, workspaceCount: 0,
      }),
    ).toBe(RunnerState.ONLINE);
  });

  it('heartbeat is ignored when state is OFFLINE (must re-register)', () => {
    expect(
      nextState(snap(RunnerState.OFFLINE, longAgo), {
        kind: 'heartbeat', at: now, workspaceCount: 0,
      }),
    ).toBeNull();
  });

  it('heartbeat is ignored when state is DRAINING', () => {
    expect(
      nextState(snap(RunnerState.DRAINING, sortaAgo), {
        kind: 'heartbeat', at: now, workspaceCount: 0,
      }),
    ).toBeNull();
  });

  // ── tick (timeouts) ─────────────────────────────────────────────────

  it('tick from ONLINE flips to STALE after 3 missed heartbeats', () => {
    expect(
      nextState(snap(RunnerState.ONLINE, longAgo), { kind: 'tick', at: now }),
    ).toBe(RunnerState.STALE);
  });

  it('tick from BUSY flips to STALE after 3 missed heartbeats', () => {
    expect(
      nextState(snap(RunnerState.BUSY, longAgo), { kind: 'tick', at: now }),
    ).toBe(RunnerState.STALE);
  });

  it('tick from ONLINE within heartbeat window is a no-op', () => {
    const recent = new Date(now.getTime() - 5_000);
    expect(
      nextState(snap(RunnerState.ONLINE, recent), { kind: 'tick', at: now }),
    ).toBeNull();
  });

  it('tick from STALE flips to OFFLINE once grace expires', () => {
    const wayBack = new Date(now.getTime() - STALE_THRESHOLD_MS - OFFLINE_GRACE_MS - 1_000);
    expect(
      nextState(snap(RunnerState.STALE, wayBack), { kind: 'tick', at: now }),
    ).toBe(RunnerState.OFFLINE);
  });

  it('tick from STALE within grace stays STALE', () => {
    expect(
      nextState(snap(RunnerState.STALE, longAgo), { kind: 'tick', at: now }),
    ).toBeNull();
  });

  it('tick from REGISTERED with no heartbeat is a no-op', () => {
    expect(
      nextState(snap(RunnerState.REGISTERED, null), { kind: 'tick', at: now }),
    ).toBeNull();
  });

  it('tick from DRAINING flips to OFFLINE after grace', () => {
    const wayBack = new Date(now.getTime() - OFFLINE_GRACE_MS - 1_000);
    expect(
      nextState(snap(RunnerState.DRAINING, wayBack), { kind: 'tick', at: now }),
    ).toBe(RunnerState.OFFLINE);
  });

  // ── shutdown ────────────────────────────────────────────────────────

  it('shutdown moves any non-OFFLINE state to DRAINING', () => {
    for (const s of [
      RunnerState.REGISTERED,
      RunnerState.ONLINE,
      RunnerState.BUSY,
      RunnerState.STALE,
    ]) {
      expect(
        nextState(snap(s), { kind: 'shutdown', at: now }),
      ).toBe(RunnerState.DRAINING);
    }
  });

  it('shutdown on OFFLINE is a no-op', () => {
    expect(
      nextState(snap(RunnerState.OFFLINE, longAgo), { kind: 'shutdown', at: now }),
    ).toBeNull();
  });

  // ── workspaceCountChanged ───────────────────────────────────────────

  it('first workspace flips ONLINE to BUSY', () => {
    expect(
      nextState(snap(RunnerState.ONLINE), { kind: 'workspaceCountChanged', count: 1 }),
    ).toBe(RunnerState.BUSY);
  });

  it('last workspace released flips BUSY to ONLINE', () => {
    expect(
      nextState(snap(RunnerState.BUSY), { kind: 'workspaceCountChanged', count: 0 }),
    ).toBe(RunnerState.ONLINE);
  });

  it('workspace count change in non-online/busy states is a no-op', () => {
    for (const s of [
      RunnerState.REGISTERED,
      RunnerState.STALE,
      RunnerState.DRAINING,
      RunnerState.OFFLINE,
    ]) {
      expect(
        nextState(snap(s), { kind: 'workspaceCountChanged', count: 5 }),
      ).toBeNull();
    }
  });

  // ── helpers ─────────────────────────────────────────────────────────

  it('canAcceptWork is true exactly for ONLINE and BUSY', () => {
    expect(canAcceptWork(RunnerState.ONLINE)).toBe(true);
    expect(canAcceptWork(RunnerState.BUSY)).toBe(true);
    for (const s of [
      RunnerState.REGISTERED,
      RunnerState.STALE,
      RunnerState.DRAINING,
      RunnerState.OFFLINE,
    ]) {
      expect(canAcceptWork(s)).toBe(false);
    }
  });

  it('isTerminal is true only for OFFLINE', () => {
    expect(isTerminal(RunnerState.OFFLINE)).toBe(true);
    for (const s of [
      RunnerState.REGISTERED,
      RunnerState.ONLINE,
      RunnerState.BUSY,
      RunnerState.STALE,
      RunnerState.DRAINING,
    ]) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});
