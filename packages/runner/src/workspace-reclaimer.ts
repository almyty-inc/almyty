import type { ProcessManager } from './process-manager.js';
import { HeartbeatAckParse, parseHeartbeatAck, WorkerEnvelope } from './protocol.js';

/**
 * Reclaims processes for workspaces the backend no longer considers
 * active.
 *
 * Shape: heartbeat reconciliation, not a release RPC. The runner
 * heartbeats every 30s; the backend answers each heartbeat with the set
 * of workspaces it still lists as ACTIVE for this runner; anything this
 * machine is hosting outside that set is killed. A `workspace.release`
 * message would be a single point of failure — drop it once and the
 * user's processes run forever — whereas a set that is re-sent every
 * beat self-heals: a missed reconciliation is corrected 30s later.
 *
 * Two safety rules, because these are processes on the user's own
 * machine:
 *
 *   1. Ambiguity reclaims nothing. An ack with no workspace set, an
 *      unparseable set, or an ack that does not correlate to a
 *      heartbeat this runner actually sent, all kill nothing and log.
 *      The only thing that kills is an explicit, well-formed answer.
 *
 *   2. Nothing newer than the question gets killed. The backend built
 *      its answer at the moment it received the heartbeat; a workspace
 *      that started on this machine after that could not have been in
 *      it. Reclaiming is therefore limited to workspaces whose oldest
 *      running process predates the heartbeat we are being answered.
 *      Without this, a workspace created in the window between sending
 *      a heartbeat and receiving its ack is killed the instant it
 *      starts work.
 */

/** Minimal surface this needs from the process manager. */
export type ReclaimableProcesses = Pick<ProcessManager, 'list' | 'killWorkspace'>;

export interface ReclaimerLog {
  /** User-visible: something on their machine was terminated. */
  info(line: string): void;
  /** Diagnostics: why nothing was terminated. */
  warn(line: string): void;
}

/**
 * How many un-acked heartbeats to remember. The daemon beats every 30s
 * and an ack rides the same stream, so anything older than a handful of
 * beats is never going to be answered.
 */
const MAX_TRACKED_HEARTBEATS = 8;

export class WorkspaceReclaimer {
  /** Envelope id -> local ms timestamp at which we sent that heartbeat. */
  private readonly sent = new Map<string, number>();

  constructor(
    private readonly processes: ReclaimableProcesses,
    private readonly log: ReclaimerLog,
  ) {}

  /**
   * Record a heartbeat we just put on the wire, so its ack can be
   * correlated. An ack whose id is not here is ignored: it is either a
   * replayed frame (the stream replays on reconnect via Last-Event-ID)
   * or something we did not ask for, and neither is a reason to kill
   * anything.
   */
  noteSent(envelopeId: string, sentAt: number): void {
    this.sent.set(envelopeId, sentAt);
    while (this.sent.size > MAX_TRACKED_HEARTBEATS) {
      const oldest = this.sent.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sent.delete(oldest);
    }
  }

  /**
   * Handle an inbound `heartbeat` envelope from the backend. Returns the
   * workspace ids actually reclaimed (empty when nothing was, for any
   * reason).
   */
  async onAck(env: WorkerEnvelope): Promise<string[]> {
    if (env.type !== 'heartbeat') return [];

    const sentAt = this.sent.get(env.id);
    if (sentAt === undefined) {
      // Consumed already, or never ours. Replayed acks land here, which
      // is what we want: an ack is answered once.
      this.log.warn(
        `heartbeat ack ${env.id} does not match an outstanding heartbeat; reclaiming nothing`,
      );
      return [];
    }
    this.sent.delete(env.id);

    const parsed: HeartbeatAckParse = parseHeartbeatAck(env.payload);
    if (!parsed.ok) {
      this.log.warn(
        parsed.reason === 'absent'
          ? 'heartbeat ack carried no workspace set; reclaiming nothing ' +
              '(backend predates workspace reconciliation, or could not build the set)'
          : 'heartbeat ack carried an unreadable workspace set; reclaiming nothing',
      );
      return [];
    }

    const active = new Set(parsed.activeWorkspaceIds);
    const reclaimed: string[] = [];
    for (const [workspaceId, hosted] of this.hostedWorkspaces()) {
      if (active.has(workspaceId)) continue;
      if (hosted.oldestStartedAt > sentAt) {
        // Started after the backend answered; it could not have been in
        // the set. The next heartbeat will see it listed, or reclaim it.
        continue;
      }
      const killed = await this.processes.killWorkspace(workspaceId);
      reclaimed.push(workspaceId);
      this.log.info(
        `workspace ${workspaceId} reclaimed: killed ${killed} process(es) ` +
          'because the backend no longer lists it as active',
      );
    }
    return reclaimed;
  }

  /**
   * Workspaces with at least one RUNNING process, keyed by id, with the
   * start time of the oldest of them.
   *
   * Only running processes count. Exited ones linger in the manager's
   * retention window so callers can still collect exit info, and
   * treating those as something to reclaim would log a kill that killed
   * nothing. It also makes the whole thing idempotent for free:
   * killWorkspace forgets the processes it killed, so the next
   * heartbeat finds the workspace unhosted and says nothing.
   */
  private hostedWorkspaces(): Map<string, { oldestStartedAt: number }> {
    const hosted = new Map<string, { oldestStartedAt: number }>();
    for (const handle of this.processes.list()) {
      if (handle.status !== 'running') continue;
      const startedAt = handle.startedAt.getTime();
      const existing = hosted.get(handle.workspaceId);
      if (!existing) hosted.set(handle.workspaceId, { oldestStartedAt: startedAt });
      else if (startedAt < existing.oldestStartedAt) existing.oldestStartedAt = startedAt;
    }
    return hosted;
  }
}
