import type { AgentRun } from '../../entities/agent-run.entity';
import type { ChatRequest, ChatResponse } from '../llm-providers/llm-providers.service';
import { principalOfRun } from '../../common/authorization/execution-access.service';
import type { AgentRuntimeService } from './agent-runtime.service';
import type { AgentVerifierHelper, CheckerConfig, VerifyPanelResult } from './agent-verifier.helper';
import { answerCallMessages } from './final-answer';
import { checkRunLimits, type ResolvedRunLimits } from './run-limits';
import { EXTRACT_CONTEXT_INSTRUCTION, ExtractedContext, parseExtractedContext } from './strategies/extract-context';
import { bestOfNJudgePrompt, consensusJudgePrompt, parseBestOfNPick, parseConsensus } from './strategies/judging';
import { AgentRoleCall, ModelRoleCall, RoleStamp, TeamRole, stampOf } from './autonomous-team';

/**
 * The model work an autonomous strategy does beyond the loop's own call:
 * checking a draft, extra candidate answers and the judge that picks one,
 * panel answers and their consensus, explorers and the brief, teammates.
 *
 * Constructed per step by AgentStepProcessor with the runtime and the
 * shared verifier, so it adds nothing to the dependency graph and a run
 * on the Single strategy never touches it. Every call here is charged to
 * the run (totalCost, totalTokens) and to the role that made it
 * (metadata.roleCosts), and every call that is a step of the run is
 * recorded on `run.steps` with that role.
 *
 * See docs/autonomous-models.md for what each strategy does.
 */

/** A role's spend on one run. */
export interface RoleCost {
  name: string;
  purpose: string;
  kind: 'model' | 'agent';
  cost: number;
  tokens: number;
  calls: number;
}

/** One model call made for a role, and what it cost. */
export interface RoleAnswer {
  content: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  duration: number;
  model?: string;
  providerId?: string;
  routing?: ChatResponse['routing'];
  error?: string;
}

/** A child run made for a role (an agent panelist or teammate, an explorer). */
export interface ChildRunResult {
  childRunId?: string;
  status: string;
  output: string;
  cost: number;
  tokens: number;
  duration: number;
  error?: string;
}

/** Longest a strategy waits on one child run. */
const CHILD_RUN_TIMEOUT_MS = 300_000;
/** Step ceiling for a child run a strategy starts. */
const CHILD_RUN_MAX_STEPS = 20;

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);

/** Add a call's spend to the role's line on the run. Leaves totalCost alone. */
export function chargeRole(run: AgentRun, role: TeamRole | RoleStamp, cost: number, tokens: number, calls = 1): void {
  const metadata = (run.metadata = run.metadata ?? {});
  const costs: Record<string, RoleCost> = (metadata.roleCosts = metadata.roleCosts ?? {});
  const line = costs[role.key] ?? { name: role.name, purpose: role.purpose, kind: role.kind, cost: 0, tokens: 0, calls: 0 };
  line.cost += cost || 0;
  line.tokens += tokens || 0;
  line.calls += calls;
  costs[role.key] = line;
}

/** Which model answered a call, for the step it is recorded on. */
export function answeredBy(
  response: Pick<ChatResponse, 'model' | 'routing'> | null | undefined,
  role: Pick<ModelRoleCall, 'model' | 'providerId'>,
): { model?: string; providerId?: string; routing?: ChatResponse['routing'] } {
  const model = response?.model || response?.routing?.vendorModelId || role.model;
  const providerId = response?.routing?.providerId ?? role.providerId;
  return {
    ...(model ? { model } : {}),
    ...(providerId ? { providerId } : {}),
    ...(response?.routing ? { routing: response.routing } : {}),
  };
}

/** The request a model role makes: the base request on the role's model and sampling. */
export function requestFor(role: ModelRoleCall, base: ChatRequest): ChatRequest {
  const { routing: _routing, model: _model, temperature: _t, maxTokens: _m, ...rest } = base;
  return {
    ...rest,
    model: role.routing ? undefined : role.model,
    temperature: role.temperature,
    maxTokens: role.maxTokens,
    ...(role.routing ? { routing: role.routing } : {}),
  };
}

