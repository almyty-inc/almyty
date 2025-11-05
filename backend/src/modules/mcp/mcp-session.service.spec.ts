import { Test, TestingModule } from '@nestjs/testing';
import { McpSessionService } from './mcp-session.service';
import { McpSession, McpNotification, McpTransport } from './types/mcp.types';

describe('McpSessionService', () => {
  let service: McpSessionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [McpSessionService],
    }).compile();

    service = module.get<McpSessionService>(McpSessionService);
  });

  afterEach(() => {
    // Clean up all sessions after each test
    service['sessions'].clear();
    service['sessionsByOrganization'].clear();
  });

  describe('createSession', () => {
    it('should create session with generated UUID', () => {
      const session = service.createSession('org-1', 'http', 'user-1');

      expect(session.id).toBeDefined();
      expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(session.organizationId).toBe('org-1');
      expect(session.userId).toBe('user-1');
      expect(session.transport).toBe('http');
      expect(session.isInitialized).toBe(false);
    });

    it('should set default clientInfo and capabilities', () => {
      const session = service.createSession('org-1', 'websocket');

      expect(session.clientInfo).toEqual({ name: 'unknown', version: '1.0.0' });
      expect(session.capabilities).toEqual({});
    });

    it('should set timestamps on creation', () => {
      const beforeTime = Date.now();
      const session = service.createSession('org-1', 'sse');
      const afterTime = Date.now();

      expect(session.createdAt.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(session.createdAt.getTime()).toBeLessThanOrEqual(afterTime);
      expect(session.lastActivity.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(session.lastActivity.getTime()).toBeLessThanOrEqual(afterTime);
    });

    it('should add session to organization index', () => {
      const session = service.createSession('org-1', 'http');

      const orgSessions = service.getSessionsByOrganization('org-1');
      expect(orgSessions).toHaveLength(1);
      expect(orgSessions[0].id).toBe(session.id);
    });

    it('should handle multiple sessions for same organization', () => {
      const session1 = service.createSession('org-1', 'http');
      const session2 = service.createSession('org-1', 'websocket');

      const orgSessions = service.getSessionsByOrganization('org-1');
      expect(orgSessions).toHaveLength(2);
      expect(orgSessions.map(s => s.id)).toContain(session1.id);
      expect(orgSessions.map(s => s.id)).toContain(session2.id);
    });
  });

  describe('getSession', () => {
    it('should return existing session by ID', () => {
      const created = service.createSession('org-1', 'http');

      const retrieved = service.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.organizationId).toBe('org-1');
    });

    it('should return null for non-existent session', () => {
      const retrieved = service.getSession('non-existent-id');

      expect(retrieved).toBeNull();
    });
  });

  describe('updateSession', () => {
    it('should update session properties', () => {
      const session = service.createSession('org-1', 'http');

      const result = service.updateSession(session.id, {
        isInitialized: true,
        clientInfo: { name: 'test-client', version: '2.0.0' },
        capabilities: { tools: { listChanged: true } },
      });

      expect(result).toBe(true);

      const updated = service.getSession(session.id);
      expect(updated?.isInitialized).toBe(true);
      expect(updated?.clientInfo.name).toBe('test-client');
      expect(updated?.capabilities.tools?.listChanged).toBe(true);
    });

    it('should update lastActivity timestamp', () => {
      const session = service.createSession('org-1', 'http');
      const originalActivity = session.lastActivity.getTime();

      // Wait a tiny bit to ensure timestamp changes
      setTimeout(() => {}, 5);

      service.updateSession(session.id, { isInitialized: true });

      const updated = service.getSession(session.id);
      expect(updated?.lastActivity.getTime()).toBeGreaterThanOrEqual(originalActivity);
    });

    it('should return false for non-existent session', () => {
      const result = service.updateSession('non-existent', { isInitialized: true });

      expect(result).toBe(false);
    });
  });

  describe('removeSession', () => {
    it('should remove session from storage', () => {
      const session = service.createSession('org-1', 'http');

      const result = service.removeSession(session.id);

      expect(result).toBe(true);
      expect(service.getSession(session.id)).toBeNull();
    });

    it('should remove session from organization index', () => {
      const session = service.createSession('org-1', 'http');

      service.removeSession(session.id);

      const orgSessions = service.getSessionsByOrganization('org-1');
      expect(orgSessions).toHaveLength(0);
    });

    it('should clean up empty organization sets', () => {
      const session = service.createSession('org-1', 'http');

      service.removeSession(session.id);

      expect(service['sessionsByOrganization'].has('org-1')).toBe(false);
    });

    it('should not remove organization index if other sessions exist', () => {
      const session1 = service.createSession('org-1', 'http');
      const session2 = service.createSession('org-1', 'websocket');

      service.removeSession(session1.id);

      expect(service['sessionsByOrganization'].has('org-1')).toBe(true);
      const orgSessions = service.getSessionsByOrganization('org-1');
      expect(orgSessions).toHaveLength(1);
      expect(orgSessions[0].id).toBe(session2.id);
    });

    it('should emit sessionClosed event', (done) => {
      const session = service.createSession('org-1', 'http');

      service.once('sessionClosed', (sessionId) => {
        expect(sessionId).toBe(session.id);
        done();
      });

      service.removeSession(session.id);
    });

    it('should return false for non-existent session', () => {
      const result = service.removeSession('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('getSessionsByOrganization', () => {
    it('should return all sessions for organization', () => {
      service.createSession('org-1', 'http', 'user-1');
      service.createSession('org-1', 'websocket', 'user-2');
      service.createSession('org-2', 'sse', 'user-3');

      const org1Sessions = service.getSessionsByOrganization('org-1');

      expect(org1Sessions).toHaveLength(2);
      expect(org1Sessions.every(s => s.organizationId === 'org-1')).toBe(true);
    });

    it('should return empty array for organization with no sessions', () => {
      const sessions = service.getSessionsByOrganization('non-existent-org');

      expect(sessions).toEqual([]);
    });
  });

  describe('getActiveSessionCount', () => {
    it('should return total number of active sessions', () => {
      service.createSession('org-1', 'http');
      service.createSession('org-1', 'websocket');
      service.createSession('org-2', 'sse');

      const count = service.getActiveSessionCount();

      expect(count).toBe(3);
    });

    it('should return 0 when no sessions exist', () => {
      const count = service.getActiveSessionCount();

      expect(count).toBe(0);
    });
  });

  describe('getActiveSessionsByTransport', () => {
    it('should count sessions by transport type', () => {
      service.createSession('org-1', 'http');
      service.createSession('org-1', 'http');
      service.createSession('org-2', 'websocket');
      service.createSession('org-2', 'sse');
      service.createSession('org-3', 'stdio');

      const counts = service.getActiveSessionsByTransport();

      expect(counts.http).toBe(2);
      expect(counts.websocket).toBe(1);
      expect(counts.sse).toBe(1);
      expect(counts.stdio).toBe(1);
    });

    it('should return zero counts when no sessions exist', () => {
      const counts = service.getActiveSessionsByTransport();

      expect(counts.http).toBe(0);
      expect(counts.websocket).toBe(0);
      expect(counts.sse).toBe(0);
      expect(counts.stdio).toBe(0);
    });
  });

  describe('broadcastToOrganization', () => {
    it('should broadcast to all initialized sessions in organization', async () => {
      const session1 = service.createSession('org-1', 'http');
      const session2 = service.createSession('org-1', 'websocket');
      const session3 = service.createSession('org-2', 'sse');

      service.updateSession(session1.id, { isInitialized: true });
      service.updateSession(session2.id, { isInitialized: true });
      service.updateSession(session3.id, { isInitialized: true });

      const notification: McpNotification = {
        method: 'notifications/message',
        params: { text: 'Test notification' },
      };

      const count = await service.broadcastToOrganization('org-1', notification);

      expect(count).toBe(2);
    });

    it('should not broadcast to uninitialized sessions', async () => {
      const session1 = service.createSession('org-1', 'http');
      const session2 = service.createSession('org-1', 'websocket');

      service.updateSession(session1.id, { isInitialized: true });
      // session2 remains uninitialized

      const notification: McpNotification = {
        method: 'notifications/message',
        params: {},
      };

      const count = await service.broadcastToOrganization('org-1', notification);

      expect(count).toBe(1);
    });

    it('should filter notifications based on capabilities', async () => {
      const session1 = service.createSession('org-1', 'http');
      const session2 = service.createSession('org-1', 'websocket');

      service.updateSession(session1.id, {
        isInitialized: true,
        capabilities: { tools: { listChanged: true } },
      });
      service.updateSession(session2.id, {
        isInitialized: true,
        capabilities: {},
      });

      const notification: McpNotification = {
        method: 'notifications/tools/list_changed',
        params: {},
      };

      const count = await service.broadcastToOrganization('org-1', notification);

      expect(count).toBe(1); // Only session1 has the capability
    });

    it('should emit notification events for each session', (done) => {
      const session1 = service.createSession('org-1', 'http');
      service.updateSession(session1.id, { isInitialized: true });

      const notification: McpNotification = {
        method: 'notifications/message',
        params: {},
      };

      let eventCount = 0;
      service.on('notification', (sessionId, notif) => {
        expect(sessionId).toBe(session1.id);
        expect(notif).toBe(notification);
        eventCount++;
        if (eventCount === 1) done();
      });

      service.broadcastToOrganization('org-1', notification);
    });
  });

  describe('broadcastToAllSessions', () => {
    it('should broadcast to all initialized sessions', async () => {
      const session1 = service.createSession('org-1', 'http');
      const session2 = service.createSession('org-2', 'websocket');
      const session3 = service.createSession('org-3', 'sse');

      service.updateSession(session1.id, { isInitialized: true });
      service.updateSession(session2.id, { isInitialized: true });
      service.updateSession(session3.id, { isInitialized: true });

      const notification: McpNotification = {
        method: 'notifications/message',
        params: {},
      };

      const count = await service.broadcastToAllSessions(notification);

      expect(count).toBe(3);
    });
  });

  describe('cleanupInactiveSessions', () => {
    it('should remove sessions inactive beyond threshold', async () => {
      const oldSession = service.createSession('org-1', 'http');
      const newSession = service.createSession('org-1', 'websocket');

      // Manually set old lastActivity
      const oldDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      service['sessions'].get(oldSession.id)!.lastActivity = oldDate;

      const cleaned = await service.cleanupInactiveSessions(30); // 30 minute threshold

      expect(cleaned).toBe(1);
      expect(service.getSession(oldSession.id)).toBeNull();
      expect(service.getSession(newSession.id)).toBeDefined();
    });

    it('should return count of cleaned sessions', async () => {
      const session1 = service.createSession('org-1', 'http');
      const session2 = service.createSession('org-1', 'websocket');
      const session3 = service.createSession('org-2', 'sse');

      const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      service['sessions'].get(session1.id)!.lastActivity = oldDate;
      service['sessions'].get(session2.id)!.lastActivity = oldDate;

      const cleaned = await service.cleanupInactiveSessions(60); // 60 minute threshold

      expect(cleaned).toBe(2);
    });

    it('should not remove active sessions', async () => {
      service.createSession('org-1', 'http');
      service.createSession('org-1', 'websocket');

      const cleaned = await service.cleanupInactiveSessions(30);

      expect(cleaned).toBe(0);
      expect(service.getActiveSessionCount()).toBe(2);
    });
  });

  describe('getSessionStats', () => {
    it('should return comprehensive session statistics', () => {
      service.createSession('org-1', 'http');
      service.createSession('org-1', 'websocket');
      const session3 = service.createSession('org-2', 'http');

      service.updateSession(session3.id, { isInitialized: true });

      const stats = service.getSessionStats();

      expect(stats.total).toBe(3);
      expect(stats.byTransport.http).toBe(2);
      expect(stats.byTransport.websocket).toBe(1);
      expect(stats.byOrganization['org-1']).toBe(2);
      expect(stats.byOrganization['org-2']).toBe(1);
      expect(stats.initialized).toBe(1);
    });

    it('should return empty stats when no sessions', () => {
      const stats = service.getSessionStats();

      expect(stats.total).toBe(0);
      expect(stats.initialized).toBe(0);
      expect(stats.byOrganization).toEqual({});
      expect(stats.byTransport.http).toBe(0);
    });
  });

  describe('shouldReceiveNotification', () => {
    it('should return false for uninitialized sessions', () => {
      const session = service.createSession('org-1', 'http');

      const notification: McpNotification = {
        method: 'notifications/message',
        params: {},
      };

      const result = service['shouldReceiveNotification'](session, notification);

      expect(result).toBe(false);
    });

    it('should check tools listChanged capability', () => {
      const session1 = service.createSession('org-1', 'http');
      service.updateSession(session1.id, {
        isInitialized: true,
        capabilities: { tools: { listChanged: true } },
      });

      const notification: McpNotification = {
        method: 'notifications/tools/list_changed',
        params: {},
      };

      expect(service['shouldReceiveNotification'](session1, notification)).toBe(true);

      const session2 = service.createSession('org-1', 'websocket');
      service.updateSession(session2.id, {
        isInitialized: true,
        capabilities: {},
      });

      expect(service['shouldReceiveNotification'](session2, notification)).toBe(false);
    });

    it('should check resources listChanged capability', () => {
      const session = service.createSession('org-1', 'http');
      service.updateSession(session.id, {
        isInitialized: true,
        capabilities: { resources: { listChanged: true } },
      });

      const notification: McpNotification = {
        method: 'notifications/resources/list_changed',
        params: {},
      };

      expect(service['shouldReceiveNotification'](session, notification)).toBe(true);
    });

    it('should check prompts listChanged capability', () => {
      const session = service.createSession('org-1', 'http');
      service.updateSession(session.id, {
        isInitialized: true,
        capabilities: { prompts: { listChanged: true } },
      });

      const notification: McpNotification = {
        method: 'notifications/prompts/list_changed',
        params: {},
      };

      expect(service['shouldReceiveNotification'](session, notification)).toBe(true);
    });

    it('should return true for generic notifications', () => {
      const session = service.createSession('org-1', 'http');
      service.updateSession(session.id, { isInitialized: true });

      const notification: McpNotification = {
        method: 'notifications/message',
        params: {},
      };

      expect(service['shouldReceiveNotification'](session, notification)).toBe(true);
    });
  });
});
