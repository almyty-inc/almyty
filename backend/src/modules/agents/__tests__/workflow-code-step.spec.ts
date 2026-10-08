import { EventEmitter } from 'events';

import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver } from '../agent-template-resolver';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { CodeExecution } from '../../../entities/code-execution.entity';
import { Organization } from '../../../entities/organization.entity';
import { Tool } from '../../../entities/tool.entity';
import { ToolExecution } from '../../../entities/tool-execution.entity';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { userPrincipal } from '../../../common/authorization/execution-access.service';
import { ApprovalsService } from '../../approvals/approvals.service';
import { CodeModeService } from '../../code-mode/code-mode.service';
import { NodeSandboxService } from '../../tools/node-sandbox/node-sandbox.service';
import { WorkflowApprovalResumeService } from '../workflow-approval-resume.service';

jest.setTimeout(60_000);

/**
 * The workflow Code step (docs/design/code-mode.md, part E), end to end:
 * the engine runs a script over the agent's tools with the run's input as
 * `context`, the step's result is what the script returns, and changes
 * that need a person are held in Approvals (a workflow cannot pause).
 * Real sandbox workers; the tool executor is a double.
 */
const ORG = 'org-1';
const PETSTORE = { sourceApi: { name: 'Petstore' } };
const FIND = { id: 'tool-find', organizationId: ORG, name: 'find_pets_by_status', sideEffect: 'read', status: 'active', metadata: PETSTORE, parameters: { type: 'object' } };
const DELETE = { id: 'tool-delete', organizationId: ORG, name: 'delete_pet', sideEffect: 'destructive', status: 'active', metadata: PETSTORE, parameters: { type: 'object' } };