/** The checker a role is, in the verifier's terms. */
export function checkerOf(role: ModelRoleCall): CheckerConfig {
  return {
    name: role.name,
    ...(role.providerId ? { providerId: role.providerId } : {}),
    ...(role.routing ? { routing: role.routing } : { model: role.model }),
    ...(role.instructions ? { instructions: role.instructions } : {}),
    ...(role.temperature !== undefined ? { temperature: role.temperature } : {}),
    ...(role.maxTokens !== undefined ? { maxTokens: role.maxTokens } : {}),
  };
}

/** The last thing the user said in a conversation, as text. */
export function latestUserText(messages: ChatRequest['messages'], fallback: unknown): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m?.role === 'user' && !m.toolCallId) {
      const text = asText(m.content).trim();
      if (text) return text;
    }
  }
  return asText(fallback);
}

export class AutonomousStrategyRunner {
  constructor(
    private readonly s: AgentRuntimeService,
    private readonly verifier: AgentVerifierHelper,
  ) {}

  /**
   * One call by a model role, charged to the run and the role. Never
   * throws: a failed call comes back with `error` and no content, so a
   * strategy can drop one candidate or one panelist without failing the
   * run over it.
   */
  async callModel(run: AgentRun, role: ModelRoleCall, request: ChatRequest): Promise<RoleAnswer> {
    const startedAt = Date.now();
    try {
      const response = await this.s.llmProvidersService.chatStream(
        role.providerId,
        requestFor(role, request),
        run.organizationId,
        run.userId,
        () => undefined,
      );
      const cost = response.cost || 0;
      const inputTokens = response.usage?.inputTokens || 0;
      const outputTokens = response.usage?.outputTokens || 0;
      const tokens = response.usage?.totalTokens || inputTokens + outputTokens;
      run.totalCost += cost;
      run.totalTokens += tokens;
      chargeRole(run, role, cost, tokens);
      return {
        content: response.message?.content || '',
        cost,
        inputTokens,
        outputTokens,
        duration: Date.now() - startedAt,
        ...answeredBy(response, role),
      };
    } catch (err: any) {
      chargeRole(run, role, 0, 0);
      return {
        content: '',
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        duration: Date.now() - startedAt,
        error: err?.message ?? String(err),
        ...answeredBy(null, role),
      };
    }
  }

  /**
   * A no-tools answer from a model role over the loop's conversation: the
   * same system prompt, memory and turns the loop's own call saw, with the
   * tool turns written out as text (final-answer.ts).
   */
  answerOver(run: AgentRun, role: ModelRoleCall, loopRequest: ChatRequest): Promise<RoleAnswer> {
    return this.callModel(run, role, {
      ...loopRequest,
      messages: answerCallMessages(loopRequest.messages as any[]) as ChatRequest['messages'],
      tools: undefined,
    });
  }

  /**
   * The checker role's refute-only verdict on `target`, through the
   * shared verifier. An error or unreadable verdict is a fail: "we could
   * not tell" must never pass an unchecked answer.
   */
  async check(run: AgentRun, checker: ModelRoleCall, target: string, spec?: string): Promise<VerifyPanelResult> {
    const panel = await this.verifier.runPanel(
      { target, spec, checkers: [checkerOf(checker)], policy: 'any_fail_blocks' },
      run.organizationId,
      run.userId,
    );
    run.totalCost += panel.cost;
    run.totalTokens += panel.tokens;
    chargeRole(run, checker, panel.cost, panel.tokens);
    return panel;
  }

