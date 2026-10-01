import { AgentRunStatus } from '../../../../entities/agent-run.entity';
import { McpAgentRuns, MCP_TASK_METADATA_KEY, pendingQuestion } from '../mcp-agent-runs';
import { openRequestState } from '../../core/mcp-request-state';
import { snapshotEnv } from '../../../../test/env';

/**
 * Autonomous agent runs over MCP 2026-07-28: a run as a task (Tasks
 * extension), its question or approval as an input request, the answer
 * through tasks/update or an invoke_agent retry, and who may do any of it.
 */
const ORG = 'org-1';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const V = '2026-07-28';
const asks = { version: V as any, era: 'modern' as const, clientCapabilities: { elicitation: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } } };
const cannotAsk = { version: V as any, era: 'modern' as const, clientCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } } };

function makeRun(over: Record<string, any> = {}): any {
  return {
    id: RUN_ID,
    organizationId: ORG,
    agentId: 'agent-1',
    status: AgentRunStatus.RUNNING,
    currentStep: 3,
    steps: [],
    output: null,
    error: null,
    totalCost: 0.12,
    totalTokens: 900,
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T10:01:00Z'),
    metadata: { [MCP_TASK_METADATA_KEY]: { startedBy: OWNER } },
    ...over,
  };
}

function setup(runOver: Record<string, any> = {}, opts: { approvers?: string[]; retentionDays?: number | null } = {}) {
  const run = makeRun(runOver);
  const approvalRows: any[] = [];
  const approvers = new Set(opts.approvers ?? [OWNER]);
  const clock = { now: 0 };
  const deps = {
    runs: {
      findOne: jest.fn(async ({ where }: any) => (where.id === run.id && where.organizationId === run.organizationId ? run : null)),
    },
    runtime: {
      sendInput: jest.fn(async (id: string, org: string, text: string): Promise<unknown> => {
        run.status = AgentRunStatus.RUNNING;
        return { id, org, text };
      }),
      cancelRun: jest.fn(async () => {
        run.status = AgentRunStatus.CANCELLED;
      }),
    },
    approvals: {
      listForRun: jest.fn(async (runId: string) => approvalRows.filter((r) => r.runId === runId)),
      canDecide: jest.fn(async (row: any, caller: any) => row.status === 'pending' && approvers.has(caller?.id)),
      approve: jest.fn(async (id: string) => {
        const row = approvalRows.find((r) => r.id === id);
        row.status = 'approved';
        return row;
      }),
      reject: jest.fn(async (id: string) => {
        const row = approvalRows.find((r) => r.id === id);
        row.status = 'rejected';
        return row;
      }),
    },
    runRetentionDays: jest.fn(async () => (opts.retentionDays === undefined ? 30 : opts.retentionDays)),
    // A fake clock that sleeping advances: a wait can never spin.
    now: () => clock.now,
    sleep: jest.fn(async (ms: number) => {
      clock.now += ms;
    }),
  };
  const runs = new McpAgentRuns(deps as any);
  return { run, runs, deps, approvalRows };
}

const waitingForAnswer = { status: AgentRunStatus.WAITING_INPUT, steps: [{ type: 'llm_call', output: { status: 'waiting_input', question: 'Which region?' } }] };

