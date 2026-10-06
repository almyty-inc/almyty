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
      findInOrganization: jest.fn(async () => null),
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
    return { agents, codeExecutions };
  };

  const run = async (code: string, input: Record<string, any>) => {
    const { agents, codeExecutions } = setup(code);
    const execution = await engine.execute(agents.row('pets-agent')!, ORG, 'u-1', { input, principal: userPrincipal('u-1') });
    return { execution, codeExecutions };
  };

  it("runs a script over the agent's tools with the run's input, and hands on what it returns", async () => {
    const { execution, codeExecutions } = await run('const pets = await petstore.findPetsByStatus({ status: context.input.status });\nreturn pets.map((p) => p.id);', { status: 'sold' });
    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    expect(execution.nodeResults.script.output).toEqual([7, 9]);
    expect(executeTool).toHaveBeenCalledWith('tool-find', { status: 'sold' }, expect.objectContaining({ runId: execution.id, agentId: 'pets-agent', holdForApproval: 'caller' }));
    const [script] = codeExecutions.rows();
    expect(script).toMatchObject({ runId: execution.id, agentId: 'pets-agent', status: 'completed' });
  });

  it('holds deletions in Approvals and stops waiting, as a held tool call does', async () => {
    const { execution } = await run('const pets = await petstore.findPetsByStatus({ status: "sold" });\nfor (const p of pets) await petstore.deletePet({ petId: p.id });\nreturn pets.length;', {});
    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(execution.nodeResults.script.errorCode).toBe('AWAITING_APPROVAL');
    expect(execution.nodeResults.script.input).toMatchObject({ approvalId: 'appr-1' });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(approvalRows[0]).toMatchObject({ runId: null, agentId: 'pets-agent', payload: { kind: 'change_set' } });
    expect(approvalRows[0].payload.changeSet).toHaveLength(2);
  });

  it('fails the step with the script error, naming the line', async () => {
    const { execution } = await run('const n = 1;\nthrow new Error("no pets today");', {});
    expect(execution.status).toBe(AgentExecutionStatus.FAILED);
    expect(execution.error).toContain('no pets today');
  });
});
