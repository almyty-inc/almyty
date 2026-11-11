/**
 * Workers of one autonomous run, for the durable runs step 4 specs
 * (resume and idempotency keys, run-resume.ts): the production step
 * processor, over whichever agent_runs repository the spec hands in (a
 * fake one, or a real Postgres one), with the model and the tool executor
 * doubled and a fake external service behind the tool that counts what
 * really happened.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 *
 * A worker "dies" the way a killed process does for the database: it stops
 * at a chosen point and never writes again, and its lease is not renewed
 * (`claimDead` claims the run with a lease already lapsed, and
 * `processLeasedStep` is driven without holdLease). Another worker then
 * finds the lease lapsed and takes the run over (`processStep`).
 */
import { Repository } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { Message } from '../../../entities/message.entity';
import { AgentStepProcessor } from '../agent-step-processor';
import { AgentRuntimeService } from '../agent-runtime.service';
import { writeRun } from '../run-event-writer';
import { AgentRuntimeBuilders } from '../agent-runtime-builders';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { resolveRunLimits } from '../run-limits';
import { claimRun } from '../run-lease';
import { fakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { userPrincipal } from '../../../common/authorization/execution-access.service';

export const MODEL = 'resume-model';
/** The agent's tools (ids are uuids, as `agents.toolIds` stores them). */
export const TOOL_CHARGE = '6f1c2b0e-4d7a-4c5e-9b1a-0c3d5e7f9a11';
export const TOOL_EMAIL = '6f1c2b0e-4d7a-4c5e-9b1a-0c3d5e7f9a22';
/** A write that takes no idempotency key. */
export const TOOL_NOTIFY = '6f1c2b0e-4d7a-4c5e-9b1a-0c3d5e7f9a33';
/** A read that takes no idempotency key. */
export const TOOL_LOOKUP = '6f1c2b0e-4d7a-4c5e-9b1a-0c3d5e7f9a44';

/** A model reply calling tools, as the provider layer hands it back. */
export const callsTools = (calls: Array<{ id: string; name: string; parameters: Record<string, any> }>, cost = 0.002, tokens = 100) => ({
  message: { role: 'assistant', content: '', toolCalls: calls },
  usage: { inputTokens: tokens - 20, outputTokens: 20, totalTokens: tokens },
  cost,
  model: MODEL,
  conversationId: '',
  messageId: '',
  responseTime: 5,
});

/** A model reply with the final answer. */
export const answers = (content: string, cost = 0.001, tokens = 60) => ({
  message: { role: 'assistant', content },
  usage: { inputTokens: tokens - 10, outputTokens: 10, totalTokens: tokens },
  cost,
  model: MODEL,
  conversationId: '',
  messageId: '',
  responseTime: 5,
});

/**
 * An outside API with a side effect (a charge, a sent email): what it did,
 * once per idempotency key when the caller sends one, every time when not.
 */
export function externalService() {
  const effects: Array<{ key: string | undefined; parameters: any }> = [];
  const seen = new Map<string, any>();
  return {
    effects,
    /** Make the call: the effect happens (once per key), and the response comes back. */
    call(parameters: any, key: string | undefined) {
      if (key && seen.has(key)) return seen.get(key);
      effects.push({ key, parameters });
      const response = { charged: parameters?.amount ?? null, receipt: `r-${effects.length}` };
      if (key) seen.set(key, response);
      return response;
    },
  };
}

/** A promise that never settles: the point a worker died at. */
export const never = () => new Promise<never>(() => undefined);

export interface Workers {
  runId: string;
  /** Every model call made, in order (the request each was made with). */
  modelCalls: any[];
  /** Every call that reached the tool executor: tool id, parameters, options. */
  toolCalls: Array<{ toolId: string; parameters: any; options: any }>;
  messages: ReturnType<typeof fakeRepository<Message>>;
  events: Array<{ type: string; data: any }>;
  /** The approval requests the run made (ApprovalsService, doubled). */
  approvals: ReturnType<typeof fakeApprovals>;
  /** A new worker: its own processor over the same database and services. */
  worker(): AgentStepProcessor;
  /** Claim the run for a worker that will die: a lease that has already lapsed and is never renewed. */
  claimDead(): Promise<string>;
  /**
   * A person decides an approval: the request is decided, and the run is
   * resumed (or not) by the runtime's own handler (AgentRuntimeService
   * handleApprovalDecided), as the 'approval.decided' event does.
   */
  decide(approvalId: string, status: 'approved' | 'rejected' | 'expired', reason?: string): Promise<void>;
}

/**
 * ApprovalsService, doubled: a request per (run, tool call), pausing the
 * run as the real create does (WAITING_APPROVAL through writeRun).
 */
export function fakeApprovals(runs: Repository<AgentRun>) {
  const rows: any[] = [];
  return {
    rows,
    create: jest.fn(async (input: any) => {
      const existing = rows.find((r) => input.toolCallId && r.runId === input.runId && r.toolCallId === input.toolCallId);
      if (existing) return existing;
      const row = { id: `a0a0a0a0-0000-4000-8000-${String(rows.length + 1).padStart(12, '0')}`, status: 'pending', decisionReason: null, decidedBy: null, ...input };
      rows.push(row);
      if (input.runId) await writeRun(runs, { id: input.runId }, { status: AgentRunStatus.WAITING_APPROVAL }, []);
      return row;
    }),
    findInOrganization: jest.fn(async (id: string, organizationId: string) => rows.find((r) => r.id === id && r.organizationId === organizationId) ?? null),
  };
}

export async function resumeWorkers(opts: {
  runs: Repository<AgentRun>;
  runId: string;
  organizationId: string;
  agentId: string;
  /** Model replies, in the order the model is asked. */
  replies: any[];
  /** What the tool executor does for a call (the doubled executeTool). */
  executeTool: (toolId: string, parameters: any, options: any) => Promise<any>;
  /** The organization's PII filter (ToolExecutorService.hidePersonalData); none when not given. */
  hidePersonalData?: (data: any, options: any) => Promise<any>;
}): Promise<Workers> {
  const modelCalls: any[] = [];
  const toolCalls: Workers['toolCalls'] = [];
  const events: Workers['events'] = [];
  const replies = [...opts.replies];
  const approvals = fakeApprovals(opts.runs);
  const messages = fakeRepository<Message>({ make: () => new Message(), idPrefix: 'msg' });
  let clock = Date.parse('2026-11-07T10:00:00Z');
  const store = messages.save.getMockImplementation()!;
  messages.save.mockImplementation(async (entity: any) => {
    if (!entity.createdAt) entity.createdAt = new Date(clock++);
    return store(entity);
  });
  await messages.save(Object.assign(Message.createUserMessage('conv-1', 'Charge the customer 40 EUR'), { runId: opts.runId }));

  const access = membershipFixture();
  access.member(opts.organizationId, 'u-1');
  const llmProvidersService = {
    chatStream: jest.fn(async (_providerId: string, request: any) => {
      modelCalls.push(JSON.parse(JSON.stringify(request)));
      const next = replies.shift();
      if (!next) throw new Error('the test has no model reply left');
      return JSON.parse(JSON.stringify(next));
    }),
    chat: jest.fn(async () => {
      throw new Error('no non-streaming model call is part of these runs');
    }),
  };
  const s: any = {
    logger: { log: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined },
    runRepository: opts.runs,
    messageRepository: messages,
    organizationRepository: fakeRepository([{ id: opts.organizationId, settings: {} }]),
    toolRepository: fakeRepository<any>([
      // Both send the call's idempotency key (their HTTP config names the header).
      {
        id: TOOL_CHARGE,
        organizationId: opts.organizationId,
        name: 'charge_card',
        description: 'Charge the customer',
        parameters: { type: 'object', properties: { amount: { type: 'number' } } },
        httpConfig: { method: 'POST', path: '/charges', headers: { 'Idempotency-Key': '' } },
      },
      {
        id: TOOL_EMAIL,
        organizationId: opts.organizationId,
        name: 'send_receipt',
        description: 'Email the receipt',
        parameters: { type: 'object', properties: { to: { type: 'string' } } },
        httpConfig: { method: 'POST', path: '/receipts', headers: { 'X-Idempotency-Key': '' } },
      },
      // A write that takes no key: made again, it may happen twice (unknown-writes.ts).
      {
        id: TOOL_NOTIFY,
        organizationId: opts.organizationId,
        name: 'notify_customer',
        description: 'Send the customer a message',
        parameters: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } } },
        httpConfig: { method: 'POST', path: '/messages', headers: {} },
      },
      // A read that takes no key: reading twice changes nothing.
      {
        id: TOOL_LOOKUP,
        organizationId: opts.organizationId,
        name: 'look_up_order',
        description: 'Look an order up',
        parameters: { type: 'object', properties: { email: { type: 'string' } } },
        httpConfig: { method: 'GET', path: '/orders', headers: {} },
      },
    ]),
    agentRepository: fakeRepository([]),
    executionAccess: access.executionAccess,
    misc: {
      resolveLimits: async (run: AgentRun, organization: any) => resolveRunLimits({ organization, agent: run.agent, run }),
      bumpAgentStats: async () => undefined,
    },
    builders: new AgentRuntimeBuilders(messages as any, { listActiveRules: async () => [] } as any),
    builtInTools: { executeBuiltInTool: async () => null },
    toolExecutorService: {
      executeTool: jest.fn(async (toolId: string, parameters: any, options: any) => {
        toolCalls.push({ toolId, parameters, options });
        return opts.executeTool(toolId, parameters, options);
      }),
      // The organization's PII filter; none by default.
      hidePersonalData: jest.fn(async (data: any, options: any) => (opts.hidePersonalData ? opts.hidePersonalData(data, options) : data)),
    },
    approvals,
    llmProvidersService,
    emitEvent: (_runId: string, type: string, data: any) => events.push({ type, data }),
  };

  const queued: any[] = [];
  return {
    runId: opts.runId,
    modelCalls,
    toolCalls,
    messages,
    events,
    approvals,
    worker: () => new AgentStepProcessor(s, new AgentVerifierHelper(llmProvidersService as any), {} as any, {} as any),
    claimDead: async () => {
      // A lease of 1 ms: lapsed by the time anyone else looks, and never renewed.
      const claim = await claimRun(opts.runs, opts.runId, { leaseMs: 1 });
      if (!claim.claimed) throw new Error(`could not claim the run for the dying worker: ${(claim as any).reason}`);
      await new Promise((r) => setTimeout(r, 5));
      return claim.owner;
    },
    decide: async (approvalId, status, reason) => {
      const row = approvals.rows.find((r) => r.id === approvalId);
      if (!row) throw new Error(`no approval ${approvalId}`);
      Object.assign(row, { status, decisionReason: reason ?? null, decidedBy: status === 'expired' ? null : 'u-1' });
      const runtime = { runRepository: opts.runs, messageRepository: messages, runtimeQueue: { add: async (...job: any[]) => queued.push(job) }, logger: s.logger };
      await (AgentRuntimeService.prototype as any).handleApprovalDecided.call(runtime, row);
    },
  };
}

