import { CodeExecution } from '../../../entities/code-execution.entity';
import { Organization } from '../../../entities/organization.entity';
import { Tool } from '../../../entities/tool.entity';
import { ToolExecution } from '../../../entities/tool-execution.entity';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';
import { snapshotEnv } from '../../../test/env';
import { NodeSandboxService } from '../../tools/node-sandbox/node-sandbox.service';
import { QuickJsSandboxService } from '../../tools/node-sandbox/quickjs-sandbox.service';
import { CodeModeService } from '../code-mode.service';
import { codeModeLimits } from '../code-mode.settings';

jest.setTimeout(120_000);

/**
 * Which runtime runs a script (docs/design/code-mode.md, "P3 gate",
 * decision 1 as taken): QuickJS for outside clients on a gateway, the Node
 * code profile for agents and workflows inside almyty.
 */
const ORG = 'org-1';
const PETSTORE = { sourceApi: { name: 'Petstore' } };
const FIND = Object.assign(new Tool(), { id: 'tool-find', organizationId: ORG, name: 'find_pets_by_status', sideEffect: 'read', metadata: PETSTORE, parameters: { type: 'object' } });
const DELETE = Object.assign(new Tool(), { id: 'tool-delete', organizationId: ORG, name: 'delete_pet', sideEffect: 'destructive', metadata: PETSTORE, parameters: { type: 'object' } });
const GATEWAY = { id: 'gw-1', organizationId: ORG, type: 'mcp', visibility: 'org', teamId: null, ownerUserId: null, isSystem: false, configuration: { exposure: 'code' } } as any;

function setup(sandboxes: { node?: any; quickjs?: any }, orgSettings: Record<string, any> = {}) {
  const executions = fakeRepository<CodeExecution>({ make: () => new CodeExecution(), idPrefix: 'code' });
  const toolExecutions = fakeRepository<ToolExecution>({ make: () => new ToolExecution(), idPrefix: 'te' });
  const orgs = fakeRepository<Organization>({ make: () => new Organization(), seed: [{ id: ORG, settings: orgSettings } as any] });
  fakeManager([
    [CodeExecution, executions],
    [ToolExecution, toolExecutions],
    [Tool, fakeRepository<Tool>({ make: () => new Tool(), seed: [FIND, DELETE] })],
    [Organization, orgs],
  ]);
  const executeTool = jest.fn(async (toolId: string) => ({ success: true, data: toolId === 'tool-find' ? [{ id: 7 }, { id: 9 }] : { ok: true }, executionTime: 1, cached: false, rateLimited: false, retryCount: 0 }));
  const service = new CodeModeService(executions as any, toolExecutions as any, sandboxes.node ?? ({} as any), { executeTool } as any, undefined, undefined, undefined, sandboxes.quickjs);
  return { service, executeTool, executions };
}

describe('code mode runtimes', () => {
  it('runs a gateway script in QuickJS with the CPU budget, and an agent script in the Node profile', async () => {
    const done = { success: true, resultJson: '1', logs: '', durationMs: 1, cpuMs: 1 };
    const node = { executeCode: jest.fn(async () => done) };
    const quickjs = { executeCode: jest.fn(async () => done) };
    const { service } = setup({ node, quickjs }, { codeMode: { cpuBudgetMs: 2_000 } });

    await service.runOnGateway({ gateway: GATEWAY, userId: 'u-1', scope: [FIND], params: { code: 'return 1' } });
    expect(quickjs.executeCode).toHaveBeenCalledTimes(1);
    expect((quickjs.executeCode.mock.calls[0] as any[])[0]).toMatchObject({ cpuBudgetMs: 2_000, organizationId: ORG });
    expect(node.executeCode).not.toHaveBeenCalled();

    await service.run({ code: 'return 1', scope: [FIND], context: { organizationId: ORG }, policy: undefined, grantsLeft: new Map(), limits: codeModeLimits() });
    expect(node.executeCode).toHaveBeenCalledTimes(1);
    expect(quickjs.executeCode).toHaveBeenCalledTimes(1);
  });

  it('refuses a gateway script on a server without the QuickJS runtime, and never falls back to Node', async () => {
    const node = { executeCode: jest.fn() };
    const { service } = setup({ node });
    const answer = await service.runOnGateway({ gateway: GATEWAY, userId: 'u-1', scope: [FIND], params: { code: 'return 1' } });
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer.forModel)).toContain('not available on this server');
    expect(node.executeCode).not.toHaveBeenCalled();
  });

  it('lets an organization lower the CPU budget, never raise it', () => {
    const restore = snapshotEnv('CODE_MODE_CPU_MS');
    try {
      process.env.CODE_MODE_CPU_MS = '4000';
      expect(codeModeLimits({ cpuBudgetMs: 1000 }).cpuBudgetMs).toBe(1000);
      expect(codeModeLimits({ cpuBudgetMs: 90_000 }).cpuBudgetMs).toBe(4000);
      delete process.env.CODE_MODE_CPU_MS;
      expect(codeModeLimits().cpuBudgetMs).toBe(10_000);
    } finally {
      restore();
    }
  });

  it('brokers a gateway script end to end in real QuickJS: reads run, deletions stage', async () => {
    const { service, executeTool } = setup({ node: new NodeSandboxService({} as any), quickjs: new QuickJsSandboxService() });
    const answer = await service.runOnGateway({
      gateway: GATEWAY,
      userId: 'u-1',
      scope: [FIND, DELETE],
      params: { code: "const sold = await petstore.findPetsByStatus({ status: 'sold' });\nfor (const p of sold) await petstore.deletePet({ petId: p.id });\nlog(sold.length + ' staged');\nreturn sold.map((p) => p.id);" },
    });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]).toEqual(['tool-find', { status: 'sold' }, expect.objectContaining({ gatewayId: 'gw-1', holdForApproval: 'caller' })]);
    expect(answer.forModel).toMatchObject({ result: [7, 9], logs: '2 staged', calls: { staged: 2, ran: 1 } });
  });
});
