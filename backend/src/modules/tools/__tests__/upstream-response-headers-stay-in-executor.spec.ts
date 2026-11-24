import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';

import { ToolExecutorService } from '../tool-executor.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { safeResponseHeaders } from '../executors/safe-response-headers';
import { ToolsController } from '../tools.controller';
import { GatewaySkillsController } from '../../gateways/gateway-skills.controller';
import { UtcpService } from '../../mcp/utcp.service';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = (e: any) => !!e?.isAxiosError;
  return { __esModule: true, default: fn, isAxiosError: (e: any) => !!e?.isAxiosError };
});
const mockedAxios = axios as unknown as jest.Mock;

/**
 * An imported Apollo tool handed back Apollo's `X-CSRF-TOKEN` and its
 * `_leadgenie_session` cookie in `metadata.headers`, on the tool test page
 * and through the gateways. Upstream session, CSRF and auth headers stay
 * in the executor; what is useful about the answer (type, rate limits,
 * paging, request id) still comes out.
 */
const APOLLO_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'content-length': '42',
  'set-cookie': ['_leadgenie_session=abc123; path=/; HttpOnly', 'other=1'],
  'x-csrf-token': 'csrf-secret-value',
  'www-authenticate': 'Bearer realm="apollo"',
  'proxy-authenticate': 'Basic',
  authorization: 'Bearer leaked',
  'x-session-id': 'sess-1',
  'x-api-key': 'key-1',
  'x-amzn-remapped-authorization': 'aws-secret',
  'x-ratelimit-remaining': '99',
  'x-rate-limit-reset': '1700000000',
  'retry-after': '3',
  link: '<https://api.apollo.io/v1/people?page=2>; rel="next"',
  etag: 'W/"1"',
  'x-request-id': 'req-apollo-1',
};

const SECRETS = ['_leadgenie_session', 'csrf-secret-value', 'Bearer realm', 'Bearer leaked', 'sess-1', 'key-1', 'aws-secret'];

function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/set-cookie|x-csrf-token|www-authenticate|proxy-authenticate|"authorization"/i);
}

const api = { id: 'api-apollo', name: 'Apollo', type: 'openapi', baseUrl: 'https://api.apollo.io', organizationId: 'org-1', headers: {} };
const tool = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'apollo_people_search',
  organizationId: 'org-1',
  status: ToolStatus.ACTIVE,
  type: ToolType.API,
  visibility: 'org',
  teamId: null,
  createdBy: 'u-1',
  httpConfig: null,
  authConfig: null,
  parameters: { type: 'object', properties: {} },
  configuration: { cache: { enabled: true, shared: true } },
  api,
  operation: { id: 'op-1', method: 'POST', endpoint: '/v1/mixed_people/search', parameters: {}, api },
};
const gateway = { id: '22222222-2222-4222-8222-222222222222', organizationId: 'org-1', visibility: 'org' };
const gatewayRow = { id: 'gt-1', gatewayId: gateway.id, toolId: tool.id, isActive: true, tool, gateway, securityPolicy: null };

function build(httpExecutor: any = new ToolHttpExecutor({ applyApiAuth: jest.fn(), applyToolAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any)) {
  const stats = { validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }), recordExecution: jest.fn().mockResolvedValue(undefined) };
  const cache = { checkRateLimit: jest.fn().mockResolvedValue({ limited: false }), getCachedResult: jest.fn().mockResolvedValue(null), cacheResult: jest.fn().mockResolvedValue(undefined) };
  const m = membershipFixture();
  m.member('org-1', 'u-1');
  const executor = new ToolExecutorService(
    fakeRepository<any>([tool]) as any,
    {} as any,
    { findOne: jest.fn().mockResolvedValue({ hasPermissionInOrganization: () => true, organizationMemberships: [] }) } as any,
    {} as any,
    httpExecutor,
    {} as any,
    {} as any,
    {} as any,
    cache as any,
    stats as any,
    {} as any,
    {} as any,
    {} as any,
    fakeRepository<any>([gatewayRow]) as any,
    undefined,
    m.executionAccess,
  );
  return { executor, stats, cache };
}

const upstreamOk = () => mockedAxios.mockResolvedValue({ status: 200, data: { people: [] }, headers: { ...APOLLO_HEADERS } });
const upstream401 = () =>
  mockedAxios.mockRejectedValue(
    Object.assign(new Error('Request failed with status code 401'), {
      isAxiosError: true,
      response: { status: 401, data: { message: 'unauthorized' }, headers: { ...APOLLO_HEADERS } },
    }),
  );

