import { EventEmitter } from 'events';

import { CodeExecution } from '../../../entities/code-execution.entity';
import { Organization } from '../../../entities/organization.entity';
import { Tool } from '../../../entities/tool.entity';
import { ToolExecution } from '../../../entities/tool-execution.entity';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';
import { ApprovalsService } from '../../approvals/approvals.service';
import { NodeSandboxService } from '../../tools/node-sandbox/node-sandbox.service';
import { CodeModeService } from '../code-mode.service';
import { codeModeLimits } from '../code-mode.settings';

jest.setTimeout(60_000);

/**
 * A change set nobody can wait for (docs/design/code-mode.md, part D,
 * "Gateway or MCP client"): held in Approvals as one request, run once a
 * person approves it, collected by calling again with the approval id.
 * Real sandbox workers; the executor and the approvals service are doubles.
 */
const ORG = 'org-1';
const GW = 'gw-1';
const PETSTORE = { sourceApi: { name: 'Petstore' } };
const FIND = Object.assign(new Tool(), { id: 'tool-find', organizationId: ORG, name: 'find_pets_by_status', sideEffect: 'read', metadata: PETSTORE, parameters: { type: 'object' } });
const DELETE = Object.assign(new Tool(), { id: 'tool-delete', organizationId: ORG, name: 'delete_pet', sideEffect: 'destructive', metadata: PETSTORE, parameters: { type: 'object' } });
const SCRIPT = "const sold = await petstore.findPetsByStatus({ status: 'sold' });\nfor (const p of sold) await petstore.deletePet({ petId: p.id });\nreturn sold.length;";

function setup(opts: { approvals?: boolean } = {}) {
  const executions = fakeRepository<CodeExecution>({ make: () => new CodeExecution(), idPrefix: 'code' });
  const toolExecutions = fakeRepository<ToolExecution>({ make: () => new ToolExecution(), idPrefix: 'te' });
  const tools = fakeRepository<Tool>({ make: () => new Tool(), idPrefix: 'tool', seed: [FIND, DELETE] });
  const orgs = fakeRepository<Organization>({ make: () => new Organization(), seed: [{ id: ORG, settings: {} } as any] });
  fakeManager([
    [CodeExecution, executions],
    [ToolExecution, toolExecutions],
    [Tool, tools],
    [Organization, orgs],
  ]);
  const executeTool = jest.fn(async (toolId: string, params: any, options: any) => {
    await toolExecutions.save(Object.assign(new ToolExecution(), { toolId, organizationId: ORG, parameters: params, success: true, codeExecutionId: options.codeExecutionId ?? null }));
    return { success: true, data: toolId === 'tool-find' ? [{ id: 7 }, { id: 9 }] : { deleted: true }, executionTime: 1, cached: false, rateLimited: false, retryCount: 0 };
  });
  const rows: any[] = [];
  const approvals = Object.assign(new EventEmitter(), {
    create: jest.fn(async (input: any) => {
      const row = { ...input, id: `appr-${rows.length + 1}`, status: 'pending', decisionReason: null };
      rows.push(row);
      return row;
    }),
    findInOrganization: jest.fn(async (id: string, organizationId: string) => rows.find((r) => r.id === id && r.organizationId === organizationId) ?? null),
  });
  const moduleRef = { get: jest.fn((cls: any) => (cls === ApprovalsService && opts.approvals !== false ? approvals : null)) };
  const service = new CodeModeService(executions as any, toolExecutions as any, new NodeSandboxService({} as any), { executeTool } as any, undefined, undefined, moduleRef as any);
  service.onModuleInit();
  const run = (params: Record<string, any>, gatewayId = GW) =>
    service.runUnattended({
      params,
      scope: [FIND, DELETE],
      context: { organizationId: ORG, userId: 'user-1', gatewayId },
      policy: undefined,
      grantsLeft: new Map(),
      limits: codeModeLimits(),
    });
  // Settling a decision is asynchronous (an event); wait for the script row to say so.
  const settled = async (id: string, status: string) => {
    for (let i = 0; i < 100 && executions.row(id)?.status !== status; i++) await new Promise((r) => setTimeout(r, 20));
  };
  return { service, executions, toolExecutions, executeTool, approvals, rows, run, settled };
}

