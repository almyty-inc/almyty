import { RequestLog } from './request-log.entity';

describe('RequestLog Entity', () => {
  let log: RequestLog;

  beforeEach(() => {
    log = new RequestLog();
    log.id = 'log-1';
    log.method = 'GET';
    log.path = '/api/tools';
    log.statusCode = 200;
    log.responseTime = 150;
    log.requestSize = 500;
    log.responseSize = 1500;
    log.timestamp = new Date();
  });

  describe('isSuccess', () => {
    it('should return true for 200 status', () => {
      log.statusCode = 200;

      expect(log.isSuccess()).toBe(true);
    });

    it('should return true for 201 status', () => {
      log.statusCode = 201;

      expect(log.isSuccess()).toBe(true);
    });

    it('should return true for 299 status', () => {
      log.statusCode = 299;

      expect(log.isSuccess()).toBe(true);
    });

    it('should return false for 199 status', () => {
      log.statusCode = 199;

      expect(log.isSuccess()).toBe(false);
    });

    it('should return false for 300 status', () => {
      log.statusCode = 300;

      expect(log.isSuccess()).toBe(false);
    });

    it('should return false for 400 status', () => {
      log.statusCode = 400;

      expect(log.isSuccess()).toBe(false);
    });

    it('should return false for 500 status', () => {
      log.statusCode = 500;

      expect(log.isSuccess()).toBe(false);
    });
  });

  describe('isClientError', () => {
    it('should return true for 400 status', () => {
      log.statusCode = 400;

      expect(log.isClientError()).toBe(true);
    });

    it('should return true for 404 status', () => {
      log.statusCode = 404;

      expect(log.isClientError()).toBe(true);
    });

    it('should return true for 499 status', () => {
      log.statusCode = 499;

      expect(log.isClientError()).toBe(true);
    });

    it('should return false for 399 status', () => {
      log.statusCode = 399;

      expect(log.isClientError()).toBe(false);
    });

    it('should return false for 500 status', () => {
      log.statusCode = 500;

      expect(log.isClientError()).toBe(false);
    });

    it('should return false for 200 status', () => {
      log.statusCode = 200;

      expect(log.isClientError()).toBe(false);
    });
  });

  describe('isServerError', () => {
    it('should return true for 500 status', () => {
      log.statusCode = 500;

      expect(log.isServerError()).toBe(true);
    });

    it('should return true for 503 status', () => {
      log.statusCode = 503;

      expect(log.isServerError()).toBe(true);
    });

    it('should return true for 599 status', () => {
      log.statusCode = 599;

      expect(log.isServerError()).toBe(true);
    });

    it('should return false for 499 status', () => {
      log.statusCode = 499;

      expect(log.isServerError()).toBe(false);
    });

    it('should return false for 200 status', () => {
      log.statusCode = 200;

      expect(log.isServerError()).toBe(false);
    });
  });

  describe('getResponseTimeCategory', () => {
    it('should return fast for response time < 200ms', () => {
      log.responseTime = 150;

      expect(log.getResponseTimeCategory()).toBe('fast');
    });

    it('should return fast for response time exactly 199ms', () => {
      log.responseTime = 199;

      expect(log.getResponseTimeCategory()).toBe('fast');
    });

    it('should return medium for response time 200-999ms', () => {
      log.responseTime = 500;

      expect(log.getResponseTimeCategory()).toBe('medium');
    });

    it('should return medium for response time exactly 999ms', () => {
      log.responseTime = 999;

      expect(log.getResponseTimeCategory()).toBe('medium');
    });

    it('should return slow for response time 1000-4999ms', () => {
      log.responseTime = 2500;

      expect(log.getResponseTimeCategory()).toBe('slow');
    });

    it('should return slow for response time exactly 4999ms', () => {
      log.responseTime = 4999;

      expect(log.getResponseTimeCategory()).toBe('slow');
    });

    it('should return very_slow for response time >= 5000ms', () => {
      log.responseTime = 10000;

      expect(log.getResponseTimeCategory()).toBe('very_slow');
    });

    it('should return very_slow for response time exactly 5000ms', () => {
      log.responseTime = 5000;

      expect(log.getResponseTimeCategory()).toBe('very_slow');
    });
  });

  describe('getSizeCategory', () => {
    it('should return small for total size < 1KB', () => {
      log.requestSize = 300;
      log.responseSize = 500;

      expect(log.getSizeCategory()).toBe('small');
    });

    it('should return small for total size exactly 1023 bytes', () => {
      log.requestSize = 500;
      log.responseSize = 523;

      expect(log.getSizeCategory()).toBe('small');
    });

    it('should return medium for total size 1KB-10KB', () => {
      log.requestSize = 2000;
      log.responseSize = 3000;

      expect(log.getSizeCategory()).toBe('medium');
    });

    it('should return medium for total size exactly 10239 bytes', () => {
      log.requestSize = 5000;
      log.responseSize = 5239;

      expect(log.getSizeCategory()).toBe('medium');
    });

    it('should return large for total size 10KB-100KB', () => {
      log.requestSize = 20000;
      log.responseSize = 30000;

      expect(log.getSizeCategory()).toBe('large');
    });

    it('should return large for total size exactly 102399 bytes', () => {
      log.requestSize = 50000;
      log.responseSize = 52399;

      expect(log.getSizeCategory()).toBe('large');
    });

    it('should return very_large for total size >= 100KB', () => {
      log.requestSize = 200000;
      log.responseSize = 300000;

      expect(log.getSizeCategory()).toBe('very_large');
    });

    it('should return very_large for total size exactly 102400 bytes', () => {
      log.requestSize = 50000;
      log.responseSize = 52400;

      expect(log.getSizeCategory()).toBe('very_large');
    });
  });

  describe('getFullUrl', () => {
    it('should combine base URL with path', () => {
      log.path = '/api/tools';

      expect(log.getFullUrl('https://api.example.com')).toBe('https://api.example.com/api/tools');
    });

    it('should handle base URL without trailing slash', () => {
      log.path = '/api/v1/tools';

      expect(log.getFullUrl('https://api.example.com')).toBe('https://api.example.com/api/v1/tools');
    });

    it('should handle base URL with trailing slash', () => {
      log.path = '/api/tools';

      expect(log.getFullUrl('https://api.example.com/')).toBe('https://api.example.com//api/tools');
    });

    it('should handle path with query parameters', () => {
      log.path = '/api/tools?page=1&limit=10';

      expect(log.getFullUrl('https://api.example.com')).toBe('https://api.example.com/api/tools?page=1&limit=10');
    });

    it('should handle root path', () => {
      log.path = '/';

      expect(log.getFullUrl('https://api.example.com')).toBe('https://api.example.com/');
    });
  });

  describe('sanitizeForStorage', () => {
    beforeEach(() => {
      log.requestHeaders = {
        authorization: 'Bearer token123',
        Authorization: 'Bearer token456',
        'x-api-key': 'key-abc',
        'X-API-Key': 'key-def',
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0',
      };
    });

    it('should remove authorization header (lowercase)', () => {
      log.sanitizeForStorage();

      expect(log.requestHeaders.authorization).toBeUndefined();
    });

    it('should remove Authorization header (uppercase)', () => {
      log.sanitizeForStorage();

      expect(log.requestHeaders.Authorization).toBeUndefined();
    });

    it('should remove x-api-key header (lowercase)', () => {
      log.sanitizeForStorage();

      expect(log.requestHeaders['x-api-key']).toBeUndefined();
    });

    it('should remove X-API-Key header', () => {
      log.sanitizeForStorage();

      expect(log.requestHeaders['X-API-Key']).toBeUndefined();
    });

    it('should preserve non-sensitive headers', () => {
      log.sanitizeForStorage();

      expect(log.requestHeaders['content-type']).toBe('application/json');
      expect(log.requestHeaders['user-agent']).toBe('Mozilla/5.0');
    });

    it('should truncate large request body', () => {
      log.requestBody = 'a'.repeat(12000);

      log.sanitizeForStorage();

      expect(log.requestBody).toHaveLength(10015); // 10000 + '... [truncated]'.length (15 chars)
      expect(log.requestBody.endsWith('... [truncated]')).toBe(true);
    });

    it('should truncate large response body', () => {
      log.responseBody = 'b'.repeat(15000);

      log.sanitizeForStorage();

      expect(log.responseBody).toHaveLength(10015); // 10000 + '... [truncated]'.length (15 chars)
      expect(log.responseBody.endsWith('... [truncated]')).toBe(true);
    });

    it('should not truncate small request body', () => {
      log.requestBody = 'small body';

      log.sanitizeForStorage();

      expect(log.requestBody).toBe('small body');
    });

    it('should not truncate small response body', () => {
      log.responseBody = 'small response';

      log.sanitizeForStorage();

      expect(log.responseBody).toBe('small response');
    });

    it('should handle null requestHeaders', () => {
      log.requestHeaders = null;

      expect(() => log.sanitizeForStorage()).not.toThrow();
    });

    it('should handle undefined requestHeaders', () => {
      log.requestHeaders = undefined;

      expect(() => log.sanitizeForStorage()).not.toThrow();
    });

    it('should handle null requestBody', () => {
      log.requestBody = null;

      expect(() => log.sanitizeForStorage()).not.toThrow();
    });

    it('should handle null responseBody', () => {
      log.responseBody = null;

      expect(() => log.sanitizeForStorage()).not.toThrow();
    });
  });

  describe('fromHttpRequest', () => {
    let mockRequest: any;
    let mockResponse: any;
    let startTime: number;

    beforeEach(() => {
      startTime = Date.now();
      mockRequest = {
        method: 'POST',
        path: '/api/tools/execute',
        headers: {
          'user-agent': 'Mozilla/5.0',
          'content-type': 'application/json',
          authorization: 'Bearer test-token',
        },
        ip: '192.168.1.1',
        body: { toolId: 'tool-1', params: { key: 'value' } },
        id: 'req-12345',
      };
      mockResponse = {
        statusCode: 200,
        getHeaders: () => ({
          'content-type': 'application/json',
          'x-request-id': 'req-12345',
        }),
        body: JSON.stringify({ success: true }),
      };
    });

    it('should create log from HTTP request and response', () => {
      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);

      expect(created.method).toBe('POST');
      expect(created.path).toBe('/api/tools/execute');
      expect(created.statusCode).toBe(200);
      expect(created.userAgent).toBe('Mozilla/5.0');
      expect(created.ipAddress).toBe('192.168.1.1');
      expect(created.requestId).toBe('req-12345');
    });

    it('should calculate response time', () => {
      const pastTime = Date.now() - 500;
      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, pastTime);

      expect(created.responseTime).toBeGreaterThanOrEqual(500);
      expect(created.responseTime).toBeLessThan(600);
    });

    it('should copy request headers', () => {
      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);

      expect(created.requestHeaders).toBeDefined();
      expect(created.requestHeaders['content-type']).toBe('application/json');
    });

    it('should copy response headers when getHeaders is available', () => {
      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);

      expect(created.responseHeaders).toBeDefined();
      expect(created.responseHeaders['content-type']).toBe('application/json');
      expect(created.responseHeaders['x-request-id']).toBe('req-12345');
    });

    it('should handle response without getHeaders method', () => {
      mockResponse.getHeaders = undefined;

      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);

      expect(created.responseHeaders).toEqual({});
    });

    it('should stringify request body', () => {
      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);

      expect(created.requestBody).toBe(JSON.stringify(mockRequest.body));
    });

    it('should calculate request size', () => {
      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);

      const expectedSize = Buffer.byteLength(JSON.stringify(mockRequest.body), 'utf8');
      expect(created.requestSize).toBe(expectedSize);
    });

    it('should calculate response size', () => {
      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);

      const expectedSize = Buffer.byteLength(mockResponse.body, 'utf8');
      expect(created.responseSize).toBe(expectedSize);
    });

    it('should set timestamp to current time', () => {
      const beforeTime = Date.now();
      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);
      const afterTime = Date.now();

      expect(created.timestamp.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(created.timestamp.getTime()).toBeLessThanOrEqual(afterTime);
    });

    it('should sanitize sensitive data', () => {
      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);

      expect(created.requestHeaders.authorization).toBeUndefined();
    });

    it('should use connection.remoteAddress when ip is not available', () => {
      mockRequest.ip = undefined;
      mockRequest.connection = { remoteAddress: '10.0.0.1' };

      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);

      expect(created.ipAddress).toBe('10.0.0.1');
    });

    it('should handle null response body', () => {
      mockResponse.body = null;

      const created = RequestLog.fromHttpRequest(mockRequest, mockResponse, startTime);

      expect(created.responseSize).toBe(0);
    });
  });

  describe('Integration Tests', () => {
    it('should correctly categorize successful fast small request', () => {
      log.statusCode = 200;
      log.responseTime = 150;
      log.requestSize = 300;
      log.responseSize = 500;

      expect(log.isSuccess()).toBe(true);
      expect(log.isClientError()).toBe(false);
      expect(log.isServerError()).toBe(false);
      expect(log.getResponseTimeCategory()).toBe('fast');
      expect(log.getSizeCategory()).toBe('small');
    });

    it('should correctly categorize client error slow large request', () => {
      log.statusCode = 404;
      log.responseTime = 3000;
      log.requestSize = 50000;
      log.responseSize = 60000;

      expect(log.isSuccess()).toBe(false);
      expect(log.isClientError()).toBe(true);
      expect(log.isServerError()).toBe(false);
      expect(log.getResponseTimeCategory()).toBe('slow');
      expect(log.getSizeCategory()).toBe('very_large');
    });

    it('should correctly categorize server error very slow request', () => {
      log.statusCode = 503;
      log.responseTime = 8000;
      log.requestSize = 1000;
      log.responseSize = 2000;

      expect(log.isSuccess()).toBe(false);
      expect(log.isClientError()).toBe(false);
      expect(log.isServerError()).toBe(true);
      expect(log.getResponseTimeCategory()).toBe('very_slow');
      expect(log.getSizeCategory()).toBe('medium'); // Total 3000 bytes = 2.93KB
    });

    it('should create and sanitize log from HTTP request', () => {
      const mockRequest = {
        method: 'PUT',
        path: '/api/tools/update',
        headers: {
          'user-agent': 'TestAgent',
          authorization: 'Bearer secret',
          'x-api-key': 'secret-key',
        },
        ip: '127.0.0.1',
        body: { data: 'test' },
        id: 'req-abc',
      };
      const mockResponse = {
        statusCode: 201,
        getHeaders: () => ({ 'content-type': 'application/json' }),
        body: JSON.stringify({ id: 'tool-1' }),
      };

      const created = RequestLog.fromHttpRequest(
        mockRequest,
        mockResponse,
        Date.now() - 250
      );

      expect(created.method).toBe('PUT');
      expect(created.statusCode).toBe(201);
      expect(created.isSuccess()).toBe(true);
      expect(created.requestHeaders.authorization).toBeUndefined();
      expect(created.requestHeaders['x-api-key']).toBeUndefined();
      expect(created.requestHeaders['user-agent']).toBe('TestAgent');
    });
  });
});