describe('workflow Code step', () => {
  let engine: AgentExecutionEngine;
  let executeTool: jest.Mock;
  let approvalRows: any[];
  let resumer: WorkflowApprovalResumeService;
  let approvalEvents: EventEmitter;
  let codeModeService: CodeModeService;
  const agentWith = (code: string) =>
    Object.assign(new Agent(), {
      id: 'pets-agent',
      name: 'Pets',
      organizationId: ORG,
      status: AgentStatus.ACTIVE,
      mode: 'workflow',
      visibility: 'org',
      teamId: null,
      createdBy: 'u-1',
      settings: {},
      toolIds: ['tool-find', 'tool-delete'],
      agentConfig: {},
      pipeline: {
        nodes: [
          { id: 'script', type: 'code', label: 'Count', position: { x: 0, y: 0 }, data: { code } },
          { id: 'out', type: 'output', label: 'Output', position: { x: 0, y: 0 }, data: { mapping: '{{nodes.script.output}}' } },
        ],
        edges: [{ id: 'e1', source: 'script', target: 'out' }],
      },
    });

  const setup = (code: string) => {
    const access = membershipFixture();
    access.member(ORG, 'u-1');
    const agents = fakeRepository<Agent>({ seed: [agentWith(code)], make: () => new Agent() });
    const executions = fakeRepository<AgentExecution>({ make: () => new AgentExecution(), idPrefix: 'exec' });
    const codeExecutions = fakeRepository<CodeExecution>({ make: () => new CodeExecution(), idPrefix: 'code' });
    const toolExecutions = fakeRepository<ToolExecution>({ make: () => new ToolExecution(), idPrefix: 'te' });
    const tools = fakeRepository<Tool>({ make: () => new Tool(), seed: [FIND as any, DELETE as any] });
    const orgs = fakeRepository<Organization>({ make: () => new Organization(), seed: [{ id: ORG, settings: {} } as any] });
    fakeManager([
      [CodeExecution, codeExecutions],
      [ToolExecution, toolExecutions],
      [Tool, tools],
      [Organization, orgs],
    ]);
    executeTool = jest.fn(async (toolId: string, params: any) => ({
      success: true,
      data: toolId === 'tool-find' ? [{ id: 7, status: params.status }, { id: 9, status: params.status }] : { deleted: true },
      executionTime: 1,
      cached: false,
      rateLimited: false,
      retryCount: 0,
    }));
    approvalRows = [];
    const approvals = Object.assign(new EventEmitter(), {
      create: jest.fn(async (input: any) => {
        const row = { ...input, id: `appr-${approvalRows.length + 1}`, status: 'pending' };
        approvalRows.push(row);
        return row;
      }),
      findInOrganization: jest.fn(async (id: string) => approvalRows.find((r) => r.id === id) ?? null),
    });
    const moduleRef = { get: jest.fn((cls: any) => (cls === ApprovalsService ? approvals : null)) };
    const codeMode = new CodeModeService(codeExecutions as any, toolExecutions as any, new NodeSandboxService({} as any), { executeTool } as any, undefined, undefined, moduleRef as any);
    const state = { emitEvent: jest.fn(), bumpAgentStats: jest.fn().mockResolvedValue(undefined), withTimeout: (promise: Promise<unknown>) => promise };
    engine = new AgentExecutionEngine(
      agents as any,
      executions as any,
      null as any,
      { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } as any,
      state as any,
      undefined, undefined, undefined, undefined, undefined, undefined,
      access.executionAccess,
    );
    const resolver = new AgentTemplateResolver();
    const subAgents = new AgentSubAgentExecutors(resolver, agents as any, engine, {} as any, {} as any);
    (engine as any).nodeExecutor = new AgentNodeExecutor(
      resolver, {} as any, { executeTool } as any, agents as any, engine, {} as any, {} as any, subAgents, {} as any,
      undefined, undefined, codeMode,
    );
    resumer = new WorkflowApprovalResumeService(executions as any, agents as any, engine, approvals as any, codeMode);
    approvalEvents = approvals;
    codeModeService = codeMode;
    return { agents, codeExecutions, executions };
  };

  const run = async (code: string, input: Record<string, any>) => {
    const { agents, codeExecutions, executions } = setup(code);
    const execution = await engine.execute(agents.row('pets-agent')!, ORG, 'u-1', { input, principal: userPrincipal('u-1') });
    return { execution, codeExecutions, executions };
  };

  const DELETE_SOLD = 'const pets = await petstore.findPetsByStatus({ status: "sold" });\nfor (const p of pets) await petstore.deletePet({ petId: p.id });\nreturn { deleted: pets.length };';

  /** A person decides the run's change set in Approvals. */
  const decide = (status: 'approved' | 'rejected' | 'expired', decisionReason: string | null = null) => {
    const row = approvalRows[0];
    Object.assign(row, { status, decisionReason, decidedAt: new Date() });
    return row;
  };

  it("runs a script over the agent's tools with the run's input, and hands on what it returns", async () => {
    const { execution, codeExecutions } = await run('const pets = await petstore.findPetsByStatus({ status: context.input.status });\nreturn pets.map((p) => p.id);', { status: 'sold' });
    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(execution.nodeResults.script.output).toEqual([7, 9]);
    expect(executeTool).toHaveBeenCalledWith('tool-find', { status: 'sold' }, expect.objectContaining({ runId: execution.id, agentId: 'pets-agent', holdForApproval: 'caller' }));
    const [script] = codeExecutions.rows();
    expect(script).toMatchObject({ runId: execution.id, agentId: 'pets-agent', status: 'completed' });
  });

  it('holds deletions in Approvals and the run waits for the decision, in words a person reads', async () => {
    const { execution, executions } = await run(DELETE_SOLD, {});
    expect(execution.status).toBe(AgentExecutionStatus.WAITING_APPROVAL);
    expect(execution.error).toBe('Waiting for your approval: 2 changes.');
    expect(execution.nodeResults.script).toMatchObject({ status: 'waiting_approval', message: 'Waiting for your approval: 2 changes.' });
    expect(execution.nodeResults.script.error).toBeUndefined();
    expect(execution.nodeResults.script.input).toMatchObject({ approvalId: 'appr-1' });
    // The model-facing instruction stays with the model.
    expect(JSON.stringify(execution.nodeResults)).not.toMatch(/run_code|approvalId"\s*:\s*"appr-1"\s*}\s*for the outcome/);
    expect(execution.error).not.toMatch(/run_code|approvalId/);
    expect(execution.nodeResults.out).toMatchObject({ skipped: true });
    expect(executions.row(execution.id)!.status).toBe(AgentExecutionStatus.WAITING_APPROVAL);
    expect(execution.metadata.waitingForApproval.steps).toEqual([
      expect.objectContaining({ nodeId: 'script', approvalId: 'appr-1', changes: 2, result: { deleted: 2 } }),
    ]);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(approvalRows[0]).toMatchObject({ runId: null, agentId: 'pets-agent', payload: { kind: 'change_set', workflowExecutionId: execution.id } });
    expect(approvalRows[0].payload.changeSet).toHaveLength(2);
  });

  it('approved: the changes run once, the step finishes with what the script returned, and the run carries on to the end', async () => {
    const { execution, executions } = await run(DELETE_SOLD, {});
    const after = await resumer.onDecided(decide('approved'));
    expect(after!.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(after!.error).toBeNull();
    expect(after!.nodeResults.script.output).toEqual({ deleted: 2 });
    expect(after!.nodeResults.out.skipped).toBeUndefined();
    expect(after!.nodeResults.out.output).toBeDefined();
    const deletes = executeTool.mock.calls.filter(([id]) => id === 'tool-delete');
    expect(deletes).toHaveLength(2);
    expect(deletes[0][2]).toMatchObject({ approvedGate: { approvalId: 'appr-1' } });
    // The step before the wait is not run again.
    expect(executeTool.mock.calls.filter(([id]) => id === 'tool-find')).toHaveLength(1);
    const row = executions.row(execution.id)!;
    expect(row.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(row.metadata.waitingForApproval).toBeUndefined();
    expect(row.metadata.approvalDecided).toEqual([{ nodeId: 'script', approvalId: 'appr-1' }]);
    // Deciding again (a retried event) carries nothing on twice.
    expect(await resumer.onDecided(approvalRows[0])).toBeNull();
    expect(executeTool.mock.calls.filter(([id]) => id === 'tool-delete')).toHaveLength(2);
  });

  it('rejected: none of the changes run and the step ends with a plain "Rejected"', async () => {
    const { execution, executions } = await run(DELETE_SOLD, {});
    const after = await resumer.onDecided(decide('rejected', 'not today'));
    expect(after!.status).toBe(AgentExecutionStatus.CANCELLED);
    expect(after!.error).toBe('Rejected (not today). None of the 2 changes ran.');
    expect(after!.nodeResults.script).toMatchObject({ error: 'Rejected (not today). None of the 2 changes ran.', errorCode: 'APPROVAL_REJECTED' });
    expect(after!.nodeResults.out).toMatchObject({ skipped: true });
    expect(executeTool.mock.calls.filter(([id]) => id === 'tool-delete')).toHaveLength(0);
    expect(executions.row(execution.id)!.status).toBe(AgentExecutionStatus.CANCELLED);
  });

  it('nobody decided in time: the step ends, saying so, and nothing ran', async () => {
    await run(DELETE_SOLD, {});
    const after = await resumer.onDecided(decide('expired', 'approval expired'));
    expect(after!.status).toBe(AgentExecutionStatus.CANCELLED);
    expect(after!.error).toBe('Nobody approved in time. None of the 2 changes ran.');
    expect(executeTool.mock.calls.filter(([id]) => id === 'tool-delete')).toHaveLength(0);
  });

  it("carries the run on from the Approvals decision event, and code mode's own listener leaves the run's change set to it", async () => {
    const { execution, executions } = await run(DELETE_SOLD, {});
    codeModeService.onModuleInit();
    resumer.onModuleInit();
    approvalEvents.emit('approval.decided', decide('approved'));
    for (let i = 0; i < 200 && executions.row(execution.id)!.status !== AgentExecutionStatus.COMPLETED; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(executions.row(execution.id)!.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(executeTool.mock.calls.filter(([id]) => id === 'tool-delete')).toHaveLength(2);
  });

  it('approved, but a change fails: the step fails saying which, and what did not run', async () => {
    const { execution } = await run(DELETE_SOLD, {});
    executeTool.mockImplementation(async (toolId: string) =>
      toolId === 'tool-delete'
        ? { success: false, error: 'pet 7 is locked', executionTime: 1, cached: false, rateLimited: false, retryCount: 0 }
        : { success: true, data: [], executionTime: 1, cached: false, rateLimited: false, retryCount: 0 },
    );
    const after = await resumer.onDecided(decide('approved'));
    expect(after!.id).toBe(execution.id);
    expect(after!.status).toBe(AgentExecutionStatus.FAILED);
    expect(after!.nodeResults.script.error).toBe('Approved, but change 1 of 2 failed: pet 7 is locked. 0 ran before it; the rest did not run.');
    expect(executeTool.mock.calls.filter(([id]) => id === 'tool-delete')).toHaveLength(1);
  });

  it('fails the step with the script error, naming the line', async () => {
    const { execution } = await run('const n = 1;\nthrow new Error("no pets today");', {});
    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(execution.error).toContain('no pets today');
  });
});
