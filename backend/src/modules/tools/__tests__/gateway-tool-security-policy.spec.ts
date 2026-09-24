import { membershipFixture } from '../../../test/execution-access.fixture';
import { fakeRepository } from '../../../test/fake-repository';
import axios from 'axios';

import { ToolExecutorService } from '../tool-executor.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';

// axios is a callable default export with helpers hung off it, so the mock
// has to be built by hand: a bare `jest.mock('axios')` yields an object the
// executors cannot call.
jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * `gateway_tools.securityPolicy` end to end: a policy stored on the
 * gateway_tool row has to change what the outbound request is allowed to
 * do. Before this was wired, every assertion below passed the tool call
 * straight through to axios -- the column was written by the PATCH endpoint,
 * rendered by the dashboard form, and read by nothing.
 */
const mockedAxios = axios as unknown as jest.Mock;

function makeTool(overrides: Record<string, any> = {}) {
  return {
    id: 'tool-1',
    name: 'fixture',
    organizationId: 'org-1',
    status: ToolStatus.ACTIVE,
    type: ToolType.API,
    httpConfig: { method: 'GET', path: 'https://upstream.example.com/things' },
    configuration: {},
    api: null,
    operation: null,
    ...overrides,
  } as any;
}

function buildExecutor(opts: { tool?: any; gatewayTool?: any } = {}) {
  const tool = opts.tool ?? makeTool();

  const authService = {
    applyApiAuth: jest.fn(),
    applyInlineToolAuth: jest.fn(),
  } as any;
  const httpExecutor = new ToolHttpExecutor(authService);

  // The tool attached, switched on, to an org-wide gw-1: the gateway serves
  // it (gateway-servable), so what is under test is only the row's policy.
  const gatewayToolRepository = fakeRepository<any>(
    opts.gatewayTool
      ? [{ gatewayId: 'gw-1', toolId: tool.id, isActive: true, gateway: { id: 'gw-1', visibility: 'org' }, ...opts.gatewayTool }]
      : [],
  );
  const stats = {
    validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }),
    recordExecution: jest.fn().mockResolvedValue(undefined),
  };
  const cacheRateLimit = {
    checkRateLimit: jest.fn().mockResolvedValue({ limited: false }),
    getCachedResult: jest.fn().mockResolvedValue(null),
    cacheResult: jest.fn().mockResolvedValue(undefined),
  };

  const service = new ToolExecutorService(
    { findOne: jest.fn().mockResolvedValue(tool) } as any, // toolRepository
    {} as any, // toolExecutionRepository
    { findOne: jest.fn() } as any, // userRepository
    {} as any, // redis
    httpExecutor,
    {} as any, // protocolExecutor
    {} as any, // scriptExecutor
    {} as any, // auditLogService
    cacheRateLimit as any,
    stats as any,
    {} as any, // runnerCalls
    {} as any, // memoryService
    {} as any, // mcpSources
    gatewayToolRepository as any,
    undefined, // pluginManager
    membershipFixture().executionAccess, // the real execution gate
  );

  return { service, gatewayToolRepository, stats, httpExecutor };
}

// `userId: ''` is falsy, which skips the user-permission lookup -- the same
// path an unauthenticated MCP gateway session takes.
const baseOptions = { userId: '', organizationId: 'org-1' };

describe('gateway_tools.securityPolicy is enforced at tool-execution time', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
  });

  it('refuses a host that the gateway tool policy does not allow', async () => {
    const { service, gatewayToolRepository } = buildExecutor({
      gatewayTool: { id: 'gt-1', securityPolicy: { allowedDomains: ['api.allowed.com'] } },
    });

    const result = await service.executeTool('tool-1', {}, {
      ...baseOptions,
      gatewayId: 'gw-1',
    });

    expect(gatewayToolRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gatewayId: 'gw-1', toolId: 'tool-1' } }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('allowed-domain list');
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('refuses plain http when the gateway tool policy requires HTTPS', async () => {
    const { service } = buildExecutor({
      tool: makeTool({ httpConfig: { method: 'GET', path: 'http://upstream.example.com/things' } }),
      gatewayTool: { id: 'gt-1', securityPolicy: { requireHttps: true } },
    });

    const result = await service.executeTool('tool-1', {}, {
      ...baseOptions,
      gatewayId: 'gw-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTPS');
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('refuses a method the gateway tool policy does not allow', async () => {
    const { service } = buildExecutor({
      tool: makeTool({ httpConfig: { method: 'DELETE', path: 'https://upstream.example.com/x' } }),
      gatewayTool: { id: 'gt-1', securityPolicy: { allowedHttpMethods: ['GET'] } },
    });

    const result = await service.executeTool('tool-1', {}, {
      ...baseOptions,
      gatewayId: 'gw-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not an allowed method');
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('narrows the response size cap axios is given', async () => {
    const { service } = buildExecutor({
      gatewayTool: { id: 'gt-1', securityPolicy: { maxResponseSizeBytes: 2048 } },
    });

    const result = await service.executeTool('tool-1', {}, {
      ...baseOptions,
      gatewayId: 'gw-1',
    });

    expect(result.success).toBe(true);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    expect(mockedAxios.mock.calls[0][0].maxContentLength).toBe(2048);
  });

  it('lets an allowed host through', async () => {
    const { service } = buildExecutor({
      gatewayTool: {
        id: 'gt-1',
        securityPolicy: { allowedDomains: ['upstream.example.com'], requireHttps: true },
      },
    });

    const result = await service.executeTool('tool-1', {}, {
      ...baseOptions,
      gatewayId: 'gw-1',
    });

    expect(result.success).toBe(true);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });

  it('does not look up a policy for a call that did not come through a gateway', async () => {
    const { service, gatewayToolRepository } = buildExecutor();

    const result = await service.executeTool('tool-1', {}, baseOptions);

    expect(gatewayToolRepository.findOne).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('honours a policy the caller already resolved rather than overwriting it', async () => {
    const { service, gatewayToolRepository } = buildExecutor({
      gatewayTool: { id: 'gt-1', securityPolicy: { allowedDomains: ['upstream.example.com'] } },
    });

    const result = await service.executeTool('tool-1', {}, {
      ...baseOptions,
      gatewayId: 'gw-1',
      securityPolicy: { blockedDomains: ['upstream.example.com'] },
    });

    // The row is still read -- gateway_tools.permissions is an access
    // control and must not be skippable by passing an unrelated argument --
    // but the caller's policy wins over the row's.
    expect(gatewayToolRepository.findOne).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked-domain list');
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('a gateway tool with no policy row behaves exactly as before', async () => {
    const { service } = buildExecutor({ gatewayTool: { id: 'gt-1', securityPolicy: null } });

    const result = await service.executeTool('tool-1', {}, {
      ...baseOptions,
      gatewayId: 'gw-1',
    });

    expect(result.success).toBe(true);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
  });
});
