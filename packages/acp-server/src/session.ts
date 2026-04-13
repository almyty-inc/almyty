/**
 * Session manager for the ACP server.
 *
 * Maps ACP session IDs to almyty agent state: agent ID, agent mode
 * (workflow/autonomous), conversation context, and active run tracking.
 */

import { randomUUID } from 'node:crypto';

/** Persisted state for one ACP session. */
export interface Session {
  /** ACP session ID (UUID). */
  id: string;
  /** almyty agent ID this session is bound to. */
  agentId: string;
  /** Agent execution mode. */
  mode: 'workflow' | 'autonomous';
  /** Conversation ID for autonomous multi-turn sessions. */
  conversationId?: string;
  /** Currently in-flight run ID (for cancellation). */
  activeRunId?: string;
  /** AbortController for the active streaming request. */
  abortController?: AbortController;
  /** Timestamp of last activity (epoch ms). */
  lastActivity: number;
  /** User-requested session mode (e.g. "plan", "code"). Stored but not enforced. */
  userMode?: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  /**
   * Create a new session bound to the given agent.
   */
  create(agentId: string, mode: 'workflow' | 'autonomous'): Session {
    const session: Session = {
      id: randomUUID(),
      agentId,
      mode,
      lastActivity: Date.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Look up a session by ID. Returns undefined if not found.
   */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all active sessions.
   */
  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Update fields on an existing session.
   */
  update(sessionId: string, patch: Partial<Pick<Session, 'conversationId' | 'activeRunId' | 'abortController' | 'userMode'>>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    Object.assign(session, patch);
    session.lastActivity = Date.now();
  }

  /**
   * Abort any in-flight work for a session and clear the active run.
   */
  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.abortController?.abort();
    session.abortController = undefined;
    session.activeRunId = undefined;
    session.lastActivity = Date.now();
  }

  /**
   * Close and remove a session, aborting any in-flight work.
   */
  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.abortController?.abort();
    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * Close all sessions. Called during shutdown.
   */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.abortController?.abort();
    }
    this.sessions.clear();
  }
}
