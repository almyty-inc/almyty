import { RunnerState } from '../../entities/runner.entity';

/**
 * Pure functions over the runner state machine. No DI, no I/O. The
 * service calls these to compute target state and reads the result;
 * the database write is the service's job. Every transition lives
 * here in one place — when the spec changes, this file changes.
 *
 * The state model is documented on RunnerState in the entity. This
 * file is the implementation; treat the entity comment as the prose
 * spec and this file as the executable one.
 */

export const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * Three intervals' worth of silence before stale. Matches the spec
 * comment on the entity (3 missed heartbeats with default interval).
 */
export const STALE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3;
/**
 * After STALE, the runner has another window to come back before it
 * transitions to OFFLINE for good. 5 minutes is enough to ride out
 * a typical laptop sleep + wake cycle without forcing a re-register.
 */
export const OFFLINE_GRACE_MS = 5 * 60_000;

export type Event =
  | { kind: 'heartbeat'; at: Date; workspaceCount: number }
  | { kind: 'tick'; at: Date }
  | { kind: 'shutdown'; at: Date }
  | { kind: 'workspaceCountChanged'; count: number };

export interface RunnerSnapshot {
  state: RunnerState;
  lastHeartbeatAt: Date | null;
}

/**
 * Compute the next state for a runner given an incoming event. Returns
 * null when the event does not change state (callers can skip the DB
 * write). The function is total: every (state, event) pair has a
 * defined behavior, even if the behavior is "no change."
 */
export function nextState(snapshot: RunnerSnapshot, event: Event): RunnerState | null {
  const { state } = snapshot;

  switch (event.kind) {
    case 'heartbeat':
      // Heartbeat clears stale-ness, brings registered up to online,
      // and toggles online <-> busy by current workspace load. Once
      // the runner is in DRAINING or OFFLINE, an inbound heartbeat
      // is ignored — the runner has to re-register to come back.
      if (state === RunnerState.OFFLINE || state === RunnerState.DRAINING) return null;
      return event.workspaceCount > 0 ? RunnerState.BUSY : RunnerState.ONLINE;

    case 'tick': {
      if (!snapshot.lastHeartbeatAt) {
        // Never heartbeated: stays in registered until first heartbeat
        // or until something explicitly times it out. We don't auto-
        // expire an unheartbeated registration — that's a separate
        // janitor job, intentionally not part of this state machine.
        return null;
      }
      const sinceMs = event.at.getTime() - snapshot.lastHeartbeatAt.getTime();
      if (state === RunnerState.ONLINE || state === RunnerState.BUSY) {
        if (sinceMs > STALE_THRESHOLD_MS) return RunnerState.STALE;
        return null;
      }
      if (state === RunnerState.STALE) {
        if (sinceMs > STALE_THRESHOLD_MS + OFFLINE_GRACE_MS) return RunnerState.OFFLINE;
        return null;
      }
      if (state === RunnerState.DRAINING) {
        // After drain grace, if the runner hasn't disconnected itself,
        // consider it offline.
        if (sinceMs > OFFLINE_GRACE_MS) return RunnerState.OFFLINE;
        return null;
      }
      return null;
    }

    case 'shutdown':
      // Any state -> draining on a clean shutdown signal. The OFFLINE
      // transition happens on the subsequent tick once the grace window
      // expires; intentionally split so in-flight jobs get a chance to
      // wind down before downstream callers see OFFLINE.
      if (state === RunnerState.OFFLINE) return null;
      return RunnerState.DRAINING;

    case 'workspaceCountChanged':
      // Only meaningful for ONLINE <-> BUSY. Other states ignore the
      // event; the count still changes in the DB but the FSM doesn't
      // care, and you'd never spawn a workspace in OFFLINE anyway.
      if (state === RunnerState.ONLINE && event.count > 0) return RunnerState.BUSY;
      if (state === RunnerState.BUSY && event.count <= 0) return RunnerState.ONLINE;
      return null;
  }
}

/** Routing helper: which states accept new dispatch? */
export function canAcceptWork(state: RunnerState): boolean {
  return state === RunnerState.ONLINE || state === RunnerState.BUSY;
}

/** Reporting helper: which states are terminal for routing purposes? */
export function isTerminal(state: RunnerState): boolean {
  return state === RunnerState.OFFLINE;
}