describe('upstream response headers stay in the executor', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('keeps the useful headers and drops session, csrf and auth ones', () => {
    const kept = safeResponseHeaders(APOLLO_HEADERS)!;
    expectNoSecrets(kept);
    expect(kept).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'content-length': '42',
      'x-ratelimit-remaining': '99',
      'x-rate-limit-reset': '1700000000',
      'retry-after': '3',
      link: '<https://api.apollo.io/v1/people?page=2>; rel="next"',
      etag: 'W/"1"',
      'x-request-id': 'req-apollo-1',
    });
    // Any name that reads like a secret is dropped even if it looks routine.
    expect(safeResponseHeaders({ 'x-ratelimit-token': 'x', 'cache-control': 'no-store' })).toEqual({ 'cache-control': 'no-store' });
    expect(safeResponseHeaders(undefined)).toBeUndefined();
  });

  it('flattens AxiosHeaders instances', () => {
    const { AxiosHeaders } = jest.requireActual('axios');
    const h = new AxiosHeaders({ 'Content-Type': 'application/json', 'Set-Cookie': ['s=1'] });
    expect(safeResponseHeaders(h)).toEqual({ 'content-type': 'application/json' });
  });

  it('a successful call: the result, its execution row and its cache entry carry no secret header', async () => {
    upstreamOk();
    const { executor, stats, cache } = build();
    const result = await executor.executeTool(tool.id, {}, { organizationId: 'org-1', userId: 'u-1', runId: 'run-1' } as any);
    expect(result.success).toBe(true);
    expect(result.metadata?.headers).toMatchObject({ 'content-type': 'application/json; charset=utf-8', 'x-ratelimit-remaining': '99', link: expect.stringContaining('page=2') });
    expect(result.metadata?.requestId).toBe('req-apollo-1');
    expectNoSecrets(result);
    expect(stats.recordExecution).toHaveBeenCalled();
    expectNoSecrets(stats.recordExecution.mock.calls);
    expect(cache.cacheResult).toHaveBeenCalled();
    expectNoSecrets(cache.cacheResult.mock.calls);
  });

  it('a failed call carries no secret header either', async () => {
    upstream401();
    const { executor } = build();
    const result = await executor.executeTool(tool.id, {}, { organizationId: 'org-1', userId: 'u-1', runId: 'run-1', retries: 0 } as any);
    expect(result.success).toBe(false);
    expect(result.metadata?.httpStatus).toBe(401);
    expectNoSecrets(result);
  });

  it('any executor result reaching a caller is reduced, not only the HTTP executor one', async () => {
    const raw = { success: true, data: {}, executionTime: 1, cached: false, rateLimited: false, retryCount: 0, metadata: { httpStatus: 200, headers: { ...APOLLO_HEADERS } } };
    const stub = { executeOperation: jest.fn().mockResolvedValue(raw), executeHttpTool: jest.fn().mockResolvedValue(raw), executeApiTool: jest.fn().mockResolvedValue(raw) };
    const { executor } = build(new Proxy(stub, { get: (t: any, k) => t[k] ?? jest.fn().mockResolvedValue(raw) }));
    const result = await executor.executeTool(tool.id, {}, { organizationId: 'org-1', userId: 'u-1', runId: 'run-1' } as any);
    expectNoSecrets(result);
  });

  it('the tool test endpoint (POST /tools/:id/execute) returns no secret header', async () => {
    upstreamOk();
    const { executor } = build();
    const controller = new ToolsController({} as any, {} as any, executor, {} as any, {} as any, {} as any, {} as any);
    const body = await controller.executeTool('org-1', tool.id, { parameters: {} } as any, { user: { id: 'u-1' } });
    expect(body.success).toBe(true);
    expect((body.metadata as any).headers).toMatchObject({ 'content-type': expect.any(String) });
    expectNoSecrets(body);
  });

  it('the skills gateway execute endpoint returns no secret header', async () => {
    upstreamOk();
    const { executor } = build();
    const gateways = { getGateway: jest.fn().mockResolvedValue({ ...gateway, tools: [gatewayRow] }), incrementRequestCount: jest.fn() };
    const controller = new GatewaySkillsController(gateways as any, {} as any, {} as any, executor, {} as any, {} as any);
    const body = await controller.executeSkill(gateway.id, tool.id, { parameters: {} }, { user: { id: 'u-1', currentOrganizationId: 'org-1' } });
    expect((body.data as any).success).toBe(true);
    expectNoSecrets(body);
  });

  it('a UTCP call that fails upstream returns no secret header in its error details', async () => {
    upstream401();
    const { executor } = build();
    const utcp = new UtcpService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, executor, {} as any);
    const out = await utcp.executeUtcpTool({ toolId: tool.id, parameters: {} } as any, 'org-1', 'u-1');
    expect(out.success).toBe(false);
    expectNoSecrets(out);
  });

  it('agent run steps and the model only ever get the tool data, never its metadata', () => {
    // The autonomous runtime persists `run.steps[].output` and the tool
    // message the model reads; both are built from `.data`/`.error`.
    const src = readFileSync(join(__dirname, '../../agents/agent-step-processor.ts'), 'utf8');
    const outputs = [...src.matchAll(/output:\s*([^\n]+)/g)].map((m) => m[1]);
    expect(outputs.length).toBeGreaterThan(0);
    for (const o of outputs) expect(o).not.toMatch(/metadata|headers|\.\.\.(toolResult|result)\b/);
    expect(src).not.toMatch(/createToolResultMessage\([^)]*metadata/);
  });
});