describe('McpAgentRuns', () => {
  const restore = snapshotEnv('MCP_TASK_POLL_INTERVAL_MS', 'MCP_INVOKE_WAIT_MS', 'ENCRYPTION_KEY');
  afterEach(restore);
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
  });

  describe('a run as a task', () => {
    it('starts as working, with the run id, its retention and MCP_TASK_POLL_INTERVAL_MS', async () => {
      process.env.MCP_TASK_POLL_INTERVAL_MS = '3000';
      const { run, runs } = setup();
      expect(await runs.createTaskResult(run)).toEqual({
        resultType: 'task',
        taskId: RUN_ID,
        status: 'working',
        statusMessage: 'The agent run has started.',
        createdAt: '2026-10-01T10:00:00.000Z',
        lastUpdatedAt: '2026-10-01T10:01:00.000Z',
        ttlMs: 30 * 86_400_000,
        pollIntervalMs: 3000,
      });
    });

    it('has no TTL in an organization without a run retention limit', async () => {
      const { run, runs } = setup({}, { retentionDays: null });
      expect((await runs.createTaskResult(run)).ttlMs).toBeNull();
    });

    it.each([
      [AgentRunStatus.PENDING, 'working'],
      [AgentRunStatus.RUNNING, 'working'],
      [AgentRunStatus.SLEEPING, 'working'],
      [AgentRunStatus.CANCELLED, 'cancelled'],
      [AgentRunStatus.COMPLETED, 'completed'],
      [AgentRunStatus.FAILED, 'completed'],
      [AgentRunStatus.TIMEOUT, 'completed'],
    ])('reports a %s run as %s', async (status, expected) => {
      const { runs } = setup({ status, output: { answer: 42 }, error: status === AgentRunStatus.FAILED ? 'model refused' : null });
      const task = await runs.getTask(RUN_ID, ORG, OWNER, asks);
      expect(task.status).toBe(expected);
      expect(task.taskId).toBe(RUN_ID);
    });

    it('carries the run result when finished, and a failed run as a tool error, not a JSON-RPC one', async () => {
      const done = await setup({ status: AgentRunStatus.COMPLETED, output: 'All done.' }).runs.getTask(RUN_ID, ORG, OWNER, asks);
      expect(done.result).toEqual({
        content: [{ type: 'text', text: 'All done.' }],
        structuredContent: expect.objectContaining({ runId: RUN_ID, status: 'completed', output: 'All done.' }),
        isError: false,
      });
      const failed = await setup({ status: AgentRunStatus.FAILED, error: 'model refused' }).runs.getTask(RUN_ID, ORG, OWNER, asks);
      expect(failed).toMatchObject({ status: 'completed', result: { isError: true, content: [{ type: 'text', text: 'The agent run failed: model refused' }] } });
      expect(failed.error).toBeUndefined();
    });

    it('is not found for anyone but the user who started it as a task', async () => {
      const notFound = { code: -32602, message: 'Failed to retrieve task: Task not found' };
      await expect(setup().runs.getTask(RUN_ID, ORG, OTHER, asks)).rejects.toEqual(notFound);
      await expect(setup().runs.getTask(RUN_ID, ORG, null, asks)).rejects.toEqual(notFound);
      await expect(setup().runs.getTask(RUN_ID, 'org-2', OWNER, asks)).rejects.toEqual(notFound);
      await expect(setup({ metadata: {} }).runs.getTask(RUN_ID, ORG, OWNER, asks)).rejects.toEqual(notFound);
      await expect(setup().runs.getTask('not-a-uuid', ORG, OWNER, asks)).rejects.toEqual(notFound);
      await expect(setup().runs.updateTask(RUN_ID, {}, ORG, OTHER)).rejects.toEqual(notFound);
      await expect(setup().runs.cancelTask(RUN_ID, ORG, OTHER)).rejects.toEqual(notFound);
    });
  });

  describe('a question (ask_user)', () => {
    it('is an elicitation keyed by its step', async () => {
      const { runs } = setup(waitingForAnswer);
      const task = await runs.getTask(RUN_ID, ORG, OWNER, asks);
      expect(task).toMatchObject({
        status: 'input_required',
        inputRequests: {
          'question-3': {
            method: 'elicitation/create',
            params: {
              mode: 'form',
              message: 'Which region?',
              requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } }, required: ['answer'] },
            },
          },
        },
      });
    });

    it('is a working task with a status message when the client cannot be asked', async () => {
      const task = await setup(waitingForAnswer).runs.getTask(RUN_ID, ORG, OWNER, cannotAsk);
      expect(task.status).toBe('working');
      expect(task.statusMessage).toBe('The agent asks: Which region? Answer with answer_run or in the almyty dashboard.');
      expect(task.inputRequests).toBeUndefined();
    });

    it('takes its answer through tasks/update and resumes the run', async () => {
      const { runs, deps } = setup(waitingForAnswer);
      await expect(runs.updateTask(RUN_ID, { 'question-3': { action: 'accept', content: { answer: 'eu-west' } } }, ORG, OWNER)).resolves.toEqual({});
      expect(deps.runtime.sendInput).toHaveBeenCalledWith(RUN_ID, ORG, 'eu-west');
    });

    it('ignores an answer to an earlier question and keys it never issued, and lets cancel leave it waiting', async () => {
      const { runs, deps } = setup(waitingForAnswer);
      await runs.updateTask(RUN_ID, {
        'question-2': { action: 'accept', content: { answer: 'old' } },
        'nonsense': { action: 'accept', content: {} },
        'question-3': { action: 'cancel' },
      }, ORG, OWNER);
      expect(deps.runtime.sendInput).not.toHaveBeenCalled();
    });

    it('tells the run when the person declined', async () => {
      const { runs, deps } = setup(waitingForAnswer);
      await runs.updateTask(RUN_ID, { 'question-3': { action: 'decline' } }, ORG, OWNER);
      expect(deps.runtime.sendInput).toHaveBeenCalledWith(RUN_ID, ORG, 'The person declined to answer.');
    });

    it('refuses a response that is not an elicitation result, or an accept without an answer', async () => {
      const { runs } = setup(waitingForAnswer);
      await expect(runs.updateTask(RUN_ID, { 'question-3': 'eu-west' }, ORG, OWNER)).rejects.toMatchObject({ code: -32602 });
      await expect(runs.updateTask(RUN_ID, { 'question-3': { action: 'accept', content: {} } }, ORG, OWNER)).rejects.toMatchObject({ code: -32602 });
    });

    it('falls back to a generic question when the step lost it', () => {
      expect(pendingQuestion({ steps: [] } as any)).toBe('Please provide input');
    });
  });

  describe('an approval the run waits for', () => {
    function waitingForApproval(approvers: string[]) {
      const ctx = setup({ status: AgentRunStatus.WAITING_APPROVAL }, { approvers });
      ctx.approvalRows.push(
        { id: 'appr-1', runId: RUN_ID, organizationId: ORG, status: 'pending', reason: 'Refund over 500', payload: { tool: 'Issue refund', parameters: { amount: 820 } } },
        { id: 'appr-0', runId: RUN_ID, organizationId: ORG, status: 'approved', reason: 'earlier', payload: null },
      );
      return ctx;
    }

    it('is asked of a person who may decide it, with the rule and the arguments', async () => {
      const task = await waitingForApproval([OWNER]).runs.getTask(RUN_ID, ORG, OWNER, asks);
      expect(Object.keys(task.inputRequests as object)).toEqual(['approval-appr-1']);
      const form = (task.inputRequests as any)['approval-appr-1'].params;
      expect(form.message).toContain('Refund over 500');
      expect(form.message).toContain('Tool: Issue refund');
      expect(form.message).toContain('"amount": 820');
      expect(form.requestedSchema.required).toEqual(['decision']);
    });

    it('is "waiting for approval" for someone who could not decide it in Approvals (owner decision 6)', async () => {
      const task = await waitingForApproval([OTHER]).runs.getTask(RUN_ID, ORG, OWNER, asks);
      expect(task).toMatchObject({ status: 'working', statusMessage: expect.stringContaining('Approvals') });
    });

    it('is approved or rejected through tasks/update by that person only', async () => {
      const approved = waitingForApproval([OWNER]);
      await approved.runs.updateTask(RUN_ID, { 'approval-appr-1': { action: 'accept', content: { decision: 'approve', reason: 'fine' } } }, ORG, OWNER);
      expect(approved.deps.approvals.approve).toHaveBeenCalledWith('appr-1', { decidedBy: OWNER, decisionReason: 'fine' }, { id: OWNER }, ORG);

      const declined = waitingForApproval([OWNER]);
      await declined.runs.updateTask(RUN_ID, { 'approval-appr-1': { action: 'decline' } }, ORG, OWNER);
      expect(declined.deps.approvals.reject).toHaveBeenCalled();

      const notAnApprover = waitingForApproval([OTHER]);
      await notAnApprover.runs.updateTask(RUN_ID, { 'approval-appr-1': { action: 'accept', content: { decision: 'approve' } } }, ORG, OWNER);
      expect(notAnApprover.deps.approvals.approve).not.toHaveBeenCalled();
    });

    it('ignores a decision on an approval of another run or one already decided', async () => {
      const ctx = waitingForApproval([OWNER]);
      ctx.approvalRows.push({ id: 'appr-x', runId: 'another-run', status: 'pending' });
      await ctx.runs.updateTask(RUN_ID, {
        'approval-appr-x': { action: 'accept', content: { decision: 'approve' } },
        'approval-appr-0': { action: 'accept', content: { decision: 'reject' } },
      }, ORG, OWNER);
      expect(ctx.deps.approvals.approve).not.toHaveBeenCalled();
      expect(ctx.deps.approvals.reject).not.toHaveBeenCalled();
    });
  });

  describe('tasks/cancel', () => {
    it('cancels a running run and acknowledges a finished one without touching it', async () => {
      const running = setup();
      await expect(running.runs.cancelTask(RUN_ID, ORG, OWNER)).resolves.toEqual({});
      expect(running.deps.runtime.cancelRun).toHaveBeenCalledWith(RUN_ID, ORG, undefined, OWNER);
      const done = setup({ status: AgentRunStatus.COMPLETED });
      await expect(done.runs.cancelTask(RUN_ID, ORG, OWNER)).resolves.toEqual({});
      expect(done.deps.runtime.cancelRun).not.toHaveBeenCalled();
    });
  });

  describe('invoke_agent without tasks (multi round-trip requests)', () => {
    const request = { method: 'tools/call', params: { name: 'invoke_agent', arguments: { agentId: 'agent-1', input: { message: 'go' } } } };
    const elicits = { version: V as any, era: 'modern' as const, clientCapabilities: { elicitation: {} } };

    it('returns the result of a run that finishes within MCP_INVOKE_WAIT_MS', async () => {
      const { run, runs, deps } = setup();
      deps.sleep.mockImplementation(async () => {
        run.status = AgentRunStatus.COMPLETED;
        run.output = 'Report sent.';
      });
      const result: any = await runs.waitForRun(RUN_ID, ORG, OWNER, elicits, request);
      expect(result.content).toEqual([{ type: 'text', text: 'Report sent.' }]);
    });

    it('asks the question of a run that stops for one, with a requestState only this caller can use', async () => {
      const { runs } = setup(waitingForAnswer);
      const result: any = await runs.waitForRun(RUN_ID, ORG, OWNER, elicits, request);
      expect(result.resultType).toBe('input_required');
      expect(Object.keys(result.inputRequests)).toEqual(['question-3']);
      expect(openRequestState(result.requestState, { principal: OWNER, ...request })).toEqual({
        payload: { kind: 'agent_run', data: { runId: RUN_ID } },
      });
      expect(openRequestState(result.requestState, { principal: OTHER, ...request })).toEqual({ refusal: 'wrong_principal' });
    });

    it('keeps waiting while a just-approved run has not resumed yet, and returns its result', async () => {
      process.env.MCP_INVOKE_WAIT_MS = '5000';
      const ctx = setup({ status: AgentRunStatus.WAITING_APPROVAL });
      ctx.approvalRows.push({ id: 'appr-1', runId: RUN_ID, status: 'approved' });
      let polls = 0;
      ctx.deps.sleep.mockImplementation(async () => {
        polls++;
        if (polls === 2) {
          ctx.run.status = AgentRunStatus.COMPLETED;
          ctx.run.output = 'Refunded.';
        }
      });
      const result: any = await ctx.runs.waitForRun(RUN_ID, ORG, OWNER, elicits, request);
      expect(result.content).toEqual([{ type: 'text', text: 'Refunded.' }]);
    });

    it('gives up at the deadline on a run waiting for someone else', async () => {
      process.env.MCP_INVOKE_WAIT_MS = '1000';
      const ctx = setup({ status: AgentRunStatus.WAITING_APPROVAL }, { approvers: [OTHER] });
      ctx.approvalRows.push({ id: 'appr-1', runId: RUN_ID, status: 'pending', reason: 'r' });
      expect(await ctx.runs.waitForRun(RUN_ID, ORG, OWNER, elicits, request)).toBeNull();
      expect(ctx.deps.sleep).toHaveBeenCalledTimes(2);
    });

    it('gives up at the deadline, and never waits when MCP_INVOKE_WAIT_MS is 0', async () => {
      process.env.MCP_INVOKE_WAIT_MS = '1000';
      const { runs, deps } = setup();
      expect(await runs.waitForRun(RUN_ID, ORG, OWNER, elicits, request)).toBeNull();
      expect(deps.sleep).toHaveBeenCalledTimes(2);

      process.env.MCP_INVOKE_WAIT_MS = '0';
      const idle = setup();
      expect(await idle.runs.waitForRun(RUN_ID, ORG, OWNER, elicits, request)).toBeNull();
      expect(idle.deps.runs.findOne).not.toHaveBeenCalled();
    });

    it('takes the answer on the retry and waits again', async () => {
      const first = setup(waitingForAnswer);
      const asked: any = await first.runs.waitForRun(RUN_ID, ORG, OWNER, elicits, request);
      first.deps.runtime.sendInput.mockImplementation(async () => {
        first.run.status = AgentRunStatus.COMPLETED;
        first.run.output = 'eu-west it is.';
        return {};
      });
      const retry = { ...request.params, inputResponses: { 'question-3': { action: 'accept', content: { answer: 'eu-west' } } }, requestState: asked.requestState };
      const resumed: any = await first.runs.resumeFromRetry(retry, ORG, OWNER, elicits, 'tools/call');
      expect(first.deps.runtime.sendInput).toHaveBeenCalledWith(RUN_ID, ORG, 'eu-west');
      expect(resumed.runId).toBe(RUN_ID);
      expect(resumed.result.content).toEqual([{ type: 'text', text: 'eu-west it is.' }]);
    });

    it('refuses a retry with a state from another caller, another call or one that was changed', async () => {
      const { runs } = setup(waitingForAnswer);
      const asked: any = await runs.waitForRun(RUN_ID, ORG, OWNER, elicits, request);
      const retry = { ...request.params, requestState: asked.requestState };
      await expect(runs.resumeFromRetry(retry, ORG, OTHER, elicits, 'tools/call')).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('another caller') });
      await expect(
        runs.resumeFromRetry({ ...retry, arguments: { agentId: 'agent-2' } }, ORG, OWNER, elicits, 'tools/call'),
      ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('different request') });
      await expect(runs.resumeFromRetry({ ...retry, requestState: `${asked.requestState.slice(0, -2)}AA` }, ORG, OWNER, elicits, 'tools/call')).rejects.toMatchObject({ code: -32602 });
    });
  });

  describe('get_run (clients without tasks)', () => {
    it('says what a run waits for and who may decide its approval', async () => {
      const question = await setup(waitingForAnswer).runs.describeRun(makeRun(waitingForAnswer), OWNER);
      expect(question.waitingFor).toEqual({ kind: 'answer', question: 'Which region?', howToAnswer: 'Call answer_run with runId and answer.' });

      const ctx = setup({ status: AgentRunStatus.WAITING_APPROVAL }, { approvers: [] });
      ctx.approvalRows.push({ id: 'appr-1', runId: RUN_ID, status: 'pending', reason: 'Refund over 500' });
      const approval = await ctx.runs.describeRun(ctx.run, OWNER);
      expect(approval.waitingFor).toMatchObject({ kind: 'approval', approvals: [{ approvalId: 'appr-1', reason: 'Refund over 500', youMayDecide: false }] });

      const done = await setup({ status: AgentRunStatus.COMPLETED, output: 'ok' }).runs.describeRun(makeRun({ status: AgentRunStatus.COMPLETED, output: 'ok' }), OWNER);
      expect(done).toMatchObject({ status: 'completed', output: 'ok', error: null });
    });
  });
});