describe('held change sets', () => {
  it('holds the deletions as one request, runs them once approved, and answers the caller who comes back', async () => {
    const { executions, toolExecutions, executeTool, approvals, rows, run, settled } = setup();
    const first = await run({ code: SCRIPT });

    // The read ran; both deletions wait in one request with no run behind it.
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(first.isError).toBe(false);
    expect(first.approvalId).toBe('appr-1');
    expect(first.forModel).toMatchObject({ status: 'waiting_for_approval', approvalId: 'appr-1' });
    expect(String(first.forModel.note)).toContain('"approvalId": "appr-1"');
    expect(approvals.create).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ runId: null, payload: { kind: 'change_set', codeExecutionId: first.codeExecutionId, _call: { gatewayId: GW, userId: 'user-1' } } });
    expect(rows[0].payload.changeSet.map((e: any) => e.arguments)).toEqual([{ petId: 7 }, { petId: 9 }]);
    expect(executions.row(first.codeExecutionId!)).toMatchObject({ status: 'waiting_approval', approvalRequestId: 'appr-1' });

    // Asked before anyone decided: still waiting, nothing ran.
    expect((await run({ approvalId: 'appr-1' })).forModel).toMatchObject({ status: 'waiting_for_approval' });

    // Approved: the set runs once, in order, as the caller and through the gateway, with the approval.
    rows[0].status = 'approved';
    approvals.emit('approval.decided', rows[0]);
    approvals.emit('approval.decided', rows[0]);
    await settled(first.codeExecutionId!, 'approved');
    await new Promise((r) => setTimeout(r, 100));
    expect(executeTool).toHaveBeenCalledTimes(3);
    for (const call of executeTool.mock.calls.slice(1)) {
      expect(call[2]).toMatchObject({ approvedGate: { approvalId: 'appr-1' }, gatewayId: GW, codeExecutionId: first.codeExecutionId });
    }
    expect(toolExecutions.rows().filter((r) => r.codeExecutionId === first.codeExecutionId)).toHaveLength(3);

    const back = await run({ approvalId: 'appr-1' });
    expect(back.forModel).toMatchObject({ status: 'completed', changeSet: { decision: 'approved', ran: [{ id: 1 }, { id: 2 }], failed: [], notRun: [] } });
  });

  it('runs none of a rejected set, and says so', async () => {
    const { executeTool, approvals, rows, run, settled } = setup();
    const first = await run({ code: SCRIPT });
    rows[0].status = 'rejected';
    rows[0].decisionReason = 'not today';
    approvals.emit('approval.decided', rows[0]);
    await settled(first.codeExecutionId!, 'rejected');
    expect(executeTool).toHaveBeenCalledTimes(1);
    const back = await run({ approvalId: 'appr-1' });
    expect(back.forModel).toMatchObject({ status: 'rejected', changeSet: { decision: 'rejected', ran: [], notRun: [{ id: 1 }, { id: 2 }] } });
    expect(String(back.forModel.note)).toContain('not today');
  });

  it('answers "no such change set" to anyone but the gateway the script ran on', async () => {
    const { run } = setup();
    await run({ code: SCRIPT });
    const other = await run({ approvalId: 'appr-1' }, 'gw-2');
    expect(other).toMatchObject({ isError: true, forModel: { error: 'There is no change set with that approvalId here.' } });
  });

  it('runs nothing and says so when nobody can be asked', async () => {
    const { executions, executeTool, run } = setup({ approvals: false });
    const first = await run({ code: SCRIPT });
    expect(first.isError).toBe(true);
    expect(String(first.forModel.note)).toMatch(/nobody can be asked/);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executions.row(first.codeExecutionId!)).toMatchObject({ status: 'rejected' });
  });
});
