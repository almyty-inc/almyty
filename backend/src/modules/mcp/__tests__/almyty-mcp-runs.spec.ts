import 'reflect-metadata';

import { AlmytyMcpService } from '../almyty-mcp.service';
import { AgentsService } from '../../agents/agents.service';
import { AgentRuntimeService } from '../../agents/agent-runtime.service';
import { AgentExecutionEngine } from '../../agents/agent-execution.engine';
import { ApprovalsService } from '../../approvals/approvals.service';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { snapshotEnv } from '../../../test/env';

/**
 * invoke_agent on the management MCP server, per what the request can do:
 * a task for a 2026 client with the Tasks extension, the result or the
 * run's question (input_required) for one with elicitation, the run id for
 * everyone else -- and get_run / answer_run to follow a run without tasks
 * (owner decision 7).
 */
const ORG = 'org-1';
const USER = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const V = '2026-07-28';

function meta(capabilities: Record<string, unknown>) {
  return { 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': capabilities };
}
const modern = (capabilities: Record<string, unknown>) => ({ version: V as any, era: 'modern' as const, clientCapabilities: capabilities });
const TASKS = { extensions: { 'io.modelcontextprotocol/tasks': {} } };

function setup(runOver: Record<string, any> = {}) {
  const run: any = {
    id: RUN_ID,
    organizationId: ORG,
    agentId: 'agent-1',
    status: AgentRunStatus.RUNNING,
    currentStep: 1,
    steps: [],
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T10:00:05Z'),
    metadata: {},
    agent: { id: 'agent-1', status: 'active', mode: 'autonomous' },
    ...runOver,
  };
  const agent = { id: 'agent-1', status: 'active', mode: 'autonomous' };
  const assertCanExecute = jest.fn(async () => undefined);
  const runtime: any = {
    executionAccess: { assertCanExecute },
    startRun: jest.fn(async (_a: string, _o: string, _u: string, _i: unknown, options: any) => {
      run.metadata = options?.metadata ?? {};
      return run;
    }),
    getRun: jest.fn(async (id: string, org: string) => {
      if (id !== run.id || org !== ORG) throw new Error('Run not found');
      return run;
    }),
    sendInput: jest.fn(async () => {
      run.status = AgentRunStatus.RUNNING;
      return run;
    }),
    cancelRun: jest.fn(async () => {
      run.status = AgentRunStatus.CANCELLED;
      return run;
    }),
    runRepository: {
      findOne: jest.fn(async ({ where }: any) => (where.id === run.id && where.organizationId === ORG ? run : null)),
      manager: { getRepository: () => ({ findOne: jest.fn(async () => ({ agentRunsDays: 7 })) }) },
    },
  };
  const approvals: any = { listForRun: jest.fn(async () => []), canDecide: jest.fn(async () => false), approve: jest.fn(), reject: jest.fn() };
  const services = new Map<any, any>([
    [AgentsService, { getAgent: jest.fn(async () => agent) }],
    [AgentRuntimeService, runtime],
    [AgentExecutionEngine, { execute: jest.fn() }],
    [ApprovalsService, approvals],
  ]);
  const moduleRef: any = { get: (cls: any) => services.get(cls) };
  const service = new AlmytyMcpService(moduleRef);
  return { service, run, runtime, approvals, assertCanExecute };
}

async function callInvoke(service: AlmytyMcpService, capabilities: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const body = {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'invoke_agent', arguments: { agentId: 'agent-1', input: { message: 'go' } }, ...extra, _meta: meta(capabilities) },
  };
  return (await service.handleJsonRpc(body, ORG, USER, modern(capabilities))) as any;
}

