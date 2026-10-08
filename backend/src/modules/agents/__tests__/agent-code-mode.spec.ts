jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { CodeExecution } from '../../../entities/code-execution.entity';
import { ToolExecution } from '../../../entities/tool-execution.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { NodeSandboxService } from '../../tools/node-sandbox/node-sandbox.service';
import { CodeModeService } from '../../code-mode/code-mode.service';
import { RUN_CODE } from '../../tool-discovery/meta-tools';
import { anthropicText, anthropicTool, runAgent } from './autonomous-harness';

jest.setTimeout(60_000);

/**
 * Code mode for autonomous agents (docs/design/code-mode.md, P2 acceptance):
 * "archive every sold pet older than 30 days" runs as one run_code, stages
 * its writes, asks once for the whole set, and runs the set only once a
 * person approves; the trace is one code_executions row with every call it
 * made under it. Real sandbox workers; the executor, the model and the
 * repositories are the harness's doubles.
 */
const MODEL = 'claude-sonnet-5';
const PETSTORE = { sourceApi: { name: 'Petstore' } };
const FIND = {
  id: 'tool-find',
  organizationId: 'org-1',
  name: 'petstore_find_pets_by_status',
  description: 'Finds pets by status.',
  sideEffect: 'read',
  metadata: PETSTORE,
  parameters: { type: 'object', properties: { status: { type: 'string' } } },
};
const UPDATE = {
  id: 'tool-update',
  organizationId: 'org-1',
  name: 'petstore_update_pet',
  description: 'Updates a pet.',
  sideEffect: 'write',
  metadata: PETSTORE,
  parameters: { type: 'object', properties: { id: { type: 'integer' }, status: { type: 'string' } } },
};
const PETS = [
  { id: 1, status: 'sold', updatedAt: '2026-07-01T00:00:00Z' },
  { id: 2, status: 'sold', updatedAt: '2026-09-28T00:00:00Z' },
  { id: 3, status: 'sold', updatedAt: '2026-06-15T00:00:00Z' },
];
const ARCHIVE = `
  const sold: Array<{ id: number; updatedAt: string }> = await petstore.findPetsByStatus({ status: 'sold' });
  const cutoff = Date.parse('2026-09-01T00:00:00Z');
  const old = sold.filter((p) => Date.parse(p.updatedAt) < cutoff);
  await Promise.all(old.map((p) => petstore.updatePet({ id: p.id, status: 'archived' })));
  log(old.length + ' to archive');
  return { archived: old.map((p) => p.id) };
`;

function setup() {
  const executions = fakeRepository<CodeExecution>({ make: () => new CodeExecution(), idPrefix: 'code' });
  const toolExecutions = fakeRepository<ToolExecution>({ make: () => new ToolExecution(), idPrefix: 'te' });
  // The executor double records what a real one records: a tool_executions
  // row per call that ran, with the script it came from.
  const executeTool = jest.fn(async (toolId: string, params: any, options: any) => {
    const data = toolId === 'tool-find' ? PETS : { id: params.id, status: params.status };
    await toolExecutions.save(
      Object.assign(new ToolExecution(), {
        toolId,
        organizationId: 'org-1',
        parameters: params,
        success: true,
        codeExecutionId: options.codeExecutionId ?? null,
        createdAt: new Date(Date.now() + toolExecutions.rows().length),
      }),
    );
    return { success: true, data, executionTime: 2, cached: false, rateLimited: false, retryCount: 0 };
  });
  const sandbox = new NodeSandboxService({} as any);
  const codeMode = new CodeModeService(executions as any, toolExecutions as any, sandbox, { executeTool } as any);
  const approvalRows: any[] = [];
  const approvals = {
    create: jest.fn(async (input: any) => {
      const row = { ...input, id: `appr-${approvalRows.length + 1}`, status: 'pending', decisionReason: null };
      approvalRows.push(row);
      return row;
    }),
    findInOrganization: jest.fn(async (id: string, organizationId: string) => approvalRows.find((r) => r.id === id && r.organizationId === organizationId) ?? null),
  };
  return { executions, toolExecutions, executeTool, codeMode, approvals, approvalRows };
}

const agentConfig = { toolMode: 'code', codeMode: { writes: { write: 'stage' } } };

