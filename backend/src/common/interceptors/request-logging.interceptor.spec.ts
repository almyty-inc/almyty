import { of } from 'rxjs';
import { RequestLoggingInterceptor, REQUEST_LOG_BODY_LIMIT } from './request-logging.interceptor';
import { setProtocolContext } from './protocol-context';

describe('RequestLoggingInterceptor', () => {
  let interceptor: RequestLoggingInterceptor;
  let requestLogRepository: { save: jest.Mock };
  let usageMetricRepository: { save: jest.Mock };

  const makeContext = (request: any, statusCode = 200, response?: any) => ({
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response ?? { statusCode },
    }),
  });

  const run = async (request: any, statusCode = 200, response?: any, body?: any) => {
    const next = { handle: () => of(body ?? { ok: true }) };
    await new Promise<void>((resolve, reject) => {
      interceptor
        .intercept(makeContext(request, statusCode, response) as any, next as any)
        .subscribe({ complete: resolve, error: reject });
    });
    // logRequest fires in the tap; the repository saves are fire-and-forget
    // promises — yield once so they have been issued.
    await new Promise((r) => setImmediate(r));
  };

  beforeEach(() => {
    requestLogRepository = { save: jest.fn().mockResolvedValue({}) };
    usageMetricRepository = { save: jest.fn().mockResolvedValue({}) };
    interceptor = new RequestLoggingInterceptor(
      requestLogRepository as any,
      usageMetricRepository as any,
    );
  });

  it('logs unified-endpoint traffic using the protocol context', async () => {
    const request: any = {
      method: 'POST',
      path: '/acme/petstore-mcp',
      headers: {},
      body: { jsonrpc: '2.0', method: 'tools/list' },
    };
    setProtocolContext(request, {
      gatewayId: 'gw-1',
      organizationId: 'org-1',
      protocol: 'mcp',
    });

    await run(request);

    expect(requestLogRepository.save).toHaveBeenCalledTimes(1);
    const log = requestLogRepository.save.mock.calls[0][0];
    expect(log.gatewayId).toBe('gw-1');
    expect(log.metadata.protocol).toBe('mcp');
    expect(log.metadata.organizationId).toBe('org-1');

    // request_count + response_time, written in ONE round trip
    expect(usageMetricRepository.save).toHaveBeenCalledTimes(1);
    const metrics = usageMetricRepository.save.mock.calls[0][0];
    expect(Array.isArray(metrics)).toBe(true);
    expect(metrics).toHaveLength(2);
    const metric = metrics[0];
    expect(metric.gatewayId).toBe('gw-1');
    expect(metric.organizationId).toBe('org-1');
  });

  it('serializes each body exactly once and issues one insert per table', async () => {
    // A body whose toJSON counts how many times it is serialized.
    let requestSerializations = 0;
    let responseSerializations = 0;
    const request: any = {
      method: 'POST',
      path: '/mcp',
      headers: {},
      body: { toJSON: () => { requestSerializations++; return { in: 'x'.repeat(50) }; } },
    };
    const responseBody = {
      toJSON: () => { responseSerializations++; return { out: 'y'.repeat(50) }; },
    };

    await run(request, 200, undefined, responseBody);

    // Was 3 per body: truncateBody + estimateSize (log) + estimateSize (metric).
    expect(requestSerializations).toBe(1);
    expect(responseSerializations).toBe(1);

    // Was 3 round trips: the log, then each metric separately.
    expect(requestLogRepository.save).toHaveBeenCalledTimes(1);
    expect(usageMetricRepository.save).toHaveBeenCalledTimes(1);

    // The size the log records and the size the metric records are the same
    // number, computed once.
    const log = requestLogRepository.save.mock.calls[0][0];
    const [countMetric] = usageMetricRepository.save.mock.calls[0][0];
    expect(countMetric.metadata.responseSize).toBe(log.responseSize);
    expect(countMetric.metadata.requestSize).toBe(log.requestSize);
    expect(log.responseSize).toBeGreaterThan(0);
  });

  it('still truncates an oversized body at REQUEST_LOG_BODY_LIMIT', async () => {
    const huge = { blob: 'z'.repeat(REQUEST_LOG_BODY_LIMIT * 2) };
    await run({ method: 'POST', path: '/mcp', headers: {}, body: {} }, 200, undefined, huge);

    const log = requestLogRepository.save.mock.calls[0][0];
    expect(log.responseBody.endsWith('... [truncated]')).toBe(true);
    expect(log.responseBody).toHaveLength(REQUEST_LOG_BODY_LIMIT + '... [truncated]'.length);
    // …but the recorded size is the full byte length, not the truncated one.
    expect(log.responseSize).toBeGreaterThan(REQUEST_LOG_BODY_LIMIT);
  });

  it('does not log slug paths without protocol context', async () => {
    await run({ method: 'GET', path: '/acme/some-agent-page', headers: {} });

    expect(requestLogRepository.save).not.toHaveBeenCalled();
    expect(usageMetricRepository.save).not.toHaveBeenCalled();
  });

  it('no longer logs management API calls under /gateways/', async () => {
    await run({
      method: 'GET',
      path: '/gateways/06e70dde-ba7b-45f6-9976-7bd97a5b06c0/auth/api-keys',
      headers: {},
      user: { id: 'u1', currentOrganizationId: 'org-1' },
    });

    expect(requestLogRepository.save).not.toHaveBeenCalled();
    expect(usageMetricRepository.save).not.toHaveBeenCalled();
  });

  it('still logs fixed protocol routes via path detection', async () => {
    await run({
      method: 'POST',
      path: '/mcp',
      headers: {},
      body: { jsonrpc: '2.0', method: 'tools/list' },
      user: { id: 'u1', currentOrganizationId: 'org-1' },
    });

    expect(requestLogRepository.save).toHaveBeenCalledTimes(1);
    const log = requestLogRepository.save.mock.calls[0][0];
    expect(log.metadata.protocol).toBe('mcp');
    expect(log.metadata.organizationId).toBe('org-1');
  });

  it('logs @Res handlers that return the circular response object', async () => {
    // res.json(...) returns the Express response — a circular structure
    // that JSON.stringify rejects. The interceptor must not let that
    // abort the write.
    const response: any = { statusCode: 200 };
    response.self = response;
    const request: any = {
      method: 'POST',
      path: '/acme/petstore-mcp',
      headers: {},
      body: { jsonrpc: '2.0', method: 'tools/list' },
    };
    setProtocolContext(request, { gatewayId: 'gw-1', organizationId: 'org-1', protocol: 'mcp' });

    await run(request, 200, response, response);

    expect(requestLogRepository.save).toHaveBeenCalledTimes(1);
    const log = requestLogRepository.save.mock.calls[0][0];
    expect(log.responseBody).toBeNull();
    expect(log.gatewayId).toBe('gw-1');
    expect(usageMetricRepository.save).toHaveBeenCalledTimes(1);
  });

  it('records unauthorized status for 403 responses', async () => {
    const request: any = { method: 'POST', path: '/mcp', headers: {}, body: {} };
    await run(request, 403);

    const [metric] = usageMetricRepository.save.mock.calls[0][0];
    expect(metric.status).toBe('unauthorized');
  });
});

