/**
 * A workflow engine with everything real except the network.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 *
 * The engine, the node executor, the template resolver, the verifier panel,
 * the sub-agent executor and the cancellation registry are the production
 * classes. What is faked is what would leave the process: the model call
 * (LlmProvidersService.chat), the tool call (ToolExecutorService.executeTool)
 * and the database (a compare-and-set execution table and an agent table).
 * Specs built on this prove what a user relies on, rather than proving that
 * a mocked executor was called in some order.
 */
import { AgentExecutionEngine, StreamEvent } from '../agent-execution.engine';
import { AgentExecutionStateHelper } from '../agent-execution-state.helper';
import { AgentExecutionCancellationService } from '../agent-execution-cancellation.service';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver } from '../agent-template-resolver';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import type { ChatRequest } from '../../llm-providers/llm-providers.service';
import { Agent, AgentPipeline, AgentPipelineNode, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution } from '../../../entities/agent-execution.entity';
import { Organization } from '../../../entities/organization.entity';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { fakeExecutionRepo, makeExecutionRow } from './agent-execution.fixtures';

export const ORG = 'org-1';
export const USER = 'user-1';

/** What a fake model answers with. A string is the whole answer. */
export type LlmReply = string | { content: string; cost?: number; tokens?: number };
export type LlmHandler = (req: ChatRequest, providerId: string | null) => LlmReply | Promise<LlmReply>;
export type ToolHandler = (
  toolId: string,
  params: Record<string, any>,
  signal?: AbortSignal,
) => { success: boolean; data?: any; error?: string } | Promise<{ success: boolean; data?: any; error?: string }>;

/** The text of the last message a model was sent: the resolved user prompt. */
export const promptOf = (req: ChatRequest): string => String(req.messages[req.messages.length - 1]?.content ?? '');

/**
 * Resolve after `ms`, or reject the moment `signal` aborts -- which is what
 * a real axios call handed that signal does.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export const node = (id: string, type: string, data: Record<string, any> = {}): AgentPipelineNode =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as AgentPipelineNode;

export const edge = (source: string, target: string, sourceHandle?: string) => ({
  id: `${source}->${target}${sourceHandle ? `:${sourceHandle}` : ''}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
});

/** An llm_call node pinned to a provider, with the given prompt. */
export const llm = (id: string, prompt: string, extra: Record<string, any> = {}) =>
  node(id, 'llm_call', { providerId: 'p-1', model: 'm-1', userPromptTemplate: prompt, ...extra });

export function makeAgent(pipeline: AgentPipeline, over: Partial<Agent> = {}): Agent {
  const agent = new Agent();
  Object.assign(agent, {
    id: 'agent-1',
    name: 'Behaviour',
    organizationId: ORG,
    status: AgentStatus.ACTIVE,
    mode: 'workflow',
    visibility: 'org',
    pipeline,
    variables: {},
    settings: {},
    agentConfig: {},
    metadata: {},
    totalExecutions: 0,
    successfulExecutions: 0,
    totalCost: 0,
    averageExecutionTime: 0,
    createdBy: USER,
    ...over,
  });
  return agent;
}

export interface HarnessOptions {
  llm?: LlmHandler;
  tool?: ToolHandler;
  organization?: Partial<Organization> | null;
  /**
   * A compiled strategy for the engine to run instead of the drawn graph,
   * with the roles it names filled. Roles resolve to provider `p-<role>`.
   */
  strategy?: { key: string; pipeline: AgentPipeline; roles: string[] };
}

