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
});
