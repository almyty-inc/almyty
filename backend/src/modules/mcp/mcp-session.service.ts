import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

import { McpSession, McpNotification, McpTransport } from './types/mcp.types';

/** Cap on total tracked sessions before forced eviction. */
const MAX_SESSIONS = 10_000;
/** Cleanup sweep interval for inactive sessions. */
const CLEANUP_INTERVAL_MS = 60_000;
/** Default session idle cutoff — matches the default in cleanupInactiveSessions. */
const DEFAULT_IDLE_MINUTES = 30;

@Injectable()
export class McpSessionService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpSessionService.name);
  private readonly sessions = new Map<string, McpSession>();
  private readonly sessionsByOrganization = new Map<string, Set<string>>();
  private cleanupTimer?: NodeJS.Timeout;

  onModuleInit(): void {
    // Run the idle-session sweep on a schedule. Previously the
    // cleanup method existed but was never called automatically —
    // the sessions Map grew unbounded with every
    // createSession call that wasn't followed by an explicit
    // removeSession (which means most of them, since transport
    // failures, client disconnects without explicit close, and
    // process restarts all skip the cleanup path).
    this.cleanupTimer = setInterval(() => {
      this.cleanupInactiveSessions(DEFAULT_IDLE_MINUTES).catch((err) => {
        this.logger.warn(`Session cleanup sweep failed: ${err.message}`);
      });
    }, CLEANUP_INTERVAL_MS);
    // .unref() so the sweep timer doesn't keep the process alive
    // during graceful shutdown or in tests.
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  // Session Management
  createSession(
    organizationId: string,
    transport: McpTransport,
    userId?: string,
  ): McpSession {
    // Hard cap before insertion. If we're at the cap, run a sync
    // cleanup pass; if that doesn't free space, evict the single
    // oldest-inserted session so the map can't grow unbounded under
    // adversarial load.
    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictIfFull();
    }

    const session: McpSession = {
      id: uuidv4(),
      clientInfo: { name: 'unknown', version: '1.0.0' },
      capabilities: {},
      transport,
      isInitialized: false,
      createdAt: new Date(),
      lastActivity: new Date(),
      organizationId,
      userId,
    };

    this.sessions.set(session.id, session);

    // Add to organization index
    if (!this.sessionsByOrganization.has(organizationId)) {
      this.sessionsByOrganization.set(organizationId, new Set());
    }
    this.sessionsByOrganization.get(organizationId)!.add(session.id);

    this.logger.log(`MCP session created: ${session.id} (${transport}) for org: ${organizationId}`);

    return session;
  }

  /**
   * Synchronous sweep triggered from createSession when the session
   * map hits the cap. Drops expired entries first; if we're still
   * at capacity, evicts the oldest-inserted session (Map iteration
   * order = insertion order).
   */
  private evictIfFull(): void {
    const cutoff = new Date(Date.now() - DEFAULT_IDLE_MINUTES * 60 * 1000);
    for (const [sid, s] of this.sessions) {
      if (s.lastActivity < cutoff) {
        this.removeSession(sid);
      }
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.removeSession(oldest);
    }
  }

  /**
   * Unscoped session lookup. Prefer `getSessionForOrg` from any
   * caller that has an organizationId handy — this method is kept
   * for the transport layers that already own the session via a
   * trusted websocket / sse connection id.
   */
  getSession(sessionId: string): McpSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Org-scoped lookup. Returns null if the session doesn't exist OR
   * belongs to a different org — indistinguishable, so callers can't
   * use this as a cross-org existence oracle.
   */
  getSessionForOrg(sessionId: string, organizationId: string): McpSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.organizationId !== organizationId) return null;
    return session;
  }

  updateSession(sessionId: string, updates: Partial<McpSession>): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // Strip organizationId + id from the updates bag so a caller can't
    // flip a session between orgs or rekey it even if a cross-org
    // update path slips through in the future.
    const { organizationId: _f1, id: _f2, ...safeUpdates } = updates as any;
    Object.assign(session, safeUpdates, { lastActivity: new Date() });
    this.sessions.set(sessionId, session);

    return true;
  }

  /**
   * Org-scoped variant of updateSession. Refuses cross-org writes.
   */
  updateSessionForOrg(
    sessionId: string,
    organizationId: string,
    updates: Partial<McpSession>,
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.organizationId !== organizationId) return false;
    return this.updateSession(sessionId, updates);
  }

  removeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    this.sessions.delete(sessionId);
    
    // Remove from organization index
    const orgSessions = this.sessionsByOrganization.get(session.organizationId);
    if (orgSessions) {
      orgSessions.delete(sessionId);
      if (orgSessions.size === 0) {
        this.sessionsByOrganization.delete(session.organizationId);
      }
    }

    this.logger.log(`MCP session removed: ${sessionId}`);
    this.emit('sessionClosed', sessionId);
    
    return true;
  }

  getSessionsByOrganization(organizationId: string): McpSession[] {
    const sessionIds = this.sessionsByOrganization.get(organizationId) || new Set();
    return Array.from(sessionIds)
      .map(id => this.sessions.get(id))
      .filter(Boolean) as McpSession[];
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  getActiveSessionsByTransport(): Record<McpTransport, number> {
    const counts: Record<McpTransport, number> = {
      http: 0,
      sse: 0,
      websocket: 0,
      stdio: 0,
    };

    for (const session of this.sessions.values()) {
      counts[session.transport]++;
    }

    return counts;
  }

  // Notification Broadcasting
  async broadcastToOrganization(
    organizationId: string,
    notification: McpNotification,
  ): Promise<number> {
    const sessions = this.getSessionsByOrganization(organizationId);
    
    let broadcastCount = 0;
    for (const session of sessions) {
      if (this.shouldReceiveNotification(session, notification)) {
        await this.sendNotificationToSession(session, notification);
        broadcastCount++;
      }
    }

    this.logger.debug(`Broadcast ${notification.method} to ${broadcastCount} sessions in org ${organizationId}`);
    return broadcastCount;
  }

  /**
   * Broadcast to every session in every organization. This is the
   * escape hatch for genuinely system-wide notifications (server
   * shutdown notice, protocol version changes, etc.) — NEVER call
   * it with a notification that carries per-org state. There's no
   * way for this method to enforce "is this notification safe to
   * send across orgs?", so the contract is that the caller has to
   * be explicitly cross-org-aware.
   *
   * Flagged intentionally: if a new caller appears that isn't the
   * shutdown or protocol-level path, treat it as a bug and move it
   * to `broadcastToOrganization`.
   */
  async broadcastToAllSessions(notification: McpNotification): Promise<number> {
    let broadcastCount = 0;

    for (const session of this.sessions.values()) {
      if (this.shouldReceiveNotification(session, notification)) {
        await this.sendNotificationToSession(session, notification);
        broadcastCount++;
      }
    }

    this.logger.debug(`Broadcast ${notification.method} to ${broadcastCount} total sessions`);
    return broadcastCount;
  }

  private shouldReceiveNotification(session: McpSession, notification: McpNotification): boolean {
    if (!session.isInitialized) {
      return false;
    }

    // Check if client supports this notification type
    switch (notification.method) {
      case 'notifications/tools/list_changed':
        return session.capabilities.tools?.listChanged === true;
        
      case 'notifications/resources/list_changed':
        return session.capabilities.resources?.listChanged === true;
        
      case 'notifications/prompts/list_changed':
        return session.capabilities.prompts?.listChanged === true;
        
      default:
        return true; // Always send basic notifications
    }
  }

  private async sendNotificationToSession(
    session: McpSession,
    notification: McpNotification,
  ): Promise<void> {
    // Emit event for transport layer to handle
    this.emit('notification', session.id, notification);
    
    // Update session activity
    this.updateSession(session.id, { lastActivity: new Date() });
  }

  // Session Cleanup
  async cleanupInactiveSessions(maxIdleMinutes = 30): Promise<number> {
    const cutoffTime = new Date(Date.now() - maxIdleMinutes * 60 * 1000);
    let cleanedCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.lastActivity < cutoffTime) {
        this.removeSession(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} inactive MCP sessions`);
    }

    return cleanedCount;
  }

  // Statistics
  getSessionStats(): {
    total: number;
    byTransport: Record<McpTransport, number>;
    byOrganization: Record<string, number>;
    initialized: number;
  } {
    const byOrganization: Record<string, number> = {};
    let initializedCount = 0;

    for (const session of this.sessions.values()) {
      byOrganization[session.organizationId] = (byOrganization[session.organizationId] || 0) + 1;
      if (session.isInitialized) {
        initializedCount++;
      }
    }

    return {
      total: this.sessions.size,
      byTransport: this.getActiveSessionsByTransport(),
      byOrganization,
      initialized: initializedCount,
    };
  }
}