  /**
   * Best of N: the loop's answer is candidate 1; the main role writes
   * N-1 more over the same context, and the checker picks one.
   *
   * An extra candidate is not started once the run is at a ceiling, and
   * one that fails or comes back empty is dropped rather than judged. With
   * one candidate left there is nothing to choose between, and no judging
   * call is paid for.
   */
  async bestOfN(opts: {
    run: AgentRun;
    main: ModelRoleCall;
    judge: ModelRoleCall;
    loopRequest: ChatRequest;
    first: string;
    n: number;
    limits: ResolvedRunLimits;
  }): Promise<{ content: string; picked: number; candidates: number }> {
    const { run, main, judge, loopRequest, first, n, limits } = opts;
    const candidates: string[] = [first];
    for (let i = 2; i <= n; i++) {
      if (checkRunLimits(run, limits)) {
        this.record(run, main, 'llm_call', { status: 'candidate', candidate: i, skipped: 'run limit reached' }, null);
        break;
      }
      const answer = await this.answerOver(run, main, loopRequest);
      this.record(run, main, 'llm_call', { status: 'candidate', candidate: i, content: answer.content.substring(0, 200) }, answer);
      if (answer.content.trim()) candidates.push(answer.content);
    }
    if (candidates.length < 2) {
      this.record(run, judge, 'judge', { strategy: 'best_of_n', picked: 1, candidates: candidates.length, skipped: 'one candidate' }, null);
      return { content: candidates[0], picked: 1, candidates: candidates.length };
    }
    const verdict = await this.callModel(run, judge, {
      messages: [
        ...(judge.instructions ? [{ role: 'system' as any, content: judge.instructions }] : []),
        { role: 'user' as any, content: bestOfNJudgePrompt(candidates) },
      ],
    });
    const { index, read } = parseBestOfNPick(verdict.content, candidates.length);
    this.record(
      run,
      judge,
      'judge',
      { strategy: 'best_of_n', picked: index + 1, candidates: candidates.length, ...(read ? {} : { unread: true }) },
      verdict,
    );
    return { content: candidates[index], picked: index + 1, candidates: candidates.length };
  }

  /**
   * Panel: the loop's answer (the main role's) and each panelist's, then
   * the judge writes the answer they agree on. A model panelist answers
   * over the same conversation with no tools; an agent panelist answers
   * as its own run of that agent, on the user's latest message.
   */
  async panel(opts: {
    run: AgentRun;
    main: ModelRoleCall;
    panelists: TeamRole[];
    judge: ModelRoleCall;
    loopRequest: ChatRequest;
    first: string;
    limits: ResolvedRunLimits;
  }): Promise<{ content: string; agreement?: number; consensusReached: boolean; answers: number }> {
    const { run, main, panelists, judge, loopRequest, first, limits } = opts;
    const answers: string[] = [first];
    const question = latestUserText(loopRequest.messages, run.input);
    const results = await Promise.all(
      panelists.map(async (p) => {
        if (p.kind === 'agent') {
          const child = await this.runChild(run, p, p.agentId, question, limits);
          this.record(run, p, 'llm_call', { status: 'panel_answer', childRunId: child.childRunId, content: child.output.substring(0, 200), ...(child.error ? { error: child.error } : {}) }, null, { cost: child.cost, duration: child.duration, tokens: child.tokens });
          return child.status === 'completed' ? child.output : '';
        }
        const answer = await this.answerOver(run, p, loopRequest);
        this.record(run, p, 'llm_call', { status: 'panel_answer', content: answer.content.substring(0, 200) }, answer);
        return answer.content;
      }),
    );
    for (const r of results) if (r && r.trim()) answers.push(r);
    void main;

    if (answers.length < 2) {
      this.record(run, judge, 'judge', { strategy: 'panel', candidates: answers.length, agreement: 1, consensusReached: true, skipped: 'one answer' }, null);
      return { content: answers[0], agreement: 1, consensusReached: true, answers: answers.length };
    }
    const verdict = await this.callModel(run, judge, {
      messages: [
        ...(judge.instructions ? [{ role: 'system' as any, content: judge.instructions }] : []),
        { role: 'user' as any, content: consensusJudgePrompt(answers) },
      ],
    });
    const threshold = 0.5;
    const read = parseConsensus(verdict.content, answers.length, threshold);
    // A judge that failed outright leaves the main role's answer standing.
    const content = verdict.error || !read.answer.trim() ? first : read.answer;
    this.record(
      run,
      judge,
      'judge',
      {
        strategy: 'panel',
        candidates: answers.length,
        agreement: read.agreement,
        consensusReached: read.consensusReached,
        threshold,
        ...(content === first && (verdict.error || !read.answer.trim()) ? { fallback: 'main answer' } : {}),
      },
      verdict,
    );
    return { content, agreement: read.agreement, consensusReached: read.consensusReached, answers: answers.length };
  }

