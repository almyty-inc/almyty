import { ToolExecutorService } from '../tool-executor.service';
import { ToolHttpExecutor } from '../executors/tool-http.executor';
import { ToolScriptExecutor } from '../executors/tool-script.executor';
import { NodeSandboxService } from '../node-sandbox/node-sandbox.service';
import { SdkCodeAssemblerService } from '../node-sandbox/sdk-code-assembler.service';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';

/**
 * A ToolExecutorService wired to the REAL script executor and the REAL
 * node sandbox (worker threads, permission model on), with every
 * repository and helper around them stubbed. `tools.invoke` inside a
 * sandboxed tool therefore goes back through the same executeTool a
 * gateway or an agent run calls.
 */
export interface Harness {
  service: ToolExecutorService;
  sandbox: NodeSandboxService;
  executeSpy: jest.SpyInstance;
}

export function jsTool(id: string, code: string, extra: Record<string, any> = {}): any {
  return {
    id,
    name: id,
    organizationId: 'org-1',
    status: ToolStatus.ACTIVE,
    type: ToolType.FUNCTION,
    code,
    configuration: { timeout: 8000 },
    api: null,
    operation: null,
    ...extra,
  };
}

export function httpTool(id: string, url: string): any {
  return {
    id,
    name: id,
    organizationId: 'org-1',
    status: ToolStatus.ACTIVE,
    type: ToolType.API,
    httpConfig: { method: 'GET', path: url },
    configuration: {},
    api: null,
    operation: null,
  };
}

export function buildHarness(
  tools: Record<string, any>,
  gatewayTools: Record<string, any> = {},
): Harness {
  const sandbox = new NodeSandboxService({
    ensureInstalled: jest.fn(),
    listCached: jest.fn().mockReturnValue([]),
    clearCache: jest.fn(),
  } as any);

  const moduleRef: any = { get: jest.fn() };
  const scriptExecutor = new ToolScriptExecutor(
    { findOne: jest.fn().mockResolvedValue(null) } as any,
    sandbox,
    new SdkCodeAssemblerService(),
    moduleRef,
    { warmOrg: jest.fn() } as any,
  );

  const user = {
    hasPermissionInOrganization: () => true,
    organizationMemberships: [{ organizationId: 'org-1', role: 'member' }],
  };

  const service = new ToolExecutorService(
    {
      findOne: jest.fn(async ({ where }: any) => {
        const t = tools[where.id];
        return t && t.organizationId === where.organizationId ? t : null;
      }),
    } as any,
    {} as any,
    { findOne: jest.fn().mockResolvedValue(user) } as any,
    {} as any,
    new ToolHttpExecutor({ applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any),
    {} as any,
    scriptExecutor,
    {} as any,
    {
      checkRateLimit: jest.fn().mockResolvedValue({ limited: false }),
      getCachedResult: jest.fn().mockResolvedValue(null),
      cacheResult: jest.fn().mockResolvedValue(undefined),
    } as any,
    {
      validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }),
      recordExecution: jest.fn().mockResolvedValue(undefined),
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {
      findOne: jest.fn(async ({ where }: any) => {
        return gatewayTools[`${where.gatewayId}/${where.toolId}`] ?? null;
      }),
    } as any,
  );
  moduleRef.get.mockReturnValue(service);

  const executeSpy = jest.spyOn(service, 'executeTool');
  return { service, sandbox, executeSpy };
}
