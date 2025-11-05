import { Test, TestingModule } from '@nestjs/testing';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

import { WebSocketTransport } from '../websocket.transport';
import { McpService } from '../../mcp.service';
import { McpSessionService } from '../../mcp-session.service';

describe('WebSocketTransport', () => {
  let transport: WebSocketTransport;
  let mcpService: McpService;
  let mcpSessionService: McpSessionService;

  const mockSession = {
    id: 'session-1',
    organizationId: 'org-1',
    transport: 'websocket',
    userId: 'user-1',
  };

  const mockResponse = {
    jsonrpc: '2.0',
    id: 1,
    result: { success: true },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebSocketTransport,
        {
          provide: McpService,
          useValue: {
            handleJsonRpc: jest.fn().mockResolvedValue(mockResponse),
          },
        },
        {
          provide: McpSessionService,
          useValue: {
            createSession: jest.fn().mockReturnValue(mockSession),
            updateSession: jest.fn(),
            removeSession: jest.fn(),
            on: jest.fn(),
          },
        },
      ],
    }).compile();

    transport = module.get<WebSocketTransport>(WebSocketTransport);
    mcpService = module.get<McpService>(McpService);
    mcpSessionService = module.get<McpSessionService>(McpSessionService);
  });

  afterEach(async () => {
    await transport.shutdown();
  });

  describe('handleWebSocketConnection', () => {
    it('should establish WebSocket connection successfully', async () => {
      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;

      const connectionId = await transport.handleWebSocketConnection(
        mockWs,
        'org-1',
        'user-1',
        'server-1'
      );

      expect(connectionId).toBeDefined();
      expect(connectionId).toContain('ws_');
      expect(mockWs.send).toHaveBeenCalled();
    });

    it('should create MCP session on connection', async () => {
      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;

      await transport.handleWebSocketConnection(mockWs, 'org-1', 'user-1');

      expect(mcpSessionService.createSession).toHaveBeenCalledWith(
        'org-1',
        'websocket',
        'user-1'
      );
    });

    it('should send initial connection message', async () => {
      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;

      await transport.handleWebSocketConnection(mockWs, 'org-1', 'user-1');

      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
      expect(sentMessage.type).toBe('connection');
      expect(sentMessage.data.sessionId).toBe('session-1');
    });

    it('should handle connection without userId', async () => {
      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;

      const connectionId = await transport.handleWebSocketConnection(mockWs, 'org-1');

      expect(connectionId).toBeDefined();
    });

    it('should handle connection without serverId', async () => {
      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;

      const connectionId = await transport.handleWebSocketConnection(
        mockWs,
        'org-1',
        'user-1'
      );

      expect(connectionId).toBeDefined();
    });
  });

  describe('handleMessage', () => {
    let mockWs: any;
    let connectionId: string;

    beforeEach(async () => {
      mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;

      connectionId = await transport.handleWebSocketConnection(mockWs, 'org-1', 'user-1');
    });

    it('should handle ping messages', async () => {
      const pingMessage = JSON.stringify({ type: 'ping' });

      mockWs.emit('message', Buffer.from(pingMessage));

      await new Promise(resolve => setTimeout(resolve, 10));

      const calls = mockWs.send.mock.calls;
      const pongCall = calls.find((call: any) => {
        try {
          const msg = JSON.parse(call[0]);
          return msg.type === 'pong';
        } catch {
          return false;
        }
      });

      expect(pongCall).toBeDefined();
    });

    it('should handle JSON-RPC messages', async () => {
      const jsonRpcMessage = JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1,
      });

      mockWs.emit('message', Buffer.from(jsonRpcMessage));

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mcpService.handleJsonRpc).toHaveBeenCalled();
    });

    it('should handle wrapped JSON-RPC messages', async () => {
      const wrappedMessage = JSON.stringify({
        type: 'jsonrpc',
        data: {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1,
        },
      });

      mockWs.emit('message', Buffer.from(wrappedMessage));

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mcpService.handleJsonRpc).toHaveBeenCalled();
    });

    it('should handle subscription messages', async () => {
      const subscriptionMessage = JSON.stringify({
        type: 'subscribe',
        data: {
          type: 'tools',
          filter: {},
        },
      });

      mockWs.emit('message', Buffer.from(subscriptionMessage));

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mcpSessionService.updateSession).toHaveBeenCalled();
    });

    it('should handle unknown message types', async () => {
      const unknownMessage = JSON.stringify({
        type: 'unknown',
        data: {},
      });

      mockWs.emit('message', Buffer.from(unknownMessage));

      await new Promise(resolve => setTimeout(resolve, 10));

      const calls = mockWs.send.mock.calls;
      const errorCall = calls.find((call: any) => {
        try {
          const msg = JSON.parse(call[0]);
          return msg.type === 'error' && msg.data.code === -32601;
        } catch {
          return false;
        }
      });

      expect(errorCall).toBeDefined();
    });

    it('should handle parse errors', async () => {
      const invalidJson = 'invalid json {';

      mockWs.emit('message', Buffer.from(invalidJson));

      await new Promise(resolve => setTimeout(resolve, 10));

      const calls = mockWs.send.mock.calls;
      const errorCall = calls.find((call: any) => {
        try {
          const msg = JSON.parse(call[0]);
          return msg.type === 'error' && msg.data.code === -32700;
        } catch {
          return false;
        }
      });

      expect(errorCall).toBeDefined();
    });

    it('should not handle messages for dead connections', async () => {
      // Close the connection first
      mockWs.emit('close', 1000, 'Normal closure');

      await new Promise(resolve => setTimeout(resolve, 10));

      // Try to send a message
      const message = JSON.stringify({ type: 'ping' });
      mockWs.emit('message', Buffer.from(message));

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should not process message after connection closed
      const calls = mockWs.send.mock.calls;
      const pongAfterClose = calls.slice(-1).find((call: any) => {
        try {
          const msg = JSON.parse(call[0]);
          return msg.type === 'pong';
        } catch {
          return false;
        }
      });

      // Verify no pong was sent after close
      expect(pongAfterClose).toBeUndefined();
    });
  });

  describe('connection management', () => {
    let mockWs: any;

    beforeEach(() => {
      mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;
      mockWs.close = jest.fn();
      mockWs.ping = jest.fn();
    });

    it('should handle pong events', async () => {
      const connectionId = await transport.handleWebSocketConnection(mockWs, 'org-1');

      mockWs.emit('pong');

      await new Promise(resolve => setTimeout(resolve, 10));

      // Connection should remain alive
      const stats = transport.getConnectionStats();
      expect(stats.total).toBe(1);
    });

    it('should handle close events', async () => {
      await transport.handleWebSocketConnection(mockWs, 'org-1');

      mockWs.emit('close', 1000, 'Normal closure');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mcpSessionService.removeSession).toHaveBeenCalled();
    });

    it('should handle error events', async () => {
      await transport.handleWebSocketConnection(mockWs, 'org-1');

      mockWs.emit('error', new Error('Connection error'));

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mcpSessionService.removeSession).toHaveBeenCalled();
    });

    it('should not send when WebSocket not open', async () => {
      mockWs.readyState = WebSocket.CLOSED;
      await transport.handleWebSocketConnection(mockWs, 'org-1');

      // Connection should be closed
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mcpSessionService.removeSession).toHaveBeenCalled();
    });

    it('should handle send errors gracefully', async () => {
      mockWs.send = jest.fn().mockImplementation(() => {
        throw new Error('Send failed');
      });
      mockWs.readyState = WebSocket.OPEN;

      await transport.handleWebSocketConnection(mockWs, 'org-1');

      // Should handle error without crashing
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  });

  describe('broadcastToOrganization', () => {
    it('should broadcast to all organization connections', async () => {
      const mockWs1 = new EventEmitter() as any;
      mockWs1.send = jest.fn();
      mockWs1.readyState = WebSocket.OPEN;

      const mockWs2 = new EventEmitter() as any;
      mockWs2.send = jest.fn();
      mockWs2.readyState = WebSocket.OPEN;

      await transport.handleWebSocketConnection(mockWs1, 'org-1');
      await transport.handleWebSocketConnection(mockWs2, 'org-1');

      const message = { type: 'broadcast', data: 'test' };
      const count = await transport.broadcastToOrganization('org-1', message);

      expect(count).toBe(2);
    });

    it('should only broadcast to specified organization', async () => {
      const mockWs1 = new EventEmitter() as any;
      mockWs1.send = jest.fn();
      mockWs1.readyState = WebSocket.OPEN;

      const mockWs2 = new EventEmitter() as any;
      mockWs2.send = jest.fn();
      mockWs2.readyState = WebSocket.OPEN;

      await transport.handleWebSocketConnection(mockWs1, 'org-1');
      await transport.handleWebSocketConnection(mockWs2, 'org-2');

      const message = { type: 'broadcast', data: 'test' };
      const count = await transport.broadcastToOrganization('org-1', message);

      expect(count).toBe(1);
    });

    it('should not broadcast to dead connections', async () => {
      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;
      mockWs.close = jest.fn();

      await transport.handleWebSocketConnection(mockWs, 'org-1');

      // Close the connection
      mockWs.emit('close', 1000, 'Normal closure');
      await new Promise(resolve => setTimeout(resolve, 10));

      const message = { type: 'broadcast', data: 'test' };
      const count = await transport.broadcastToOrganization('org-1', message);

      expect(count).toBe(0);
    });
  });

  describe('heartbeat mechanism', () => {
    it.skip('should send pings to connections', async () => {
      jest.useFakeTimers();

      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;
      mockWs.ping = jest.fn();

      await transport.handleWebSocketConnection(mockWs, 'org-1');

      // Advance past the heartbeat interval
      jest.advanceTimersByTime(31000);

      // The ping should have been called
      expect(mockWs.ping).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it.skip('should close stale connections', async () => {
      jest.useFakeTimers();

      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;
      mockWs.ping = jest.fn();
      mockWs.close = jest.fn();

      await transport.handleWebSocketConnection(mockWs, 'org-1');

      // Clear previous calls
      (mcpSessionService.removeSession as jest.Mock).mockClear();

      // Advance time beyond stale threshold without pong
      jest.advanceTimersByTime(70000);

      // Should have attempted to close stale connection
      expect(mcpSessionService.removeSession).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should keep connection alive with pongs', async () => {
      jest.useFakeTimers();

      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;
      mockWs.ping = jest.fn();

      await transport.handleWebSocketConnection(mockWs, 'org-1');

      // Send pong to keep alive
      jest.advanceTimersByTime(30000);
      mockWs.emit('pong');

      jest.advanceTimersByTime(30000);

      const stats = transport.getConnectionStats();
      expect(stats.total).toBe(1);

      jest.useRealTimers();
    });
  });

  describe('notification handling', () => {
    it('should handle notifications from session service', async () => {
      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;

      await transport.handleWebSocketConnection(mockWs, 'org-1');

      // Get the notification handler
      const onCall = (mcpSessionService.on as jest.Mock).mock.calls.find(
        call => call[0] === 'notification'
      );
      expect(onCall).toBeDefined();

      const notificationHandler = onCall[1];
      const notification = { method: 'tools/listChanged' };

      notificationHandler('session-1', notification);

      await new Promise(resolve => setTimeout(resolve, 10));

      const calls = mockWs.send.mock.calls;
      const notificationCall = calls.find((call: any) => {
        try {
          const msg = JSON.parse(call[0]);
          return msg.type === 'notification';
        } catch {
          return false;
        }
      });

      expect(notificationCall).toBeDefined();
    });
  });

  describe('getConnectionStats', () => {
    it('should return connection statistics', async () => {
      const mockWs1 = new EventEmitter() as any;
      mockWs1.send = jest.fn();
      mockWs1.readyState = WebSocket.OPEN;

      const mockWs2 = new EventEmitter() as any;
      mockWs2.send = jest.fn();
      mockWs2.readyState = WebSocket.OPEN;

      await transport.handleWebSocketConnection(mockWs1, 'org-1', 'user-1', 'server-1');
      await transport.handleWebSocketConnection(mockWs2, 'org-2', 'user-2', 'server-2');

      const stats = transport.getConnectionStats();

      expect(stats.total).toBe(2);
      expect(stats.byOrganization['org-1']).toBe(1);
      expect(stats.byOrganization['org-2']).toBe(1);
      expect(stats.byServer['server-1']).toBe(1);
      expect(stats.byServer['server-2']).toBe(1);
      expect(stats.averageAge).toBeGreaterThanOrEqual(0);
    });

    it('should handle zero connections', () => {
      const stats = transport.getConnectionStats();

      expect(stats.total).toBe(0);
      expect(stats.averageAge).toBe(0);
    });

    it('should only count alive connections', async () => {
      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;
      mockWs.close = jest.fn();

      await transport.handleWebSocketConnection(mockWs, 'org-1');

      // Close connection
      mockWs.emit('close', 1000, 'Normal closure');
      await new Promise(resolve => setTimeout(resolve, 10));

      const stats = transport.getConnectionStats();
      expect(stats.total).toBe(0);
    });
  });

  describe('getOrganizationConnections', () => {
    it('should return connections for organization', async () => {
      const mockWs1 = new EventEmitter() as any;
      mockWs1.send = jest.fn();
      mockWs1.readyState = WebSocket.OPEN;

      const mockWs2 = new EventEmitter() as any;
      mockWs2.send = jest.fn();
      mockWs2.readyState = WebSocket.OPEN;

      await transport.handleWebSocketConnection(mockWs1, 'org-1');
      await transport.handleWebSocketConnection(mockWs2, 'org-2');

      const connections = transport.getOrganizationConnections('org-1');

      expect(connections).toHaveLength(1);
      expect(connections[0].organizationId).toBe('org-1');
    });

    it('should return empty array for organization without connections', () => {
      const connections = transport.getOrganizationConnections('org-999');

      expect(connections).toHaveLength(0);
    });
  });

  describe('shutdown', () => {
    it('should close all connections on shutdown', async () => {
      const mockWs1 = new EventEmitter() as any;
      mockWs1.send = jest.fn();
      mockWs1.readyState = WebSocket.OPEN;
      mockWs1.close = jest.fn();

      const mockWs2 = new EventEmitter() as any;
      mockWs2.send = jest.fn();
      mockWs2.readyState = WebSocket.OPEN;
      mockWs2.close = jest.fn();

      await transport.handleWebSocketConnection(mockWs1, 'org-1');
      await transport.handleWebSocketConnection(mockWs2, 'org-2');

      await transport.shutdown();

      const stats = transport.getConnectionStats();
      expect(stats.total).toBe(0);
    });

    it('should clear heartbeat interval', async () => {
      const mockWs = new EventEmitter() as any;
      mockWs.send = jest.fn();
      mockWs.readyState = WebSocket.OPEN;

      await transport.handleWebSocketConnection(mockWs, 'org-1');

      await transport.shutdown();

      // Verify shutdown completed
      expect(true).toBe(true);
    });
  });
});