describe('code mode: an autonomous run', () => {
  it('offers the meta-tools and run_code, and names the namespaces in the prompt', async () => {
    const { codeMode, executeTool, approvals } = setup();
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-find', 'tool-update'], agentConfig },
      tools: [FIND, UPDATE],
      executeTool,
      approvals,
      codeMode,
      streams: { [MODEL]: [anthropicText(MODEL, 50, ['Done.'], 3)] },
    });
    const names = (result.bodies[0].body.tools ?? []).map((t: any) => t.name);
    expect(names.slice(0, 4)).toEqual(['search_tools', 'get_tool', 'call_tool', RUN_CODE]);
    expect(names).not.toContain('petstore_update_pet');
    expect(JSON.stringify(result.bodies[0].body.system)).toContain('petstore (2 functions)');
    expect(result.run.workingMemory.toolMode).toMatchObject({ mode: 'code', configured: 'code' });
  });

  it('archives with one script, one approval for every change, and runs them only once approved', async () => {
    const { codeMode, executeTool, approvals, approvalRows, executions, toolExecutions } = setup();
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-find', 'tool-update'], agentConfig },
      tools: [FIND, UPDATE],
      executeTool,
      approvals,
      codeMode,
      streams: {
        [MODEL]: [anthropicTool(MODEL, RUN_CODE, { code: ARCHIVE }, 120, 40), anthropicText(MODEL, 200, ['Archived pets 1 and 3.'], 8)],
      },
    });

    // One script, the read ran, both writes staged, one request for the set.
    expect(result.run.status).toBe(AgentRunStatus.WAITING_APPROVAL);
    expect(executions.rows()).toHaveLength(1);
    const [script] = executions.rows();
    expect(script).toMatchObject({ status: 'waiting_approval', approvalRequestId: 'appr-1', logs: '2 to archive', callCount: 3 });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(approvals.create).toHaveBeenCalledTimes(1);
    const payload = approvals.create.mock.calls[0][0].payload;
    expect(payload).toMatchObject({ kind: 'change_set', codeExecutionId: script.id });
    expect(payload.changeSet.map((e: any) => [e.codeName, e.arguments])).toEqual([
      ['petstore.updatePet', { id: 1, status: 'archived' }],
      ['petstore.updatePet', { id: 3, status: 'archived' }],
    ]);

    // A person approves: both run, through the executor, with the approval, under the script.
    approvalRows[0].status = 'approved';
    await result.runRepository.update({ id: 'run-1' }, { status: AgentRunStatus.RUNNING });
    await result.drive();
    expect(executeTool).toHaveBeenCalledTimes(3);
    for (const call of executeTool.mock.calls.slice(1)) {
      expect(call[2]).toMatchObject({ approvedGate: { approvalId: 'appr-1' }, codeExecutionId: script.id, runId: 'run-1' });
    }
    expect(toolExecutions.rows().filter((r) => r.codeExecutionId === script.id)).toHaveLength(3);
    expect(executions.row(script.id)).toMatchObject({ status: 'approved' });
    expect(executions.row(script.id)!.changeSet.map((e) => e.outcome)).toEqual(['ran', 'ran']);

    const run = result.runRepository.row('run-1')!;
    expect(run.status).toBe(AgentRunStatus.COMPLETED);
    // The model got one result for its run_code, with the outcome.
    const last = JSON.stringify(result.bodies[result.bodies.length - 1].body.messages);
    expect(last).toContain('all 2 ran');
    expect(last).toContain('archived');
  });

  it('runs none of the set when a person rejects it, tells the model, and carries on', async () => {
    const { codeMode, executeTool, approvals, approvalRows, executions } = setup();
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-find', 'tool-update'], agentConfig },
      tools: [FIND, UPDATE],
      executeTool,
      approvals,
      codeMode,
      streams: {
        [MODEL]: [anthropicTool(MODEL, RUN_CODE, { code: ARCHIVE }, 120, 40), anthropicText(MODEL, 200, ['Nothing was archived.'], 8)],
      },
    });
    approvalRows[0].status = 'rejected';
    approvalRows[0].decisionReason = 'not this week';
    await result.runRepository.update({ id: 'run-1' }, { status: AgentRunStatus.RUNNING });
    await result.drive();
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executions.rows()[0]).toMatchObject({ status: 'rejected' });
    expect(JSON.stringify(result.bodies[result.bodies.length - 1].body.messages)).toContain('rejected the changes (not this week). None of them ran');
    expect(result.runRepository.row('run-1')!.status).toBe(AgentRunStatus.COMPLETED);
  });

  it('reports the writes that already ran when a script throws after them', async () => {
    const { codeMode, executeTool, approvals } = setup();
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-find', 'tool-update'], agentConfig: { toolMode: 'code' } },
      tools: [FIND, UPDATE],
      executeTool,
      approvals,
      codeMode,
      streams: {
        [MODEL]: [
          anthropicTool(
            MODEL,
            RUN_CODE,
            { code: "await petstore.updatePet({ id: 1, status: 'archived' });\nawait petstore.updatePet({ id: 3, status: 'archived' });\nthrow new Error('ran out of luck');" },
            120,
            40,
          ),
          anthropicText(MODEL, 200, ['Two were archived before it failed.'], 8),
        ],
      },
    });
    expect(approvals.create).not.toHaveBeenCalled();
    const sent = JSON.stringify(result.bodies[1].body.messages);
    expect(sent).toContain('ran out of luck');
    expect(sent).toMatch(/line[^0-9]+3/);
    expect(sent).toContain('committed');
    expect((sent.match(/petstore_update_pet/g) ?? []).length).toBe(2);
    expect(result.run.status).toBe(AgentRunStatus.COMPLETED);
  });

  it("spends the run's tool-call budget: a script gets only what is left of it", async () => {
    const { codeMode, executeTool, approvals, executions } = setup();
    const script = "let ran = 0;\nfor (const id of [1, 2, 3, 4, 5]) { try { await petstore.updatePet({ id, status: 'archived' }); ran++; } catch (e) { log(e.message); } }\nreturn ran;";
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-find', 'tool-update'], agentConfig: { toolMode: 'code' } },
      tools: [FIND, UPDATE],
      executeTool,
      approvals,
      codeMode,
      limits: { maxToolCalls: 3 },
      streams: {
        [MODEL]: [anthropicTool(MODEL, RUN_CODE, { code: script }, 120, 40), anthropicText(MODEL, 200, ['Two of five.'], 8)],
      },
    });
    // run_code itself is one call of the three; the script may make two.
    expect(executeTool).toHaveBeenCalledTimes(2);
    // The refusals are what the script logged; the run has spent its budget.
    expect(executions.rows()[0].logs).toContain("what is left of the run's budget");
    expect(result.run.toolCallCount).toBe(3);
  });

  it('answers that code mode is unavailable when the server has none, without running anything', async () => {
    const { executeTool, approvals } = setup();
    const result = await runAgent({
      models: null,
      agent: { toolIds: ['tool-find', 'tool-update'], agentConfig },
      tools: [FIND, UPDATE],
      executeTool,
      approvals,
      streams: {
        [MODEL]: [anthropicTool(MODEL, RUN_CODE, { code: 'return 1' }, 60, 10), anthropicText(MODEL, 80, ['I cannot.'], 3)],
      },
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(JSON.stringify(result.bodies[1].body.messages)).toContain('Code mode is not available');
  });
});

describe('code mode: guards', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'agent-step-processor.ts'), 'utf8');

  it('scripts and search_tools resolve against the same scope: the run\'s executable tools', () => {
    expect(source).toMatch(/const tools = await this\.s\.executionAccess\.filterExecutable\(/);
    expect(source).toMatch(/this\.runCode\(run, agent, toolCall, tools, resolvedLimits, organization \?\? null\)/);
    expect(source).toMatch(/this\.answerDiscovery\(toolCall\.name, callParams, tools, run\.organizationId\)/);
    expect(source).toMatch(/scope: await this\.withApiNames\(tools\)/);
  });

  it('a change set runs only through the code mode service, with the approval (no executor call site of its own)', () => {
    expect(source.match(/toolExecutorService\.executeTool\(/g) ?? []).toHaveLength(2);
    expect(source).toMatch(/this\.codeMode\.applyChangeSet\(set\.codeExecutionId, set\.approvalId, tools,/);
  });
});