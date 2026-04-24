import { McpServerRequestService } from './mcp-server-request.service';
import { McpSession, McpSamplingCreateMessageRequest } from '../types/mcp.types';

describe('McpServerRequestService', () => {
  let service: McpServerRequestService;
  let mockTransportSend: jest.Mock;

  const mockSession = (overrides: Partial<McpSession> = {}): McpSession => ({
    id: 'session-1',
    clientInfo: { name: 'test-client', version: '1.0' },
    capabilities: {},
    clientCapabilities: {
      sampling: {},
      elicitation: {},
      roots: { listChanged: true },
    },
    transport: 'sse',
    isInitialized: true,
    createdAt: new Date(),
    lastActivity: new Date(),
    organizationId: 'org-1',
    ...overrides,
  });

  beforeEach(() => {
    service = new McpServerRequestService();
    mockTransportSend = jest.fn().mockResolvedValue(undefined);
    service.registerTransport(mockTransportSend);
  });

  afterEach(() => {
    // Clean up any pending requests
    service.cancelAll('session-1');
  });

  describe('createMessage (sampling)', () => {
    const samplingParams: McpSamplingCreateMessageRequest = {
      messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
      maxTokens: 100,
    };

    it('should send a sampling/createMessage request to the client', async () => {
      const promise = service.createMessage('session-1', mockSession(), samplingParams, 5000);

      // Verify request was sent
      expect(mockTransportSend).toHaveBeenCalledTimes(1);
      const [sessionId, request] = mockTransportSend.mock.calls[0];
      expect(sessionId).toBe('session-1');
      expect(request.jsonrpc).toBe('2.0');
      expect(request.method).toBe('sampling/createMessage');
      expect(request.params).toEqual(samplingParams);
      expect(request.id).toBeDefined();

      // Simulate client response
      service.handleClientResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          role: 'assistant',
          content: { type: 'text', text: 'Hi there!' },
          model: 'claude-3',
          stopReason: 'endTurn',
        },
      });

      const result = await promise;
      expect(result.role).toBe('assistant');
      expect((result.content as any).text).toBe('Hi there!');
      expect(result.model).toBe('claude-3');
    });

    it('should reject if client does not support sampling', async () => {
      const session = mockSession({ clientCapabilities: {} });

      await expect(
        service.createMessage('session-1', session, samplingParams),
      ).rejects.toThrow('Client does not support sampling');

      expect(mockTransportSend).not.toHaveBeenCalled();
    });

    it('should reject on timeout', async () => {
      const promise = service.createMessage('session-1', mockSession(), samplingParams, 100);

      await expect(promise).rejects.toThrow('sampling/createMessage timed out after 100ms');
    });

    it('should reject if client returns an error', async () => {
      const promise = service.createMessage('session-1', mockSession(), samplingParams, 5000);

      const request = mockTransportSend.mock.calls[0][1];
      service.handleClientResponse({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -1, message: 'User declined' },
      });

      await expect(promise).rejects.toThrow('sampling/createMessage failed: User declined');
    });
  });

  describe('elicit (elicitation)', () => {
    const elicitParams = {
      message: 'Please confirm this action',
      requestedSchema: {
        type: 'object' as const,
        properties: {
          confirmed: {
            type: 'boolean' as const,
            title: 'Confirm',
            description: 'Do you want to proceed?',
          },
        },
        required: ['confirmed'],
      },
    };

    it('should send an elicitation/create request', async () => {
      const promise = service.elicit('session-1', mockSession(), elicitParams, 5000);

      expect(mockTransportSend).toHaveBeenCalledTimes(1);
      const request = mockTransportSend.mock.calls[0][1];
      expect(request.method).toBe('elicitation/create');
      expect(request.params.message).toBe('Please confirm this action');
      expect(request.params.requestedSchema.properties.confirmed.type).toBe('boolean');

      service.handleClientResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: { action: 'accept', content: { confirmed: true } },
      });

      const result = await promise;
      expect(result.action).toBe('accept');
      expect(result.content.confirmed).toBe(true);
    });

    it('should reject if client does not support elicitation', async () => {
      const session = mockSession({ clientCapabilities: { sampling: {} } });

      await expect(
        service.elicit('session-1', session, elicitParams),
      ).rejects.toThrow('Client does not support elicitation');
    });

    it('should handle user decline', async () => {
      const promise = service.elicit('session-1', mockSession(), elicitParams, 5000);

      const request = mockTransportSend.mock.calls[0][1];
      service.handleClientResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: { action: 'decline' },
      });

      const result = await promise;
      expect(result.action).toBe('decline');
      expect(result.content).toBeUndefined();
    });
  });

  describe('listRoots', () => {
    it('should send a roots/list request', async () => {
      const promise = service.listRoots('session-1', mockSession(), 5000);

      expect(mockTransportSend).toHaveBeenCalledTimes(1);
      const request = mockTransportSend.mock.calls[0][1];
      expect(request.method).toBe('roots/list');
      expect(request.params).toEqual({});

      service.handleClientResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          roots: [
            { uri: 'file:///home/user/project', name: 'My Project' },
            { uri: 'file:///home/user/docs' },
          ],
        },
      });

      const result = await promise;
      expect(result.roots).toHaveLength(2);
      expect(result.roots[0].uri).toBe('file:///home/user/project');
      expect(result.roots[0].name).toBe('My Project');
      expect(result.roots[1].name).toBeUndefined();
    });

    it('should reject if client does not support roots', async () => {
      const session = mockSession({ clientCapabilities: { sampling: {} } });

      await expect(
        service.listRoots('session-1', session),
      ).rejects.toThrow('Client does not support roots');
    });
  });

  describe('handleClientResponse', () => {
    it('should return false for unknown response ids', () => {
      const handled = service.handleClientResponse({
        jsonrpc: '2.0',
        id: 'unknown-id',
        result: {},
      });

      expect(handled).toBe(false);
    });

    it('should return true for known pending requests', async () => {
      const promise = service.createMessage('session-1', mockSession(), {
        messages: [{ role: 'user', content: { type: 'text', text: 'test' } }],
        maxTokens: 10,
      }, 5000);

      const request = mockTransportSend.mock.calls[0][1];
      const handled = service.handleClientResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: { role: 'assistant', content: { type: 'text', text: 'ok' }, model: 'test' },
      });

      expect(handled).toBe(true);
      await promise;
    });
  });

  describe('cancelAll', () => {
    it('should cancel all pending requests for a session', async () => {
      const promise1 = service.createMessage('session-1', mockSession(), {
        messages: [{ role: 'user', content: { type: 'text', text: 'a' } }],
        maxTokens: 10,
      }, 30000);

      const promise2 = service.listRoots('session-1', mockSession(), 30000);

      expect(service.getPendingCount()).toBe(2);

      const cancelled = service.cancelAll('session-1');
      expect(cancelled).toBe(2);
      expect(service.getPendingCount()).toBe(0);

      await expect(promise1).rejects.toThrow('Session closed');
      await expect(promise2).rejects.toThrow('Session closed');
    });

    it('should not cancel requests from other sessions', async () => {
      const session2 = mockSession({ id: 'session-2' });

      const promise1 = service.createMessage('session-1', mockSession(), {
        messages: [{ role: 'user', content: { type: 'text', text: 'a' } }],
        maxTokens: 10,
      }, 30000);

      const promise2 = service.listRoots('session-2', session2, 30000);

      expect(service.getPendingCount()).toBe(2);

      const cancelled = service.cancelAll('session-1');
      expect(cancelled).toBe(1);
      expect(service.getPendingCount()).toBe(1);

      await expect(promise1).rejects.toThrow('Session closed');

      // Clean up session-2
      service.cancelAll('session-2');
      await expect(promise2).rejects.toThrow('Session closed');
    });
  });

  describe('transport failure', () => {
    it('should reject if no transport is registered', async () => {
      const noTransportService = new McpServerRequestService();

      await expect(
        noTransportService.createMessage('session-1', mockSession(), {
          messages: [{ role: 'user', content: { type: 'text', text: 'test' } }],
          maxTokens: 10,
        }),
      ).rejects.toThrow('No transport registered');
    });

    it('should reject if transport send fails', async () => {
      mockTransportSend.mockRejectedValueOnce(new Error('Connection lost'));

      await expect(
        service.createMessage('session-1', mockSession(), {
          messages: [{ role: 'user', content: { type: 'text', text: 'test' } }],
          maxTokens: 10,
        }),
      ).rejects.toThrow('Connection lost');

      expect(service.getPendingCount()).toBe(0);
    });
  });
});