  /**
   * Explore, extract: every explorer is its own run of this agent on the
   * explorer's model (`metadata.actAs`), with the agent's tools, in
   * parallel; the summariser then compresses what they found into a
   * brief. A brief that does not validate throws EXTRACTED_CONTEXT_INVALID
   * rather than passing the transcripts through (docs/strategies.md).
   */
  async exploreAndExtract(opts: {
    run: AgentRun;
    agentId: string;
    explorers: ModelRoleCall[];
    summariser: ModelRoleCall;
    task: string;
    limits: ResolvedRunLimits;
  }): Promise<ExtractedContext> {
    const { run, agentId, explorers, summariser, task, limits } = opts;
    const share = Math.max(1, Math.floor(this.remainingCents(run, limits) / Math.max(1, explorers.length)));
    const found = await Promise.all(
      explorers.map(async (explorer) => {
        const child = await this.runChild(run, explorer, agentId, task, limits, { actAs: explorer.key }, share);
        this.record(
          run,
          explorer,
          'explore',
          { status: child.status, preview: child.output.substring(0, 200), ...(child.error ? { error: child.error } : {}) },
          null,
          { cost: child.cost, duration: child.duration, tokens: child.tokens },
          { childRunId: child.childRunId },
        );
        return { explorer, child };
      }),
    );
    const usable = found.filter(({ child }) => child.status === 'completed' && child.output.trim());
    if (usable.length === 0) {
      throw new Error(
        `No explorer came back with findings (${found.map(({ explorer, child }) => `${explorer.name}: ${child.error ?? child.status}`).join('; ')}).`,
      );
    }

    const sources = usable.map(({ explorer, child }) => `### ${explorer.name}\n${child.output}`).join('\n\n---\n\n');
    const answer = await this.callModel(run, summariser, {
      messages: [
        { role: 'system' as any, content: EXTRACT_CONTEXT_INSTRUCTION },
        { role: 'user' as any, content: ['Task:', task.trim() || '(not given)', '', 'Attempts to compress:', sources].join('\n') },
      ],
    });
    if (answer.error) {
      this.record(run, summariser, 'extract_context', { error: answer.error }, answer);
      throw new Error(`The summariser could not write the brief: ${answer.error}`);
    }
    try {
      const brief = parseExtractedContext(answer.content);
      this.record(run, summariser, 'extract_context', { brief }, answer);
      return brief;
    } catch (err) {
      this.record(run, summariser, 'extract_context', { error: (err as Error).message, raw: answer.content.substring(0, 500) }, answer);
      throw err;
    }
  }

  /**
   * A teammate, asked by the loop's model through its `ask_<key>` tool. A
   * model teammate answers with one call; an agent teammate with a child
   * run of that agent, in this run's scope.
   */
  async askTeammate(
    run: AgentRun,
    teammate: TeamRole,
    input: string,
    limits: ResolvedRunLimits,
  ): Promise<{ result?: string; error?: string }> {
    if (teammate.kind === 'agent') {
      const child = await this.runChild(run, teammate, teammate.agentId, input, limits);
      this.record(
        run,
        teammate,
        'teammate_call',
        { preview: child.output.substring(0, 200), status: child.status, ...(child.error ? { error: child.error } : {}) },
        null,
        { cost: child.cost, duration: child.duration, tokens: child.tokens },
        { teammate: teammate.key, childRunId: child.childRunId },
      );
      return child.status === 'completed' ? { result: child.output } : { error: child.error ?? `${teammate.name} did not finish (${child.status})` };
    }
    const answer = await this.callModel(run, teammate, {
      messages: [
        {
          role: 'system' as any,
          content: [`You are ${teammate.name}, a teammate another model has handed a piece of work to. Do that piece of work and answer it directly.`, teammate.instructions ?? '']
            .filter(Boolean)
            .join('\n\n'),
        },
        { role: 'user' as any, content: input },
      ],
    });
    this.record(run, teammate, 'teammate_call', { preview: answer.content.substring(0, 200), ...(answer.error ? { error: answer.error } : {}) }, answer, undefined, { teammate: teammate.key });
    return answer.error ? { error: `${teammate.name} could not answer: ${answer.error}` } : { result: answer.content };
  }

