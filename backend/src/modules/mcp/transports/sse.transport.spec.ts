import { Test, TestingModule } from '@nestjs/testing';
import { SseTransport } from './sse.transport';
import { McpService } from '../mcp.service';
import { McpSessionService } from '../mcp-session.service';
import { Response } from 'express';

describe('SseTransport - Real Business Logic', () => {
  let transport: SseTransport;
  let mcpService: any;
  let mcpSessionService: any;

  beforeEach(async () => {
    jest.useFakeTimers();

    mcpService = {
      handleJsonRpc: jest.fn(),
      getToolsAsMcp: jest.fn(),
      healthCheck: jest.fn(),
    };

    mcpSessionService = {
      createSession: jest.fn().mockReturnValue({ id: 'session-1' }),
      getSession: jest.fn(),
      removeSession: jest.fn(),
      endSession: jest.fn(),
      on: jest.fn(),
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SseTransport,
        {
          provide: McpService,
          useValue: mcpService,
        },
        {
          provide: McpSessionService,
          useValue: mcpSessionService,
        },
      ],
    }).compile();

    transport = module.get<SseTransport>(SseTransport);
    mcpService = module.get(McpService);
    mcpSessionService = module.get(McpSessionService);
  });

  afterEach(async () => {
    await transport.shutdown();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('Connection Management - Real SSE lifecycle', () => {
    describe('handleSseConnection', () => {
      it('should establish SSE connection with correct headers', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(
          mockResponse,
          'org-1',
          'user-1',
        );

        expect(connectionId).toMatch(/^sse_\d+_[a-z0-9]+$/);
        expect(mockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
        expect(mockResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
        expect(mockResponse.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
        expect(mockResponse.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
      });

      it('should create MCP session on connection', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

        expect(mcpSessionService.createSession).toHaveBeenCalledWith('org-1', 'sse', 'user-1');
      });

      it('should send initial connected event', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

        expect(mockResponse.write).toHaveBeenCalledWith(
          expect.stringContaining('event: connected'),
        );
        expect(mockResponse.write).toHaveBeenCalledWith(
          expect.stringContaining('session-1'),
        );
      });

      it('should setup close handler for connection', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

        expect(mockResponse.on).toHaveBeenCalledWith('close', expect.any(Function));
        expect(mockResponse.on).toHaveBeenCalledWith('error', expect.any(Function));
      });
    });

    describe('closeConnection', () => {
      it('should cleanup connection and remove session', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          end: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

        // Manually close the connection
        transport['closeConnection'](connectionId);

        expect(mcpSessionService.removeSession).toHaveBeenCalledWith('session-1');
        expect(mockResponse.end).toHaveBeenCalled();
      });

      it('should handle already destroyed response', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          end: jest.fn().mockImplementation(() => {
            throw new Error('Response destroyed');
          }),
          destroyed: true,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

        // Should not throw when closing destroyed connection
        expect(() => transport['closeConnection'](connectionId)).not.toThrow();
      });

      it('should emit connectionClosed event', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          end: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');
        const emitSpy = jest.spyOn(transport, 'emit');

        transport['closeConnection'](connectionId);

        expect(emitSpy).toHaveBeenCalledWith('connectionClosed', connectionId);
      });
    });
  });

  describe('Message Handling - Real JSON-RPC processing', () => {
    describe('sendMessage', () => {
      it('should send JSON-RPC message to connection', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

        const message = {
          jsonrpc: '2.0' as const,
          id: 1,
          result: { status: 'ok' },
        };

        await transport.sendMessage(connectionId, message);

        expect(mockResponse.write).toHaveBeenCalledWith(
          expect.stringContaining('event: message'),
        );
        expect(mockResponse.write).toHaveBeenCalledWith(
          expect.stringContaining('"jsonrpc":"2.0"'),
        );
      });

      it('should not send to non-existent connection', async () => {
        const message = {
          jsonrpc: '2.0' as const,
          id: 1,
          result: { status: 'ok' },
        };

        // Should not throw
        await expect(transport.sendMessage('nonexistent', message)).resolves.toBeUndefined();
      });

      it('should not send to inactive connection', async () => {
        const writeFn = jest.fn();
        const mockResponse = {
          setHeader: jest.fn(),
          write: writeFn,
          on: jest.fn(),
          end: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

        // Mark connection as inactive
        const connection = transport['connections'].get(connectionId);
        if (connection) connection.isAlive = false;

        const message = {
          jsonrpc: '2.0' as const,
          id: 1,
          result: { status: 'ok' },
        };

        const writeCallsBefore = writeFn.mock.calls.length;
        await transport.sendMessage(connectionId, message);
        const writeCallsAfter = writeFn.mock.calls.length;

        // Should not have sent message
        expect(writeCallsAfter).toBe(writeCallsBefore);
      });
    });

    describe('handleSseMessage', () => {
      it('should process JSON-RPC request and return response', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1', 'user-1');

        const request = {
          jsonrpc: '2.0' as const,
          id: 1,
          method: 'tools/list',
          params: {},
        };

        const expectedResponse = {
          jsonrpc: '2.0' as const,
          id: 1,
          result: { tools: [] },
        };

        mcpService.handleJsonRpc.mockResolvedValue(expectedResponse);

        const response = await transport.handleSseMessage(connectionId, request);

        expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(request, 'org-1', 'user-1');
        expect(response).toEqual(expectedResponse);
      });

      it('should return error for non-existent connection', async () => {
        const request = {
          jsonrpc: '2.0' as const,
          id: 1,
          method: 'tools/list',
          params: {},
        };

        const response = await transport.handleSseMessage('nonexistent', request);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(-32001);
        expect(response.error?.message).toBe('Connection not found');
      });

      it('should handle MCP service errors', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

        const request = {
          jsonrpc: '2.0' as const,
          id: 1,
          method: 'tools/list',
          params: {},
        };

        mcpService.handleJsonRpc.mockRejectedValue(new Error('Internal error'));

        const response = await transport.handleSseMessage(connectionId, request);

        expect(response.error).toBeDefined();
        expect(response.error?.code).toBe(-32603);
        expect(response.error?.message).toBe('Internal error');
      });

      it('should update lastPing on message handling', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

        const connection = transport['connections'].get(connectionId);
        const originalLastPing = connection?.lastPing;

        // Advance time
        jest.advanceTimersByTime(1000);

        const request = {
          jsonrpc: '2.0' as const,
          id: 1,
          method: 'tools/list',
          params: {},
        };

        mcpService.handleJsonRpc.mockResolvedValue({
          jsonrpc: '2.0' as const,
          id: 1,
          result: {},
        });

        await transport.handleSseMessage(connectionId, request);

        const updatedConnection = transport['connections'].get(connectionId);
        expect(updatedConnection?.lastPing.getTime()).toBeGreaterThan(originalLastPing?.getTime() || 0);
      });
    });

    describe('broadcast', () => {
      it('should broadcast message to all connections in organization', async () => {
        const mockResponse1 = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const mockResponse2 = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        await transport.handleSseConnection(mockResponse1, 'org-1');
        await transport.handleSseConnection(mockResponse2, 'org-1');

        const message = {
          jsonrpc: '2.0' as const,
          id: null,
          method: 'notification',
          params: { message: 'Test broadcast' },
        };

        const sentCount = await transport.broadcast('org-1', message);

        expect(sentCount).toBe(2);
      });

      it('should only broadcast to matching organization', async () => {
        const mockResponse1 = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const mockResponse2 = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        await transport.handleSseConnection(mockResponse1, 'org-1');
        await transport.handleSseConnection(mockResponse2, 'org-2');

        const message = {
          type: 'notification',
          data: { message: 'Test' },
        };

        const sentCount = await transport.broadcast('org-1', message);

        expect(sentCount).toBe(1);
      });

      it('should return 0 when no connections for organization', async () => {
        const message = {
          type: 'notification',
          data: { message: 'Test' },
        };

        const sentCount = await transport.broadcast('org-nonexistent', message);

        expect(sentCount).toBe(0);
      });
    });
  });

  describe('Connection Statistics - Real metrics', () => {
    describe('getConnectionStats', () => {
      it('should return zero stats when no connections', () => {
        const stats = transport.getConnectionStats();

        expect(stats).toEqual({
          total: 0,
          byOrganization: {},
          averageAge: 0,
        });
      });

      it('should count connections by organization', async () => {
        const mockResponse1 = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const mockResponse2 = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const mockResponse3 = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        await transport.handleSseConnection(mockResponse1, 'org-1');
        await transport.handleSseConnection(mockResponse2, 'org-1');
        await transport.handleSseConnection(mockResponse3, 'org-2');

        const stats = transport.getConnectionStats();

        expect(stats.total).toBe(3);
        expect(stats.byOrganization['org-1']).toBe(2);
        expect(stats.byOrganization['org-2']).toBe(1);
      });

      it('should calculate average age of connections', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        await transport.handleSseConnection(mockResponse, 'org-1');

        // Advance time by 10 seconds
        jest.advanceTimersByTime(10000);

        const stats = transport.getConnectionStats();

        expect(stats.averageAge).toBeGreaterThan(0);
      });
    });
  });

  describe('Cleanup - Real shutdown', () => {
    describe('shutdown', () => {
      it('should close all connections on shutdown', async () => {
        const mockResponse1 = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          end: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const mockResponse2 = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          end: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        await transport.handleSseConnection(mockResponse1, 'org-1');
        await transport.handleSseConnection(mockResponse2, 'org-1');

        await transport.shutdown();

        expect(mockResponse1.end).toHaveBeenCalled();
        expect(mockResponse2.end).toHaveBeenCalled();
        expect(transport.getConnectionStats().total).toBe(0);
      });

      it('should clear ping interval on shutdown', async () => {
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

        await transport.shutdown();

        expect(clearIntervalSpy).toHaveBeenCalled();
      });
    });

    describe('Error handling branches', () => {
      it('should handle send error and close connection', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn().mockImplementation(() => {
            throw new Error('Write error');
          }),
          on: jest.fn(),
          end: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

        // Try to send message - should catch error and close connection
        await transport.sendMessage(connectionId, { jsonrpc: '2.0', id: 1, result: {} });

        // Connection should be closed after error
        expect(mockResponse.end).toHaveBeenCalled();
      });

      it('should handle send event error and close connection', async () => {
        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          end: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

        // Make write throw error immediately
        mockResponse.write = jest.fn().mockImplementation(() => {
          throw new Error('Write error');
        });

        // Try to send event - should catch error and close connection
        const connection = (transport as any).connections.get(connectionId);
        if (connection) {
          (transport as any).sendEvent(connectionId, 'test', { data: 'test' });
        }

        expect(mockResponse.end).toHaveBeenCalled();
      });

      it('should return early when connection not found in sendEvent', () => {
        // Try to send event to non-existent connection
        (transport as any).sendEvent('non-existent', 'test', {});

        // Should not throw error
        expect(transport).toBeDefined();
      });

      it('should return early when connection not found in closeConnection', () => {
        // Try to close non-existent connection
        (transport as any).closeConnection('non-existent');

        // Should not throw error
        expect(transport).toBeDefined();
      });

      it.skip('should handle ping loop with stale connections', async () => {
        jest.useFakeTimers();

        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          end: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

        // Get connection and set lastPing to old time (>2 minutes)
        const connection = (transport as any).connections.get(connectionId);
        if (connection) {
          connection.lastPing = new Date(Date.now() - 130000); // 130 seconds ago
        }

        // Advance timers to trigger ping loop
        jest.advanceTimersByTime(31000);

        // Connection should be closed due to being stale
        expect(mockResponse.end).toHaveBeenCalled();

        jest.useRealTimers();
      });

      it.skip('should send ping for active connections', async () => {
        jest.useFakeTimers();

        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          end: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        const connectionId = await transport.handleSseConnection(mockResponse, 'org-1');

        // Get connection and set lastPing to 40 seconds ago (>30 seconds)
        const connection = (transport as any).connections.get(connectionId);
        if (connection) {
          connection.lastPing = new Date(Date.now() - 40000);
        }

        const initialWriteCount = (mockResponse.write as jest.Mock).mock.calls.length;

        // Advance timers to trigger ping loop
        jest.advanceTimersByTime(31000);

        // Should send ping event
        expect((mockResponse.write as jest.Mock).mock.calls.length).toBeGreaterThan(initialWriteCount);

        jest.useRealTimers();
      });

      it.skip('should skip non-existent connections in ping loop', async () => {
        jest.useFakeTimers();

        // Manually add a non-existent connection ID to test the continue branch
        const connections = (transport as any).connections;
        const originalGet = connections.get.bind(connections);

        // Mock to return undefined for specific call
        let callCount = 0;
        connections.get = jest.fn((id) => {
          callCount++;
          if (callCount === 2) { // Second call returns undefined
            return undefined;
          }
          return originalGet(id);
        });

        const mockResponse = {
          setHeader: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          end: jest.fn(),
          destroyed: false,
        } as unknown as Response;

        await transport.handleSseConnection(mockResponse, 'org-1');

        // Advance timers to trigger ping loop
        jest.advanceTimersByTime(31000);

        // Restore original get
        connections.get = originalGet;

        jest.useRealTimers();
      });
    });
  });
});