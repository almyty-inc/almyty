import { A2AServerService } from '../a2a-server.service';
import { A2AAgentCardService } from '../a2a-agent-card.service';
import { A2A_ERROR_CODES } from '../types/a2a-spec.types';

/**
 * JSON-RPC compliance tests for A2A server.
 * Verifies proper error codes per JSON-RPC 2.0 spec and A2A protocol.
 */
describe('A2A JSON-RPC compliance', () => {
  let service: A2AServerService;
  let mockRes: any;
  let lastResponse: any;

  const mockGateway: any = {
    id: 'gw-1',
    agentId: 'agent-1',
    organizationId: 'org-1',
    authConfigs: [],
  };

  const mockReq: any = {
    protocol: 'https',
    get: () => 'api.example.com',
  };

  beforeEach(() => {
    lastResponse = null;
    mockRes = {
      json: jest.fn((data) => { lastResponse = data; }),
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };

    service = new A2AServerService(
      { startRun: jest.fn(), getRun: jest.fn(), cancelRun: jest.fn() } as any,
      new A2AAgentCardService(),
      { findOne: jest.fn() } as any,
      { findOne: jest.fn() } as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
    );
  });

  describe('Parse errors (-32700)', () => {
    it('should return -32700 for null body', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, null, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.PARSE_ERROR);
    });

    it('should return -32700 for non-object body', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, 'not json', mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.PARSE_ERROR);
    });
  });

  describe('Invalid request (-32600)', () => {
    it('should return -32600 for missing jsonrpc field', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { method: 'test', id: 1 }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
    });

    it('should return -32600 for wrong jsonrpc version', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '1.0', method: 'test', id: 1 }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
    });

    it('should return -32600 for missing method', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', id: 1 }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
    });

    it('should return -32600 for missing id', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'test' }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
    });

    it('should return -32600 for non-string method', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 123, id: 1 }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
    });
  });

  describe('Method not found (-32601)', () => {
    it('should return -32601 for unknown method', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'bogus/method', id: 1 }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
      expect(lastResponse.error.message).toContain('bogus/method');
    });
  });

  describe('Invalid params (-32602)', () => {
    it('should return -32602 for non-object params', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'message/send', id: 1, params: 'string' }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
    });
  });

  describe('Response format', () => {
    it('should always include jsonrpc "2.0" in error responses', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { method: 'test' }, mockRes);
      expect(lastResponse.jsonrpc).toBe('2.0');
    });

    it('should include id from request in error responses', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'unknown', id: 42 }, mockRes);
      expect(lastResponse.id).toBe(42);
    });

    it('should use null id when request has no id', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '1.0', method: 'test' }, mockRes);
      expect(lastResponse.id).toBeNull();
    });

    it('should include error object with code and message', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, null, mockRes);
      expect(lastResponse.error).toBeDefined();
      expect(lastResponse.error.code).toBeDefined();
      expect(lastResponse.error.message).toBeDefined();
    });
  });

  describe('Invalid id type (-32600)', () => {
    it('should reject object id', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'SendMessage', id: { bad: 'type' }, params: {} }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
    });

    it('should reject array id', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'SendMessage', id: [1], params: {} }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
    });

    it('should accept string id', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'bogus', id: 'abc', params: {} }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
    });

    it('should accept number id', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'bogus', id: 42, params: {} }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
    });
  });

  describe('V1.0 PascalCase methods', () => {
    it('should accept SendMessage', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'SendMessage', id: 1, params: { message: { parts: [{ type: 'text', text: 'hi' }] } } }, mockRes);
      // Will fail at runtime (no real agent), but should NOT return METHOD_NOT_FOUND
      expect(lastResponse.error?.code).not.toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
    });

    it('should accept GetTask', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'GetTask', id: 1, params: {} }, mockRes);
      expect(lastResponse.error?.code).not.toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
    });

    it('should accept CancelTask', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'CancelTask', id: 1, params: {} }, mockRes);
      expect(lastResponse.error?.code).not.toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
    });

    it('should accept ListTasks', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'ListTasks', id: 1, params: {} }, mockRes);
      expect(lastResponse.error?.code).not.toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
    });
  });

  describe('Push notification methods (-32003)', () => {
    const pushMethods = [
      'tasks/pushNotification/set', 'tasks/pushNotification/get',
      'tasks/pushNotification/list', 'tasks/pushNotification/delete',
      'SetTaskPushNotificationConfig', 'GetTaskPushNotificationConfig',
      'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig',
    ];

    it.each(pushMethods)('should return -32003 for %s', async (method) => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method, id: 1, params: {} }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.PUSH_NOTIFICATIONS_NOT_SUPPORTED);
    });
  });

  describe('Invalid params for SendMessage (-32602)', () => {
    it('should reject missing message.parts', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'SendMessage', id: 1, params: {} }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
    });

    it('should reject non-array parts', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'SendMessage', id: 1, params: { message: { parts: 'string' } } }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
    });
  });

  describe('GetTask / CancelTask validation', () => {
    it('should return -32602 for GetTask without id', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'GetTask', id: 1, params: {} }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
    });

    it('should return -32001 for GetTask with nonexistent id', async () => {
      const mockRunRepo = { findOne: jest.fn().mockResolvedValue(null), createQueryBuilder: jest.fn() };
      const svc = new A2AServerService(
        { startRun: jest.fn(), getRun: jest.fn(), cancelRun: jest.fn() } as any,
        new A2AAgentCardService(),
        mockRunRepo as any,
        { findOne: jest.fn() } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
      );
      await svc.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'GetTask', id: 1, params: { id: 'nonexistent-uuid' } }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
    });

    it('should return -32602 for CancelTask without id', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'CancelTask', id: 1, params: {} }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
    });

    it('should return -32001 for CancelTask with nonexistent id', async () => {
      const mockRunRepo = { findOne: jest.fn().mockResolvedValue(null), createQueryBuilder: jest.fn() };
      const svc = new A2AServerService(
        { startRun: jest.fn(), getRun: jest.fn(), cancelRun: jest.fn() } as any,
        new A2AAgentCardService(),
        mockRunRepo as any,
        { findOne: jest.fn() } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
      );
      await svc.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'CancelTask', id: 1, params: { id: 'nonexistent-uuid' } }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
    });
  });

  describe('Error code propagation', () => {
    it('should propagate custom error codes from handlers', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'tasks/get', id: 1, params: {} }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
      expect(lastResponse.error.code).not.toBe(A2A_ERROR_CODES.INTERNAL_ERROR);
    });
  });

  describe('Non-UUID task IDs', () => {
    it('should return -32001 for GetTask with non-UUID id', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'GetTask', id: 1, params: { id: 'nonexistent-task-id' } }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
    });

    it('should return -32001 for CancelTask with non-UUID id', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'CancelTask', id: 1, params: { id: 'not-a-uuid' } }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
    });
  });

  describe('GetTask historyLength', () => {
    it('should reject negative historyLength', async () => {
      const mockRunRepo = {
        findOne: jest.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000001', organizationId: 'org-1', conversationId: 'conv-1', status: 'completed', output: 'test', metadata: {} }),
        createQueryBuilder: jest.fn(),
      };
      const svc = new A2AServerService(
        { startRun: jest.fn(), getRun: jest.fn(), cancelRun: jest.fn() } as any,
        new A2AAgentCardService(),
        mockRunRepo as any,
        { findOne: jest.fn() } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
      );
      await svc.handleJsonRpc(mockGateway, mockReq, {
        jsonrpc: '2.0', method: 'GetTask', id: 1,
        params: { id: '00000000-0000-0000-0000-000000000001', historyLength: -1 },
      }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
    });
  });

  describe('SendMessage with message.taskId (continue task)', () => {
    it('should return -32001 for taskId that does not exist', async () => {
      const mockRunRepo = { findOne: jest.fn().mockResolvedValue(null), createQueryBuilder: jest.fn() };
      const svc = new A2AServerService(
        { startRun: jest.fn(), getRun: jest.fn(), cancelRun: jest.fn() } as any,
        new A2AAgentCardService(),
        mockRunRepo as any,
        { findOne: jest.fn() } as any,
        { find: jest.fn().mockResolvedValue([]) } as any,
      );
      await svc.handleJsonRpc(mockGateway, mockReq, {
        jsonrpc: '2.0', method: 'SendMessage', id: 1,
        params: { message: { taskId: '00000000-0000-0000-0000-000000000099', parts: [{ type: 'text', text: 'continue' }] } },
      }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
    });
  });

  describe('GetExtendedAgentCard', () => {
    it('should return METHOD_NOT_FOUND', async () => {
      await service.handleJsonRpc(mockGateway, mockReq, { jsonrpc: '2.0', method: 'GetExtendedAgentCard', id: 1, params: {} }, mockRes);
      expect(lastResponse.error.code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
    });
  });
});