  /** Cents the run may still spend, never below one. */
  private remainingCents(run: AgentRun, limits: ResolvedRunLimits): number {
    return Math.max(1, Math.floor(limits.maxCostCents - (run.totalCost ?? 0) * 100));
  }

  /**
   * A child run for a role, in this run's scope (the child inherits the
   * principal, and startRun refuses an agent that scope cannot run). Its
   * cost and tokens are added to this run and to the role.
   */
  private async runChild(
    run: AgentRun,
    role: TeamRole,
    agentId: string,
    input: string,
    limits: ResolvedRunLimits,
    metadata?: Record<string, any>,
    maxCostCents?: number,
  ): Promise<ChildRunResult> {
    const startedAt = Date.now();
    let childRunId: string | undefined;
    try {
      // The child gets what is left of this run's time, and at most the
      // strategy's own ceiling, as its duration limit.
      const elapsed = Date.now() - new Date(run.createdAt ?? Date.now()).getTime();
      const maxDurationMs = Math.max(1_000, Math.min(CHILD_RUN_TIMEOUT_MS, limits.maxDurationMs - elapsed));
      const child = await this.s.startRun(agentId, run.organizationId, run.userId ?? null, input, {
        parentRunId: run.id,
        maxSteps: CHILD_RUN_MAX_STEPS,
        maxCostCents: maxCostCents ?? this.remainingCents(run, limits),
        maxDurationMs,
        principal: principalOfRun(run),
        // Driven here, by this worker, step by step: queued, it would wait
        // behind the very job that is waiting for it.
        inline: true,
        ...(metadata ? { metadata } : {}),
      });
      childRunId = child.id;
      // Every step either advances the run or ends it, and the child's own
      // limits end it at the latest by maxSteps; the bound is a backstop.
      let result: 'continue' | 'done' | 'waiting' = 'continue';
      for (let i = 0; result === 'continue' && i <= CHILD_RUN_MAX_STEPS + 1; i++) {
        result = await this.s.processStep(child.id);
      }
      const done = await this.s.runRepository.findOne({ where: { id: child.id } });
      const cost = done?.totalCost || 0;
      const tokens = done?.totalTokens || 0;
      run.totalCost += cost;
      run.totalTokens += tokens;
      chargeRole(run, role, cost, tokens);
      const status = done?.status ?? 'unknown';
      return {
        childRunId,
        status,
        output: asText(done?.output),
        cost,
        tokens,
        duration: Date.now() - startedAt,
        ...(done?.error ? { error: done.error } : {}),
      };
    } catch (err: any) {
      chargeRole(run, role, 0, 0);
      return {
        childRunId,
        status: 'failed',
        output: '',
        cost: 0,
        tokens: 0,
        duration: Date.now() - startedAt,
        error: err?.message ?? String(err),
      };
    }
  }

  /** Append a step this role made. */
  private record(
    run: AgentRun,
    role: TeamRole,
    type: string,
    output: Record<string, any>,
    answer: RoleAnswer | null,
    spent?: { cost: number; duration: number; tokens: number },
    input?: Record<string, any>,
  ): void {
    run.steps.push({
      type,
      role: stampOf(role),
      ...(input ? { input } : {}),
      output: {
        ...output,
        ...(answer?.model ? { model: answer.model } : {}),
        ...(answer?.providerId ? { providerId: answer.providerId } : {}),
        ...(answer?.routing ? { routing: answer.routing } : {}),
      },
      cost: answer ? answer.cost : spent?.cost ?? 0,
      ...(answer
        ? { tokens: { input: answer.inputTokens, output: answer.outputTokens } }
        : spent?.tokens
          ? { tokens: { input: 0, output: spent.tokens } }
          : {}),
      duration: answer ? answer.duration : spent?.duration ?? 0,
      timestamp: new Date().toISOString(),
      ...(answer?.error ? { error: answer.error } : {}),
    } as AgentRun['steps'][number]);
  }
}

export type { AgentRoleCall };
