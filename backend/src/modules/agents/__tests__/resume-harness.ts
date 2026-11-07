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
import { AgentRuntimeBuilders } from '../agent-runtime-builders';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { resolveRunLimits } from '../run-limits';
import { claimRun } from '../run-lease';
import { fakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { userPrincipal } from '../../../common/authorization/execution-access.service';

export const MODEL = 'resume-model';
/** The agent's two tools (ids are uuids, as `agents.toolIds` stores them). */
export const TOOL_CHARGE = '6f1c2b0e-4d7a-4c5e-9b1a-0c3d5e7f9a11';
export const TOOL_EMAIL = '6f1c2b0e-4d7a-4c5e-9b1a-0c3d5e7f9a22';

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
  /** A new worker: its own processor over the same database and services. */
  worker(): AgentStepProcessor;
  /** Claim the run for a worker that will die: a lease that has already lapsed and is never renewed. */
  claimDead(): Promise<string>;
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
}): Promise<Workers> {
  const modelCalls: any[] = [];
  const toolCalls: Workers['toolCalls'] = [];
  const events: Workers['events'] = [];
  const replies = [...opts.replies];
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
      {
        id: TOOL_CHARGE,
        organizationId: opts.organizationId,
        name: 'charge_card',
        description: 'Charge the customer',
        parameters: { type: 'object', properties: { amount: { type: 'number' } } },
      },
      {
        id: TOOL_EMAIL,
        organizationId: opts.organizationId,
        name: 'send_receipt',
        description: 'Email the receipt',
        parameters: { type: 'object', properties: { to: { type: 'string' } } },
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
    },
    llmProvidersService,
    emitEvent: (_runId: string, type: string, data: any) => events.push({ type, data }),
  };

  return {
    runId: opts.runId,
    modelCalls,
    toolCalls,
    messages,
    events,
    worker: () => new AgentStepProcessor(s, new AgentVerifierHelper(llmProvidersService as any), {} as any, {} as any),
    claimDead: async () => {
      // A lease of 1 ms: lapsed by the time anyone else looks, and never renewed.
      const claim = await claimRun(opts.runs, opts.runId, { leaseMs: 1 });
      if (!claim.claimed) throw new Error(`could not claim the run for the dying worker: ${(claim as any).reason}`);
      await new Promise((r) => setTimeout(r, 5));
      return claim.owner;
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
  toolIds: [TOOL_CHARGE, TOOL_EMAIL],
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
