import { ToolExecution } from './tool-execution.entity';
import { Repository } from 'typeorm';

describe('ToolExecution Entity', () => {
  let execution: ToolExecution;

  beforeEach(() => {
    execution = new ToolExecution();
    execution.id = 'exec-1';
    execution.toolId = 'tool-1';
    execution.organizationId = 'org-1';
    execution.userId = 'user-1';
    execution.parameters = { id: 'user-123' };
    execution.result = { data: { name: 'John Doe' } };
    execution.success = true;
    execution.executionTime = 250;
    execution.cached = false;
    execution.retryCount = 0;
    execution.metadata = { source: 'test', requestId: 'req-123' };
    execution.createdAt = new Date();
  });

  describe('getDurationInSeconds', () => {
    it('should return duration in seconds', () => {
      expect(execution.getDurationInSeconds()).toBe(0); // Math.round(250/1000) = 0
    });

    it('should handle zero execution time', () => {
      execution.executionTime = 0;
      expect(execution.getDurationInSeconds()).toBe(0);
    });
  });

  describe('isSuccessful', () => {
    it('should return true for successful execution', () => {
      expect(execution.isSuccessful()).toBe(true);
    });

    it('should return false for failed execution', () => {
      execution.success = false;
      expect(execution.isSuccessful()).toBe(false);
    });
  });

  describe('isCached', () => {
    it('should return false for non-cached execution', () => {
      expect(execution.isCached()).toBe(false);
    });

    it('should return true for cached execution', () => {
      execution.cached = true;
      expect(execution.isCached()).toBe(true);
    });
  });

  describe('wasRateLimited', () => {
    it('should return false for non-rate-limited execution', () => {
      execution.metadata = { rateLimited: false };
      expect(execution.wasRateLimited()).toBe(false);
    });

    it('should return true for rate-limited execution', () => {
      execution.metadata = { rateLimited: true };
      expect(execution.wasRateLimited()).toBe(true);
    });
  });

  describe('getHttpStatus', () => {
    it('should return HTTP status when available', () => {
      execution.metadata = { httpStatus: 200 };
      expect(execution.getHttpStatus()).toBe(200);
    });

    it('should return undefined when no HTTP status', () => {
      execution.metadata = {};
      expect(execution.getHttpStatus()).toBeUndefined();
    });

    it('should return undefined when metadata is null', () => {
      execution.metadata = null;
      expect(execution.getHttpStatus()).toBeUndefined();
    });
  });

  describe('getRequestId', () => {
    it('should return request ID when available', () => {
      expect(execution.getRequestId()).toBe('req-123');
    });

    it('should return undefined when no request ID', () => {
      execution.metadata = {};
      expect(execution.getRequestId()).toBeUndefined();
    });
  });

  describe('getErrorMessage', () => {
    it('should return undefined for successful execution', () => {
      expect(execution.getErrorMessage()).toBeUndefined();
    });

    it('should return error message for failed execution', () => {
      execution.success = false;
      execution.error = 'Tool execution failed';
      expect(execution.getErrorMessage()).toBe('Tool execution failed');
    });

    it('should return null when no error', () => {
      execution.success = false;
      execution.error = null;
      expect(execution.getErrorMessage()).toBeNull();
    });
  });

  // Static query helpers were removed — they returned Mongo-style
  // query objects (`{ $gte: since }`, `'metadata.rateLimited': true`)
  // that TypeORM doesn't understand, so any caller that used them
  // would have matched zero rows. No production code referenced them;
  // only this spec did, and it pinned the broken shape. The helpers
  // + their tests are gone.

  describe('toAnalyticsData', () => {
    it('should convert execution to analytics format', () => {
      const analytics = execution.toAnalyticsData();

      expect(analytics).toEqual({
        id: 'exec-1',
        toolId: 'tool-1',
        organizationId: 'org-1',
        userId: 'user-1',
        success: true,
        executionTime: 250,
        cached: false,
        retryCount: 0,
        httpStatus: undefined,
        rateLimited: false,
        timestamp: execution.createdAt,
        error: undefined,
        requestId: 'req-123',
      });
    });

    it('should handle failed execution with error', () => {
      execution.success = false;
      execution.error = 'API timeout';

      const analytics = execution.toAnalyticsData();

      expect(analytics.success).toBe(false);
      expect(analytics.error).toBe('API timeout');
    });

    it('should handle cached execution', () => {
      execution.cached = true;

      const analytics = execution.toAnalyticsData();

      expect(analytics.cached).toBe(true);
    });

    it('should extract httpStatus from metadata', () => {
      execution.metadata = { httpStatus: 200, requestId: 'req-123' };

      const analytics = execution.toAnalyticsData();

      expect(analytics.httpStatus).toBe(200);
    });

    it('should detect rate limited executions', () => {
      execution.metadata = { rateLimited: true, requestId: 'req-123' };

      const analytics = execution.toAnalyticsData();

      expect(analytics.rateLimited).toBe(true);
    });
  });

  describe('toMetricsData', () => {
    it('should convert execution to metrics format with numeric flags', () => {
      const metrics = execution.toMetricsData();

      expect(metrics).toEqual({
        tool_id: 'tool-1',
        user_id: 'user-1',
        organization_id: 'org-1',
        success: 1,
        execution_time_ms: 250,
        cached: 0,
        retry_count: 0,
        http_status: 0,
        rate_limited: 0,
        timestamp: execution.createdAt.getTime(),
      });
    });

    it('should convert false success to 0', () => {
      execution.success = false;

      const metrics = execution.toMetricsData();

      expect(metrics.success).toBe(0);
    });

    it('should convert true cached to 1', () => {
      execution.cached = true;

      const metrics = execution.toMetricsData();

      expect(metrics.cached).toBe(1);
    });

    it('should include retry count', () => {
      execution.retryCount = 3;

      const metrics = execution.toMetricsData();

      expect(metrics.retry_count).toBe(3);
    });

    it('should include http status from metadata', () => {
      execution.metadata = { httpStatus: 201 };

      const metrics = execution.toMetricsData();

      expect(metrics.http_status).toBe(201);
    });

    it('should convert rate limited flag to numeric', () => {
      execution.metadata = { rateLimited: true };

      const metrics = execution.toMetricsData();

      expect(metrics.rate_limited).toBe(1);
    });

    it('should return timestamp as milliseconds', () => {
      const metrics = execution.toMetricsData();

      expect(typeof metrics.timestamp).toBe('number');
      expect(metrics.timestamp).toBe(execution.createdAt.getTime());
    });
  });
});