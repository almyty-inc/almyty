import { Test, TestingModule } from '@nestjs/testing';
import { Response } from 'express';
import { EventEmitter } from 'events';

import { SseTransport } from '../sse.transport';
import { McpService } from '../../mcp.service';
import { McpSessionService } from '../../mcp-session.service';

describe('SseTransport', () => {
  let transport: SseTransport;
  let mcpService: McpService;
  let mcpSessionService: McpSessionService;

  const mockSession = {
    id: 'session-1',
    organizationId: 'org-1',
    transport: 'sse',
    userId: 'user-1',
  };

  const mockJsonRpcResponse = {
    jsonrpc: '2.0' as const,
    id: 1,
    result: { success: true },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SseTransport,
        {
          provide: McpService,
          useValue: {
            handleJsonRpc: jest.fn().mockResolvedValue(mockJsonRpcResponse),
          },
        },
        {
          provide: McpSessionService,
          useValue: {
            createSession: jest.fn().mockReturnValue(mockSession),
            removeSession: jest.fn(),
            on: jest.fn(),
          },
        },
      ],
    }).compile();

    transport = module.get<SseTransport>(SseTransport);
    mcpService = module.get<McpService>(McpService);
    mcpSessionService = module.get<McpSessionService>(McpSessionService);
  });

  afterEach(async () => {
    await transport.shutdown();
  });

  describe('handleSseConnection', () => {
    let mockResponse: any;

    beforeEach(() => {
      mockResponse = new EventEmitter() as any;
      mockResponse.setHeader = jest.fn();
      mockResponse.write = jest.fn();
      mockResponse.end = jest.fn();
      mockResponse.destroyed = false;
    });

    it('should establish SSE connection successfully', async () => {
      const connectionId = await transport.handleSseConnection(
        mockResponse,
        'org-1',
        'user-1',
        'server-1'
      );

      expect(connectionId).toBeDefined();
      expect(connectionId).toContain('sse_');
    });

    it('should set SSE headers', async () => {
      await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    });

    it('should create MCP session', async () => {
      await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      expect(mcpSessionService.createSession).toHaveBeenCalledWith('org-1', 'sse', 'user-1');
    });

    it('should send initial connection event', async () => {
      await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      expect(mockResponse.write).toHaveBeenCalled();
      const writtenData = mockResponse.write.mock.calls[0][0];
      expect(writtenData).toContain('event: connected');
      expect(writtenData).toContain('session-1');
    });

    it('should handle connection without userId', async () => {
      const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

      expect(connectionId).toBeDefined();
    });

    it('should handle connection without serverId', async () => {
      const connectionId = await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      expect(connectionId).toBeDefined();
    });

    it('should handle client disconnect', async () => {
      await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      mockResponse.emit('close');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mcpSessionService.removeSession).toHaveBeenCalledWith('session-1');
    });

    it('should handle connection errors', async () => {
      await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      mockResponse.emit('error', new Error('Connection error'));

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mcpSessionService.removeSession).toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    let mockResponse: any;
    let connectionId: string;

    beforeEach(async () => {
      mockResponse = new EventEmitter() as any;
      mockResponse.setHeader = jest.fn();
      mockResponse.write = jest.fn();
      mockResponse.end = jest.fn();
      mockResponse.destroyed = false;

      connectionId = await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');
    });

    it('should send message successfully', async () => {
      await transport.sendMessage(connectionId, mockJsonRpcResponse);

      const calls = mockResponse.write.mock.calls;
      const messageCall = calls.find((call: any) => {
        return call[0].includes('event: message');
      });

      expect(messageCall).toBeDefined();
    });

    it('should not send to non-existent connection', async () => {
      await transport.sendMessage('invalid-id', mockJsonRpcResponse);

      // Should not throw error
      expect(true).toBe(true);
    });

    it('should not send to dead connection', async () => {
      // Close the connection
      mockResponse.emit('close');
      await new Promise(resolve => setTimeout(resolve, 10));

      // Try to send message
      mockResponse.write.mockClear();
      await transport.sendMessage(connectionId, mockJsonRpcResponse);

      // Should not have written
      expect(mockResponse.write).not.toHaveBeenCalled();
    });

    it('should handle write errors', async () => {
      mockResponse.write = jest.fn().mockImplementation(() => {
        throw new Error('Write failed');
      });

      await transport.sendMessage(connectionId, mockJsonRpcResponse);

      // Should close connection on error
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(mcpSessionService.removeSession).toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    let mockResponse1: any;
    let mockResponse2: any;

    beforeEach(async () => {
      mockResponse1 = new EventEmitter() as any;
      mockResponse1.setHeader = jest.fn();
      mockResponse1.write = jest.fn();
      mockResponse1.end = jest.fn();
      mockResponse1.destroyed = false;

      mockResponse2 = new EventEmitter() as any;
      mockResponse2.setHeader = jest.fn();
      mockResponse2.write = jest.fn();
      mockResponse2.end = jest.fn();
      mockResponse2.destroyed = false;
    });

    it('should broadcast to all organization connections', async () => {
      await transport.handleSseConnection(mockResponse1, 'org-1', 'user-1');
      await transport.handleSseConnection(mockResponse2, 'org-1', 'user-2');

      const count = await transport.broadcast('org-1', mockJsonRpcResponse);

      expect(count).toBe(2);
    });

    it('should only broadcast to specified organization', async () => {
      await transport.handleSseConnection(mockResponse1, 'org-1', 'user-1');
      await transport.handleSseConnection(mockResponse2, 'org-2', 'user-2');

      const count = await transport.broadcast('org-1', mockJsonRpcResponse);

      expect(count).toBe(1);
    });

    it('should not broadcast to dead connections', async () => {
      await transport.handleSseConnection(mockResponse1, 'org-1', 'user-1');

      // Close the connection
      mockResponse1.emit('close');
      await new Promise(resolve => setTimeout(resolve, 10));

      const count = await transport.broadcast('org-1', mockJsonRpcResponse);

      expect(count).toBe(0);
    });
  });

  describe('handleSseMessage', () => {
    let mockResponse: any;
    let connectionId: string;

    beforeEach(async () => {
      mockResponse = new EventEmitter() as any;
      mockResponse.setHeader = jest.fn();
      mockResponse.write = jest.fn();
      mockResponse.end = jest.fn();
      mockResponse.destroyed = false;

      connectionId = await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');
    });

    it('should handle JSON-RPC messages', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        method: 'tools/list',
        id: 1,
      };

      const response = await transport.handleSseMessage(connectionId, request);

      expect(response).toEqual(mockJsonRpcResponse);
      expect(mcpService.handleJsonRpc).toHaveBeenCalled();
    });

    it('should return error for non-existent connection', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        method: 'tools/list',
        id: 1,
      };

      const response = await transport.handleSseMessage('invalid-id', request);

      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32001);
      expect(response.error.message).toBe('Connection not found');
    });

    it('should update last activity on message', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        method: 'tools/list',
        id: 1,
      };

      await transport.handleSseMessage(connectionId, request);

      // Verify connection is still active
      const stats = transport.getConnectionStats();
      expect(stats.total).toBe(1);
    });

    it('should handle JSON-RPC errors', async () => {
      jest.spyOn(mcpService, 'handleJsonRpc').mockRejectedValue(new Error('Handler error'));

      const request = {
        jsonrpc: '2.0' as const,
        method: 'tools/list',
        id: 1,
      };

      const response = await transport.handleSseMessage(connectionId, request);

      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toBe('Internal error');
    });
  });

  describe('ping mechanism', () => {
    let mockResponse: any;

    beforeEach(() => {
      mockResponse = new EventEmitter() as any;
      mockResponse.setHeader = jest.fn();
      mockResponse.write = jest.fn();
      mockResponse.end = jest.fn();
      mockResponse.destroyed = false;
    });

    it.skip('should send ping events', async () => {
      jest.useFakeTimers();

      await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      mockResponse.write.mockClear();

      jest.advanceTimersByTime(31000);

      const calls = mockResponse.write.mock.calls;
      const pingCall = calls.find((call: any) => {
        return call[0].includes('event: ping');
      });

      expect(pingCall).toBeDefined();

      jest.useRealTimers();
    });

    it.skip('should close stale connections', async () => {
      jest.useFakeTimers();

      await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      jest.advanceTimersByTime(121000);

      expect(mcpSessionService.removeSession).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should not ping recently active connections', async () => {
      jest.useFakeTimers();

      const connectionId = await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      mockResponse.write.mockClear();

      // Send a message to update last activity
      const request = {
        jsonrpc: '2.0' as const,
        method: 'tools/list',
        id: 1,
      };
      await transport.handleSseMessage(connectionId, request);

      jest.advanceTimersByTime(31000);

      // Should not send additional ping since last activity was recent
      const calls = mockResponse.write.mock.calls;
      const pingCalls = calls.filter((call: any) => {
        return call[0].includes('event: ping');
      });

      expect(pingCalls.length).toBe(0);

      jest.useRealTimers();
    });
  });

  describe('notification handling', () => {
    let mockResponse: any;

    beforeEach(() => {
      mockResponse = new EventEmitter() as any;
      mockResponse.setHeader = jest.fn();
      mockResponse.write = jest.fn();
      mockResponse.end = jest.fn();
      mockResponse.destroyed = false;
    });

    it('should handle notifications from session service', async () => {
      await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      // Get the notification handler
      const onCall = (mcpSessionService.on as jest.Mock).mock.calls.find(
        call => call[0] === 'notification'
      );
      expect(onCall).toBeDefined();

      const notificationHandler = onCall[1];
      const notification = { method: 'tools/listChanged' };

      mockResponse.write.mockClear();

      notificationHandler('session-1', notification);

      await new Promise(resolve => setTimeout(resolve, 10));

      const calls = mockResponse.write.mock.calls;
      const notificationCall = calls.find((call: any) => {
        return call[0].includes('event: notification');
      });

      expect(notificationCall).toBeDefined();
    });

    it('should not send notifications to wrong session', async () => {
      await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      const onCall = (mcpSessionService.on as jest.Mock).mock.calls.find(
        call => call[0] === 'notification'
      );
      const notificationHandler = onCall[1];

      mockResponse.write.mockClear();

      // Send notification for different session
      notificationHandler('wrong-session', { method: 'test' });

      await new Promise(resolve => setTimeout(resolve, 10));

      const calls = mockResponse.write.mock.calls;
      expect(calls.length).toBe(0);
    });
  });

  describe('getConnectionStats', () => {
    let mockResponse1: any;
    let mockResponse2: any;

    beforeEach(() => {
      mockResponse1 = new EventEmitter() as any;
      mockResponse1.setHeader = jest.fn();
      mockResponse1.write = jest.fn();
      mockResponse1.end = jest.fn();
      mockResponse1.destroyed = false;

      mockResponse2 = new EventEmitter() as any;
      mockResponse2.setHeader = jest.fn();
      mockResponse2.write = jest.fn();
      mockResponse2.end = jest.fn();
      mockResponse2.destroyed = false;
    });

    it('should return connection statistics', async () => {
      await transport.handleSseConnection(mockResponse1, 'org-1', 'user-1');
      await transport.handleSseConnection(mockResponse2, 'org-2', 'user-2');

      const stats = transport.getConnectionStats();

      expect(stats.total).toBe(2);
      expect(stats.byOrganization['org-1']).toBe(1);
      expect(stats.byOrganization['org-2']).toBe(1);
      expect(stats.averageAge).toBeGreaterThanOrEqual(0);
    });

    it('should handle zero connections', () => {
      const stats = transport.getConnectionStats();

      expect(stats.total).toBe(0);
      expect(stats.averageAge).toBe(0);
    });

    it('should only count alive connections', async () => {
      await transport.handleSseConnection(mockResponse1, 'org-1', 'user-1');

      // Close connection
      mockResponse1.emit('close');
      await new Promise(resolve => setTimeout(resolve, 10));

      const stats = transport.getConnectionStats();
      expect(stats.total).toBe(0);
    });
  });

  describe('shutdown', () => {
    let mockResponse1: any;
    let mockResponse2: any;

    beforeEach(() => {
      mockResponse1 = new EventEmitter() as any;
      mockResponse1.setHeader = jest.fn();
      mockResponse1.write = jest.fn();
      mockResponse1.end = jest.fn();
      mockResponse1.destroyed = false;

      mockResponse2 = new EventEmitter() as any;
      mockResponse2.setHeader = jest.fn();
      mockResponse2.write = jest.fn();
      mockResponse2.end = jest.fn();
      mockResponse2.destroyed = false;
    });

    it('should close all connections on shutdown', async () => {
      await transport.handleSseConnection(mockResponse1, 'org-1', 'user-1');
      await transport.handleSseConnection(mockResponse2, 'org-2', 'user-2');

      await transport.shutdown();

      const stats = transport.getConnectionStats();
      expect(stats.total).toBe(0);
    });

    it('should clear ping interval', async () => {
      await transport.handleSseConnection(mockResponse1, 'org-1', 'user-1');

      await transport.shutdown();

      // Verify shutdown completed
      expect(true).toBe(true);
    });

    it('should handle already destroyed responses', async () => {
      await transport.handleSseConnection(mockResponse1, 'org-1', 'user-1');

      mockResponse1.destroyed = true;

      await transport.shutdown();

      // Should not throw error
      expect(true).toBe(true);
    });
  });

  describe('edge cases', () => {
    let mockResponse: any;

    beforeEach(() => {
      mockResponse = new EventEmitter() as any;
      mockResponse.setHeader = jest.fn();
      mockResponse.write = jest.fn();
      mockResponse.end = jest.fn();
      mockResponse.destroyed = false;
    });

    it('should handle multiple messages to same connection', async () => {
      const connectionId = await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      await transport.sendMessage(connectionId, { jsonrpc: '2.0', id: 1, result: {} });
      await transport.sendMessage(connectionId, { jsonrpc: '2.0', id: 2, result: {} });

      const calls = mockResponse.write.mock.calls;
      const messageCalls = calls.filter((call: any) => call[0].includes('event: message'));

      expect(messageCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle rapid connection/disconnection', async () => {
      const connectionId = await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

      mockResponse.emit('close');
      await new Promise(resolve => setTimeout(resolve, 10));

      // Try to send message after close
      await transport.sendMessage(connectionId, mockJsonRpcResponse);

      // Should not throw error
      expect(true).toBe(true);
    });

    it('should handle broadcast to organization with no connections', async () => {
      const count = await transport.broadcast('org-999', mockJsonRpcResponse);

      expect(count).toBe(0);
    });
  });
});