/**
 * What a refused request records. The record existed; nothing in it
 * answered "why", which is the whole question on an auth ticket.
 */
describe('RequestLoggingInterceptor — refusals are legible', () => {
  const { HttpException, HttpStatus } = require('@nestjs/common');
  const { throwError } = require('rxjs');
  const { runWithRequestContext } = require('../request-context');

  let interceptor: RequestLoggingInterceptor;
  let requestLogRepository: { save: jest.Mock };
  let usageMetricRepository: { save: jest.Mock };

  const runFailing = async (request: any, error: any, statusCode = 403) => {
    const next = { handle: () => throwError(() => error) };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ statusCode }),
      }),
    };
    await new Promise<void>((resolve) => {
      interceptor.intercept(context as any, next as any).subscribe({
        error: () => resolve(),
        complete: () => resolve(),
      });
    });
    await new Promise((r) => setImmediate(r));
  };

  const savedLog = () => requestLogRepository.save.mock.calls[0][0];

  beforeEach(() => {
    requestLogRepository = { save: jest.fn().mockResolvedValue({}) };
    usageMetricRepository = { save: jest.fn().mockResolvedValue({}) };
    interceptor = new RequestLoggingInterceptor(
      requestLogRepository as any,
      usageMetricRepository as any,
    );
  });

  it('records the real reason, not the literal string "Http Exception"', async () => {
    // Exactly the payload shape gateway-resolver throws. Nest derives the
    // exception's own `message` from the payload and falls back to the
    // class name when there is no `message` key — which is how every
    // refused gateway request came to record "Http Exception".
    const exception = new HttpException(
      {
        message: 'API key is not valid for this gateway',
        error: 'API key is not valid for this gateway',
        errorCode: 'INVALID_API_KEY',
      },
      HttpStatus.FORBIDDEN,
    );

    await runFailing({ method: 'POST', path: '/mcp/acme/petstore', headers: {} }, exception);

    const log = savedLog();
    expect(log.errorMessage).toBe('API key is not valid for this gateway');
    expect(log.errorMessage).not.toBe('Http Exception');
    expect(log.errorCode).toBe('INVALID_API_KEY');
  });

  it('records the reason even from a payload that has only `error`', async () => {
    // The pre-fix payload shape: no `message` key at all, so
    // `exception.message` really is the class name.
    const exception = new HttpException(
      { error: 'No valid authentication provided', errorCode: 'NO_AUTH' },
      HttpStatus.UNAUTHORIZED,
    );
    expect(exception.message).toBe('Http Exception');

    await runFailing({ method: 'POST', path: '/mcp/acme/petstore', headers: {} }, exception, 401);

    expect(savedLog().errorMessage).toBe('No valid authentication provided');
    expect(savedLog().errorCode).toBe('NO_AUTH');
  });

  it('records which gateway auth config refused', async () => {
    const exception: any = new HttpException(
      { message: 'API key expired', errorCode: 'KEY_EXPIRED' },
      HttpStatus.FORBIDDEN,
    );
    exception.authDiagnostics = {
      authConfigId: 'auth-cfg-42',
      authConfigType: 'api_key',
      triedConfigCount: 2,
      gatewayId: 'gw-1',
    };

    await runFailing({ method: 'POST', path: '/mcp/acme/petstore', headers: {} }, exception);

    expect(savedLog().metadata.auth).toEqual({
      authConfigId: 'auth-cfg-42',
      authConfigType: 'api_key',
      triedConfigCount: 2,
      gatewayId: 'gw-1',
    });
  });

  it('records the rate-limit bucket that tripped, not just the message', async () => {
    const exception = new HttpException(
      {
        message: 'Gateway rate limit exceeded: 100 requests per hour',
        errorCode: 'SURFACE_RATE_LIMITED',
        bucket: { window: 'hour', limit: 100, scope: 'surface' },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );

    await runFailing({ method: 'POST', path: '/mcp/acme/petstore', headers: {} }, exception, 429);

    const log = savedLog();
    expect(log.errorCode).toBe('SURFACE_RATE_LIMITED');
    expect(log.metadata.rateLimit).toEqual({ window: 'hour', limit: 100, scope: 'surface' });
  });

  it('writes the minted correlation id, not a null from an absent header', async () => {
    await new Promise<void>((resolve) => {
      runWithRequestContext({ requestId: 'req-corr-1' }, async () => {
        await runFailing(
          { method: 'POST', path: '/mcp/acme/petstore', headers: {} },
          new HttpException({ message: 'nope', errorCode: 'NO_AUTH' }, 401),
          401,
        );
        resolve();
      });
    });

    expect(savedLog().requestId).toBe('req-corr-1');
  });
});
