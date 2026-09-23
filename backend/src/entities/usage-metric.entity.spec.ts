import {
  UsageMetric,
  MetricType,
  MetricStatus,
} from './usage-metric.entity';

describe('UsageMetric Entity', () => {
  let metric: UsageMetric;

  beforeEach(() => {
    metric = new UsageMetric();
    metric.id = 'metric-1';
    metric.type = MetricType.REQUEST_COUNT;
    metric.value = 1;
    metric.status = MetricStatus.SUCCESS;
    metric.timestamp = new Date();
  });

  describe('isError', () => {
    it('should return false for SUCCESS status', () => {
      metric.status = MetricStatus.SUCCESS;

      expect(metric.isError()).toBe(false);
    });

    it('should return true for ERROR status', () => {
      metric.status = MetricStatus.ERROR;

      expect(metric.isError()).toBe(true);
    });

    it('should return true for TIMEOUT status', () => {
      metric.status = MetricStatus.TIMEOUT;

      expect(metric.isError()).toBe(true);
    });

    it('should return true for RATE_LIMITED status', () => {
      metric.status = MetricStatus.RATE_LIMITED;

      expect(metric.isError()).toBe(true);
    });

    it('should return true for UNAUTHORIZED status', () => {
      metric.status = MetricStatus.UNAUTHORIZED;

      expect(metric.isError()).toBe(true);
    });
  });

  describe('getResponseTimeCategory', () => {
    beforeEach(() => {
      metric.type = MetricType.RESPONSE_TIME;
    });

    it('should return fast for response time < 200ms', () => {
      metric.value = 150;

      expect(metric.getResponseTimeCategory()).toBe('fast');
    });

    it('should return fast for response time exactly 199ms', () => {
      metric.value = 199;

      expect(metric.getResponseTimeCategory()).toBe('fast');
    });

    it('should return medium for response time 200-999ms', () => {
      metric.value = 500;

      expect(metric.getResponseTimeCategory()).toBe('medium');
    });

    it('should return medium for response time exactly 999ms', () => {
      metric.value = 999;

      expect(metric.getResponseTimeCategory()).toBe('medium');
    });

    it('should return slow for response time 1000-4999ms', () => {
      metric.value = 2500;

      expect(metric.getResponseTimeCategory()).toBe('slow');
    });

    it('should return slow for response time exactly 4999ms', () => {
      metric.value = 4999;

      expect(metric.getResponseTimeCategory()).toBe('slow');
    });

    it('should return very_slow for response time >= 5000ms', () => {
      metric.value = 10000;

      expect(metric.getResponseTimeCategory()).toBe('very_slow');
    });

    it('should return fast for non-response-time metrics', () => {
      metric.type = MetricType.REQUEST_COUNT;
      metric.value = 99999;

      expect(metric.getResponseTimeCategory()).toBe('fast');
    });
  });

  describe('getDimensionValue', () => {
    it('should return dimension value when present', () => {
      metric.dimensions = { region: 'us-east-1', service: 'api' };

      expect(metric.getDimensionValue('region')).toBe('us-east-1');
      expect(metric.getDimensionValue('service')).toBe('api');
    });

    it('should return undefined for missing dimension', () => {
      metric.dimensions = { region: 'us-east-1' };

      expect(metric.getDimensionValue('service')).toBeUndefined();
    });

    it('should return undefined when dimensions is null', () => {
      metric.dimensions = null;

      expect(metric.getDimensionValue('region')).toBeUndefined();
    });

    it('should return undefined when dimensions is undefined', () => {
      metric.dimensions = undefined;

      expect(metric.getDimensionValue('region')).toBeUndefined();
    });

    it('should handle numeric dimension values', () => {
      metric.dimensions = { count: 42, rate: 3.14 };

      expect(metric.getDimensionValue('count')).toBe(42);
      expect(metric.getDimensionValue('rate')).toBe(3.14);
    });

    it('should handle complex dimension values', () => {
      metric.dimensions = { config: { timeout: 5000, retries: 3 } };

      expect(metric.getDimensionValue('config')).toEqual({ timeout: 5000, retries: 3 });
    });
  });

  describe('createRequestMetric', () => {
    it('should create request metric with required fields', () => {
      const created = UsageMetric.createRequestMetric({
        status: MetricStatus.SUCCESS,
      });

      expect(created.type).toBe(MetricType.REQUEST_COUNT);
      expect(created.value).toBe(1);
      expect(created.status).toBe(MetricStatus.SUCCESS);
      expect(created.timestamp).toBeDefined();
    });

    it('should create request metric with all fields', () => {
      const created = UsageMetric.createRequestMetric({
        gatewayId: 'gateway-1',
        toolId: 'tool-1',
        userId: 'user-1',
        organizationId: 'org-1',
        status: MetricStatus.SUCCESS,
        metadata: { requestId: 'req-123' },
      });

      expect(created.gatewayId).toBe('gateway-1');
      expect(created.toolId).toBe('tool-1');
      expect(created.userId).toBe('user-1');
      expect(created.organizationId).toBe('org-1');
      expect(created.metadata).toEqual({ requestId: 'req-123' });
    });

    it('should create request metric for error status', () => {
      const created = UsageMetric.createRequestMetric({
        status: MetricStatus.ERROR,
        metadata: { errorMessage: 'API timeout' },
      });

      expect(created.status).toBe(MetricStatus.ERROR);
      expect(created.metadata.errorMessage).toBe('API timeout');
    });

    it('should set timestamp to current time', () => {
      const beforeTime = Date.now();
      const created = UsageMetric.createRequestMetric({
        status: MetricStatus.SUCCESS,
      });
      const afterTime = Date.now();

      expect(created.timestamp.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(created.timestamp.getTime()).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('createResponseTimeMetric', () => {
    it('should create response time metric with required fields', () => {
      const created = UsageMetric.createResponseTimeMetric({
        responseTime: 250,
        status: MetricStatus.SUCCESS,
      });

      expect(created.type).toBe(MetricType.RESPONSE_TIME);
      expect(created.value).toBe(250);
      expect(created.status).toBe(MetricStatus.SUCCESS);
      expect(created.timestamp).toBeDefined();
    });

    it('should create response time metric with all fields', () => {
      const created = UsageMetric.createResponseTimeMetric({
        gatewayId: 'gateway-1',
        toolId: 'tool-1',
        userId: 'user-1',
        organizationId: 'org-1',
        responseTime: 1500,
        status: MetricStatus.SUCCESS,
        metadata: { endpoint: '/api/v1/tools' },
      });

      expect(created.value).toBe(1500);
      expect(created.gatewayId).toBe('gateway-1');
      expect(created.toolId).toBe('tool-1');
      expect(created.userId).toBe('user-1');
      expect(created.organizationId).toBe('org-1');
      expect(created.metadata).toEqual({ endpoint: '/api/v1/tools' });
    });

    it('should handle fast response times', () => {
      const created = UsageMetric.createResponseTimeMetric({
        responseTime: 50,
        status: MetricStatus.SUCCESS,
      });

      expect(created.value).toBe(50);
    });

    it('should handle slow response times', () => {
      const created = UsageMetric.createResponseTimeMetric({
        responseTime: 10000,
        status: MetricStatus.TIMEOUT,
      });

      expect(created.value).toBe(10000);
      expect(created.status).toBe(MetricStatus.TIMEOUT);
    });
  });

  describe('Integration Tests', () => {
    it('should correctly categorize created response time metrics', () => {
      const fastMetric = UsageMetric.createResponseTimeMetric({
        responseTime: 100,
        status: MetricStatus.SUCCESS,
      });

      const slowMetric = UsageMetric.createResponseTimeMetric({
        responseTime: 3000,
        status: MetricStatus.SUCCESS,
      });

      expect(fastMetric.getResponseTimeCategory()).toBe('fast');
      expect(slowMetric.getResponseTimeCategory()).toBe('slow');
    });

    it('should correctly identify error metrics', () => {
      const errorMetric = UsageMetric.createRequestMetric({
        status: MetricStatus.ERROR,
      });

      const successMetric = UsageMetric.createRequestMetric({
        status: MetricStatus.SUCCESS,
      });

      expect(errorMetric.isError()).toBe(true);
      expect(successMetric.isError()).toBe(false);
    });

    it('should access dimensions', () => {
      const metric = new UsageMetric();
      metric.dimensions = { requestCount: 450, timeWindowSeconds: 30 };

      expect(metric.getDimensionValue('requestCount')).toBe(450);
      expect(metric.getDimensionValue('timeWindowSeconds')).toBe(30);
    });
  });
});