export function buildHarness(opts: HarnessOptions = {}) {
  const execRepo = fakeExecutionRepo([]);
  // Every run gets its own row: sub-agent runs nest inside their parent's,
  // and a shared id would make them overwrite each other.
  let seq = 0;
  execRepo.create.mockImplementation((v: any) => Object.assign(makeExecutionRow({ id: `exec-${++seq}` }), v));

  const agents = new Map<string, Agent>();
  const statsQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const agentRepo = {
    findOne: jest.fn(async ({ where }: any) => {
      const found = agents.get(where?.id);
      return found && (!where.organizationId || found.organizationId === where.organizationId) ? found : null;
    }),
    save: jest.fn(async (a: any) => a),
    createQueryBuilder: jest.fn(() => statsQb),
  };
  const orgRepo = { findOne: jest.fn(async () => (opts.organization ?? null) as Organization | null) };

  const llmHandler: LlmHandler = opts.llm ?? ((req) => `echo: ${promptOf(req)}`);
  const chat = jest.fn(async (providerId: string | null, req: ChatRequest) => {
    const reply = await llmHandler(req, providerId);
    const r = typeof reply === 'string' ? { content: reply } : reply;
    return {
      message: { role: 'assistant', content: r.content },
      cost: r.cost ?? 0,
      usage: { totalTokens: r.tokens ?? 10, inputTokens: 6, outputTokens: 4 },
      model: 'm-1',
    } as any;
  });
  const toolHandler: ToolHandler = opts.tool ?? ((toolId, params) => ({ success: true, data: { toolId, params } }));
  const executeTool = jest.fn(async (toolId: string, params: Record<string, any>, o: any) =>
    toolHandler(toolId, params, o?.signal),
  );

  const membership = membershipFixture();
  membership.member(ORG, USER);
  const assertCanExecute = jest.spyOn(membership.executionAccess, 'assertCanExecute');

  const resolver = new AgentTemplateResolver();
  const state = new AgentExecutionStateHelper(agentRepo as any, execRepo as any);
  const cancellations = new AgentExecutionCancellationService(execRepo as any);
  const verifier = new AgentVerifierHelper({ chat } as any);

  // The engine and the executors refer to each other (a sub_agent node
  // re-enters the engine), so the engine is filled in after construction.
  const engineRef: { current?: AgentExecutionEngine } = {};
  const engineProxy = { execute: (...args: any[]) => (engineRef.current as any).execute(...args) };
  const subAgents = new AgentSubAgentExecutors(resolver, agentRepo as any, engineProxy as any, {} as any, {} as any);
  const executor = new AgentNodeExecutor(
    resolver,
    { chat } as any,
    { executeTool } as any,
    agentRepo as any,
    engineProxy as any,
    {} as any,
    {} as any,
    subAgents,
    verifier,
    // Role lookups only: a filled role names model `m-<role>` on provider `p-<role>`.
    {
      providerForModelId: async (_org: string, modelId: string) => ({
        card: { vendorModelId: modelId },
        provider: { id: modelId.replace(/^m-/, 'p-') },
      }),
    } as any,
    orgRepo as any,
  );
  const engine = new AgentExecutionEngine(
    agentRepo as any,
    execRepo as any,
    executor,
    { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } as any,
    state,
    undefined,
    opts.strategy
      ? ({ pipelineFor: async () => ({ pipeline: opts.strategy!.pipeline, strategyKey: opts.strategy!.key }) } as any)
      : undefined,
    opts.strategy
      ? ({
          resolveRoles: async () =>
            opts.strategy!.roles.map((key) => ({ key, modelId: `m-${key}`, via: 'pinned' as const })),
        } as any)
      : undefined,
    orgRepo as any,
    undefined,
    cancellations,
    membership.executionAccess,
  );
  engineRef.current = engine;

  const events: StreamEvent[] = [];

  return {
    engine,
    executor,
    execRepo,
    agents,
    chat,
    executeTool,
    cancellations,
    assertCanExecute,
    /** The real execution gate, over the harness's one member (USER in ORG). */
    executionAccess: membership.executionAccess,
    events,
    /** Run an agent to its end, collecting its stream events. */
    run(agent: Agent, input: Record<string, any> = {}, extra: Record<string, any> = {}): Promise<AgentExecution> {
      agents.set(agent.id, agent);
      return engine.execute(agent, ORG, USER, { input, ...extra }, (e) => events.push(e));
    },
    /** The ids of the nodes whose prompts reached the model, in call order. */
    promptsSent(): string[] {
      return chat.mock.calls.map(([, req]) => promptOf(req as ChatRequest));
    },
  };
}

export type Harness = ReturnType<typeof buildHarness>;