/** The agent row of these runs: autonomous, one model, the two tools. */
export const resumeAgent = (organizationId: string) => ({
  name: 'resume-agent',
  organizationId,
  visibility: 'org',
  createdBy: 'u-1',
  mode: 'autonomous',
  status: 'active',
  instructions: 'Charge the customer and send the receipt.',
  toolIds: [TOOL_CHARGE, TOOL_EMAIL, TOOL_NOTIFY, TOOL_LOOKUP],
  modelConfig: { providerId: 'p-1', model: MODEL, temperature: 0, maxTokens: 400 },
  memoryConfig: { enabled: false },
  agentConfig: {},
  collaboration: null,
  settings: {},
  pipeline: { nodes: [], edges: [] },
});

/** The run row of these runs, before its first step. */
export const resumeRun = (organizationId: string, agentId: string) => ({
  agentId,
  organizationId,
  userId: null,
  // A member of the organization started it.
  principal: userPrincipal('u-1'),
  conversationId: 'conv-1',
  mode: 'autonomous',
  status: AgentRunStatus.RUNNING,
  input: 'Charge the customer 40 EUR',
  steps: [],
  currentStep: 0,
  maxSteps: 20,
  limits: { maxSteps: 20, maxCostCents: 100, maxDurationMs: 3_600_000, maxToolCalls: 100 },
  totalCost: 0,
  totalTokens: 0,
  toolCallCount: 0,
  executionTime: 0,
  workingMemory: {},
  metadata: {},
  nextWakeAt: new Date(Date.now() - 120_000),
});
