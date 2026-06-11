import { of } from 'rxjs';
import { RequestLoggingInterceptor } from './request-logging.interceptor';
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

    // request_count + response_time
    expect(usageMetricRepository.save).toHaveBeenCalledTimes(2);
    const metric = usageMetricRepository.save.mock.calls[0][0];
    expect(metric.gatewayId).toBe('gw-1');
    expect(metric.organizationId).toBe('org-1');
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
    expect(usageMetricRepository.save).toHaveBeenCalledTimes(2);
  });

  it('records unauthorized status for 403 responses', async () => {
    const request: any = { method: 'POST', path: '/mcp', headers: {}, body: {} };
    await run(request, 403);

    const metric = usageMetricRepository.save.mock.calls[0][0];
    expect(metric.status).toBe('unauthorized');
  });
});
