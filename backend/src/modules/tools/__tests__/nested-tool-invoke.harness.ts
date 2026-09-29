import { ToolExecutorService } from '../tool-executor.service';
import { membershipFixture } from '../../../test/execution-access.fixture';
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

/**
 * The timeout a harness tool runs under unless a spec is testing timeouts.
 *
 * A tool's timer covers every worker it waits on, and each worker here
 * boots through ts-node (transpiling sandbox-worker.ts and its imports):
 * about 350ms on an idle machine, several seconds when the suite shares
 * the CPU with other runs. A tight budget made depth, fan-out and pool
 * assertions -- none of which is about time -- race the machine's load:
 * the self-invoking tool waits on four boots in a row, and under load it
 * answered "timed out" instead of "depth". This budget is far above any
 * boot, and still ends a genuine hang well inside the spec's own timeout.
 */
export const UNTIMED_TOOL_TIMEOUT_MS = 60_000;

export function jsTool(id: string, code: string, extra: Record<string, any> = {}): any {
  return {
    id,
    name: id,
    organizationId: 'org-1',
    status: ToolStatus.ACTIVE,
    type: ToolType.FUNCTION,
    code,
    configuration: { timeout: UNTIMED_TOOL_TIMEOUT_MS },
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
        // A listed row is an attachment: switched on, on an org-wide
        // gateway, unless the row says otherwise.
        const row = gatewayTools[`${where.gatewayId}/${where.toolId}`];
        return row ? { isActive: true, gateway: { id: where.gatewayId, visibility: 'org' }, ...row } : null;
      }),
    } as any,
    undefined,
    // The real execution gate. 'u1' is not a user id, so only org tools run
    // -- every tool the harness serves.
    membershipFixture().executionAccess,
  );
  moduleRef.get.mockReturnValue(service);

  const executeSpy = jest.spyOn(service, 'executeTool');
  return { service, sandbox, executeSpy };
}