describe('invoke_agent over MCP 2026-07-28', () => {
  const restore = snapshotEnv('MCP_INVOKE_WAIT_MS', 'ENCRYPTION_KEY');
  afterEach(restore);
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'f'.repeat(64);
    process.env.MCP_INVOKE_WAIT_MS = '0';
  });

  it('answers a client with the Tasks extension with a task whose id is the run, started for that user', async () => {
    const { service, runtime } = setup();
    const res = await callInvoke(service, TASKS);
    expect(res.result).toMatchObject({ resultType: 'task', taskId: RUN_ID, status: 'working', ttlMs: 7 * 86_400_000, pollIntervalMs: 2000 });
    expect(runtime.startRun.mock.calls[0][4]).toMatchObject({ metadata: { mcpTask: { startedBy: USER } } });
  });

  it('serves the task methods for that run, and says so on discover', async () => {
    const { service, run } = setup();
    await callInvoke(service, TASKS);
    run.status = AgentRunStatus.COMPLETED;
    run.output = 'Report sent.';
    const get = (await service.handleJsonRpc(
      { jsonrpc: '2.0', id: 8, method: 'tasks/get', params: { taskId: RUN_ID, _meta: meta(TASKS) } },
      ORG, USER, modern(TASKS),
    )) as any;
    expect(get.result).toMatchObject({ resultType: 'complete', taskId: RUN_ID, status: 'completed', result: { content: [{ type: 'text', text: 'Report sent.' }] } });

    const other = (await service.handleJsonRpc(
      { jsonrpc: '2.0', id: 9, method: 'tasks/get', params: { taskId: RUN_ID } },
      ORG, '22222222-2222-4222-8222-222222222222', modern(TASKS),
    )) as any;
    expect(other.error).toEqual({ code: -32602, message: 'Failed to retrieve task: Task not found' });

    const discover = (await service.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }, ORG, USER, modern({}))) as any;
    expect(discover.result.capabilities.extensions).toEqual({ 'io.modelcontextprotocol/tasks': {} });
  });

  it('asks a client with elicitation the run\'s question, and resumes the run with the answer on the retry', async () => {
    process.env.MCP_INVOKE_WAIT_MS = '1000';
    const { service, run, runtime } = setup();
    runtime.startRun.mockImplementation(async () => {
      run.status = AgentRunStatus.WAITING_INPUT;
      run.steps = [{ output: { status: 'waiting_input', question: 'Which week?' } }];
      return run;
    });
    const first = await callInvoke(service, { elicitation: {} });
    expect(first.result).toMatchObject({ resultType: 'input_required', inputRequests: { 'question-1': { params: { message: 'Which week?' } } } });

    runtime.sendInput.mockImplementation(async () => {
      run.status = AgentRunStatus.COMPLETED;
      run.output = 'Week 40 report sent.';
      return run;
    });
    const retry = await callInvoke(service, { elicitation: {} }, {
      requestState: first.result.requestState,
      inputResponses: { 'question-1': { action: 'accept', content: { answer: 'week 40' } } },
    });
    expect(runtime.sendInput).toHaveBeenCalledWith(RUN_ID, ORG, 'week 40');
    expect(runtime.startRun).toHaveBeenCalledTimes(1);
    expect(retry.result).toMatchObject({ resultType: 'complete', content: [{ type: 'text', text: 'Week 40 report sent.' }] });
  });

  it('refuses a tampered requestState as invalid params, starting nothing', async () => {
    const { service, runtime } = setup();
    const res = await callInvoke(service, { elicitation: {} }, { requestState: 'x'.repeat(60) });
    expect(res.error.code).toBe(-32602);
    expect(runtime.startRun).not.toHaveBeenCalled();
  });

  it('returns the run id to a client without tasks or elicitation, as to legacy clients', async () => {
    const { service } = setup();
    const res = await callInvoke(service, {});
    expect(res.result.structuredContent).toMatchObject({ mode: 'autonomous', runId: RUN_ID, next: expect.stringContaining('get_run') });
    const legacy = (await service.handleJsonRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'invoke_agent', arguments: { agentId: 'agent-1' } } },
      ORG, USER, { version: '2025-11-25', era: 'legacy' },
    )) as any;
    expect(legacy.result.structuredContent).toMatchObject({ runId: RUN_ID });
  });
});

describe('get_run and answer_run', () => {
  const call = (service: AlmytyMcpService, name: string, args: Record<string, unknown>) =>
    service.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ORG, USER, { version: '2025-11-25', era: 'legacy' }) as Promise<any>;

  it('are listed as tools', async () => {
    const { service } = setup();
    const list = (await service.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ORG, USER, { version: '2025-11-25', era: 'legacy' })) as any;
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_run', 'answer_run']));
    expect(list.result.tools.find((t: any) => t.name === 'get_run').annotations.readOnlyHint).toBe(true);
  });

  it('show the question and take the answer', async () => {
    const { service, runtime } = setup({ status: AgentRunStatus.WAITING_INPUT, steps: [{ output: { status: 'waiting_input', question: 'Which week?' } }] });
    const got = await call(service, 'get_run', { runId: RUN_ID });
    expect(got.result.structuredContent.waitingFor).toMatchObject({ kind: 'answer', question: 'Which week?' });
    const answered = await call(service, 'answer_run', { runId: RUN_ID, answer: 'week 40' });
    expect(answered.result.isError).toBeUndefined();
    expect(runtime.sendInput).toHaveBeenCalledWith(RUN_ID, ORG, 'week 40');
  });

  it('refuse a run of an agent the caller may not run, like one that does not exist', async () => {
    const { service, assertCanExecute } = setup();
    assertCanExecute.mockRejectedValue(new Error('Agent not found'));
    const got = await call(service, 'get_run', { runId: RUN_ID });
    expect(got.result).toEqual({ content: [{ type: 'text', text: 'Error: Run not found' }], isError: true });
  });

  it('refuse to answer a run that is not waiting for an answer', async () => {
    const { service, runtime } = setup();
    const answered = await call(service, 'answer_run', { runId: RUN_ID, answer: 'x' });
    expect(answered.result.isError).toBe(true);
    expect(runtime.sendInput).not.toHaveBeenCalled();
  });
});
