import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

import { McpSession, McpNotification, McpTransport } from './types/mcp.types';

@Injectable()
export class McpSessionService extends EventEmitter {
  private readonly logger = new Logger(McpSessionService.name);
  private readonly sessions = new Map<string, McpSession>();
  private readonly sessionsByOrganization = new Map<string, Set<string>>();

  // Session Management
  createSession(
    organizationId: string,
    transport: McpTransport,
    userId?: string,
  ): McpSession {
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

  getSession(sessionId: string): McpSession | null {
    return this.sessions.get(sessionId) || null;
  }

  updateSession(sessionId: string, updates: Partial<McpSession>): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    Object.assign(session, updates, { lastActivity: new Date() });
    this.sessions.set(sessionId, session);
    
    return true;
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