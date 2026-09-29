import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Agent } from '../../entities/agent.entity';
import { batchAsync } from '../../common/utils/batch-async';
import { principalOfRun } from '../../common/authorization/execution-access.service';
import { AgentRuntimeService } from './agent-runtime.service';
import {
  AgentCollaboration,
  CollaborationParticipant,
  buildCollaborationContext,
  participantLabel,
} from './collaboration-participants';

/** Per-call ceilings for one participant. Model participants use only the timeout. */
interface ParticipantLimits {
  maxSteps: number;
  maxCostCents: number;
  timeoutMs: number;
}

/** What one participant produced. */
export interface ParticipantResult {
  output: string;
  cost: number;
  tokens: number;
  label: string;
}

/**
 * A started participant. `result` is already in flight: for an agent the
 * child run exists (`runId`), for a model the call has been made.
 */
interface ParticipantHandle {
  participant: CollaborationParticipant;
  label: string;
  runId?: string;
  result: Promise<ParticipantResult>;
}

const LIMITS_MAIN: ParticipantLimits = { maxSteps: 20, maxCostCents: 50, timeoutMs: 300000 };
const LIMITS_SHORT: ParticipantLimits = { maxSteps: 10, maxCostCents: 25, timeoutMs: 120000 };

/** How a participant is identified in a recorded step. */
function describeParticipant(p: CollaborationParticipant): Record<string, any> {
  if (p.kind === 'agent') {
    return { kind: 'agent', agentId: p.agentId, ...(p.role ? { role: p.role } : {}) };
  }
  return {
    kind: 'model',
    ...(p.providerId ? { providerId: p.providerId } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.routing ? { routed: true } : {}),
    ...(p.role ? { role: p.role } : {}),
  };
}

function asText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * Runs an autonomous agent's collaboration: its participants, composed by
 * strategy (sequential / parallel / race / debate), with an optional judge.
 * A participant is another agent (a child run) or a model (one call through
 * LlmProvidersService); every strategy and the judge accept both, in the
 * configured order, through `startParticipant` / `runParticipant`.
 *
 * `rules.maxTotalCost` is enforced here, before each participant starts: a
 * model participant is a direct call no child run ever sees, so the sibling
 * check in agent-step-processor cannot cover it.
 */
@Injectable()
export class AgentCollaborationHelper {
  private readonly logger = new Logger(AgentCollaborationHelper.name);

  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @Inject(forwardRef(() => AgentRuntimeService))
    private readonly runtime: AgentRuntimeService,
  ) {}

  async processCollaborationStep(run: AgentRun, agent: Agent): Promise<'continue' | 'done' | 'waiting'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();

    try {
      switch (collab.strategy) {
        case 'sequential':
          return await this.runSequentialCollaboration(run, agent);
        case 'parallel':
          return await this.runParallelCollaboration(run, agent);
        case 'race':
          return await this.runRaceCollaboration(run, agent);
        case 'debate':
          return await this.runDebateCollaboration(run, agent);
        default:
          throw new Error(`Unknown collaboration strategy: ${collab.strategy}`);
      }
    } catch (error) {
      this.logger.error(`Collaboration step failed for run ${run.id}: ${error.message}`, error.stack);

      const stepDuration = Date.now() - stepStart;
      run.steps.push({
        type: 'error',
        error: `Collaboration (${collab.strategy}) failed: ${error.message}`,
        timestamp: new Date().toISOString(),
        duration: stepDuration,
      });
      run.status = AgentRunStatus.FAILED;
      run.error = error.message;
      run.executionTime += stepDuration;
      await this.runRepository.save(run);
      this.runtime.emitEvent(run.id, 'run.failed', { error: error.message });
      return 'done';
    }
  }

  /**
   * Sequential: the orchestrator agent runs first, then each participant in
   * order, each receiving the previous one's output as input.
   */
  async runSequentialCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = asText(run.input);
    const outputs: Array<{ participant: Record<string, any>; label: string; output: string }> = [];

    // Step 1: Run the orchestrator agent itself first (its own ReAct loop with tools)
    // The child run has parentRunId set, so it won't re-enter collaboration
    const orchestratorRun = await this.runtime.startRun(
      agent.id,
      run.organizationId,
      run.userId,
      inputText,
      {
        parentRunId: run.id,
        maxSteps: LIMITS_MAIN.maxSteps,
        maxCostCents: LIMITS_MAIN.maxCostCents,
        principal: principalOfRun(run),
      },
    );
    const orchestratorResult = await this.runtime.waitForRun(orchestratorRun.id, LIMITS_MAIN.timeoutMs);

    let currentInput = orchestratorResult?.output ? asText(orchestratorResult.output) : inputText;
    outputs.push({ participant: { kind: 'agent', agentId: agent.id, role: 'orchestrator' }, label: 'orchestrator', output: currentInput });
    run.totalCost += orchestratorResult?.totalCost || 0;
    run.totalTokens += orchestratorResult?.totalTokens || 0;

    // Step 2: each participant in order, piping output → input. The cost
    // rule is checked before every one, so a chain that has spent its
    // budget stops before the next call rather than after it.
    for (const p of collab.participants) {
      if (await this.stopOnCostLimit(run, collab, participantLabel(p), stepStart)) return 'done';
      const result = await this.runParticipant(run, collab, p, currentInput, LIMITS_MAIN);
      outputs.push({ participant: describeParticipant(p), label: result.label, output: result.output });
      run.totalCost += result.cost;
      run.totalTokens += result.tokens;
      currentInput = result.output;
    }

    // The last participant's output is the collaboration's output
    run.output = outputs[outputs.length - 1]?.output || 'No output';
    run.status = AgentRunStatus.COMPLETED;

    const stepDuration = Date.now() - stepStart;
    run.steps.push({
      type: 'collaboration_sequential',
      input: { participantCount: collab.participants.length },
      output: {
        participantOutputs: outputs.map((o) => ({
          participant: o.participant,
          label: o.label,
          outputPreview: String(o.output).substring(0, 200),
        })),
      },
      duration: stepDuration,
      timestamp: new Date().toISOString(),
    });
    return this.complete(run, stepDuration);
  }

  /**
   * Parallel: run every participant on the same input at once, then merge
   * through the judge or by concatenation.
   */
  async runParallelCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = asText(run.input);

    if (await this.stopOnCostLimit(run, collab, 'the parallel fan-out', stepStart)) return 'done';

    const results = await Promise.all(
      collab.participants.map((p) => this.runParticipant(run, collab, p, inputText, LIMITS_MAIN)),
    );

    for (const r of results) {
      run.totalCost += r.cost;
      run.totalTokens += r.tokens;
    }

    let finalOutput: string;
    if (collab.judge) {
      const judgeInput = `Multiple participants were asked: "${inputText}"\n\nTheir responses:\n\n` +
        results.map((r, i) => `### Participant ${i + 1} (${r.label}):\n${r.output}`).join('\n\n') +
        '\n\nPlease synthesize the best answer from these responses.';

      if (await this.stopOnCostLimit(run, collab, 'the judge', stepStart)) return 'done';
      const judged = await this.runParticipant(run, collab, collab.judge, judgeInput, LIMITS_SHORT, 'judge');
      finalOutput = judged.output || 'Judge failed to produce output';
      run.totalCost += judged.cost;
      run.totalTokens += judged.tokens;
    } else {
      finalOutput = results.map((r, i) => `[Participant ${i + 1} - ${r.label}]: ${r.output}`).join('\n\n');
    }

    run.output = finalOutput;
    run.status = AgentRunStatus.COMPLETED;

    const stepDuration = Date.now() - stepStart;
    run.steps.push({
      type: 'collaboration_parallel',
      input: {
        participantCount: collab.participants.length,
        hasJudge: !!collab.judge,
        ...(collab.judge ? { judge: describeParticipant(collab.judge) } : {}),
      },
      output: {
        participantOutputs: results.map((r, i) => ({
          participant: describeParticipant(collab.participants[i]),
          label: r.label,
          outputPreview: String(r.output).substring(0, 200),
        })),
      },
      duration: stepDuration,
      timestamp: new Date().toISOString(),
    });
    return this.complete(run, stepDuration);
  }

  /**
   * Race: start every participant, take the first to finish, stop the rest.
   * Agent losers are soft-cancelled; model losers are aborted mid-call.
   */
  async runRaceCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = asText(run.input);

    if (await this.stopOnCostLimit(run, collab, 'the race', stepStart)) return 'done';

    // One abort controller per model racer; agents have no in-flight
    // signal to cut and are cancelled through their run row below.
    const controllers = collab.participants.map((p) => (p.kind === 'model' ? new AbortController() : undefined));
    const handles = await Promise.all(
      collab.participants.map((p, i) =>
        this.startParticipant(run, collab, p, inputText, LIMITS_MAIN, controllers[i]?.signal),
      ),
    );

    const { index: winnerIndex, result: winner } = await this.firstToFinish(handles);

    // Stop the losers. Model calls abort at the socket; agent runs are
    // soft-cancelled (status=CANCELLED makes the next processStep tick
    // bail out), so only an LLM call already in flight on a loser runs on.
    handles.forEach((_, i) => {
      if (i !== winnerIndex) controllers[i]?.abort();
    });
    for (const h of handles) {
      if (!h.runId) continue;
      try {
        const currentRun = await this.runRepository.findOne({ where: { id: h.runId } });
        if (currentRun && !currentRun.isDone()) {
          currentRun.status = AgentRunStatus.CANCELLED;
          await this.runRepository.save(currentRun);
        }
      } catch (_) { /* best effort */ }
    }

    // CRITICAL: aggregate the cost of EVERY racer (winner and losers) into
    // the parent, or losers that already burned tokens are invisible to the
    // budget. Agent racers report through their run row; a model racer
    // counts if its call finished (an aborted call reports nothing).
    let raceTotalCost = 0;
    let raceTotalTokens = 0;
    for (const h of handles) {
      if (h.runId) {
        try {
          const finalRun = await this.runRepository.findOne({ where: { id: h.runId } });
          if (finalRun) {
            raceTotalCost += finalRun.totalCost || 0;
            raceTotalTokens += finalRun.totalTokens || 0;
          }
        } catch (_) { /* best effort */ }
      } else {
        const settled = await h.result.then((r) => r, () => null);
        if (settled) {
          raceTotalCost += settled.cost;
          raceTotalTokens += settled.tokens;
        }
      }
    }

    run.output = winner.output || 'No output from winning participant';
    run.status = AgentRunStatus.COMPLETED;
    run.totalCost += raceTotalCost;
    run.totalTokens += raceTotalTokens;

    const stepDuration = Date.now() - stepStart;
    run.steps.push({
      type: 'collaboration_race',
      input: { participantCount: collab.participants.length },
      output: {
        winner: describeParticipant(handles[winnerIndex].participant),
        winnerLabel: winner.label,
        outputPreview: String(run.output).substring(0, 200),
      },
      duration: stepDuration,
      timestamp: new Date().toISOString(),
    });
    return this.complete(run, stepDuration);
  }

  /**
   * Debate: rounds in which every participant sees the prior rounds, then a
   * judge summarizes (or the last round is returned).
   */
  async runDebateCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = asText(run.input);
    const maxRounds = collab.maxRounds || 3;

    const allResponses: Array<{ round: number; label: string; participant: Record<string, any>; output: string }> = [];

    // Each round, every debater sees ONLY responses from prior rounds (not
    // their peers' answers from the same round), so nobody gets the last
    // word advantage. All participants in a round run in parallel, each
    // starting from the same context.
    for (let round = 1; round <= maxRounds; round++) {
      if (await this.stopOnCostLimit(run, collab, `debate round ${round}`, stepStart)) return 'done';

      const priorRoundsContext = allResponses.length > 0
        ? 'Previous responses in this debate:\n\n' +
          allResponses
            .map(r => `[Round ${r.round} - ${r.label}]: ${r.output}`)
            .join('\n\n') +
          `\n\nThis is round ${round}. Please provide your response, taking into account the previous arguments.`
        : 'This is round 1 of a multi-participant debate. Please provide your initial response.';

      const debateInput = `Original question: "${inputText}"\n\n${priorRoundsContext}`;

      // Start every debater for this round in batches to avoid pool exhaustion,
      // then wait for all of them before recording.
      const handles = await batchAsync(collab.participants, 3, async (p) =>
        this.startParticipant(run, collab, p, debateInput, LIMITS_SHORT),
      );
      const results = await batchAsync(handles, 3, async (h) => h.result);

      results.forEach((result, i) => {
        allResponses.push({
          round,
          label: result.label,
          participant: describeParticipant(collab.participants[i]),
          output: result.output || 'No response',
        });
        run.totalCost += result.cost;
        run.totalTokens += result.tokens;
      });
    }

    let finalOutput: string;
    if (collab.judge) {
      const judgeInput = `A multi-participant debate was conducted on: "${inputText}"\n\n` +
        'Here are all responses from the debate:\n\n' +
        allResponses.map(r => `[Round ${r.round} - ${r.label}]: ${r.output}`).join('\n\n') +
        '\n\nPlease provide a final judgment synthesizing the best arguments.';

      if (await this.stopOnCostLimit(run, collab, 'the judge', stepStart)) return 'done';
      const judged = await this.runParticipant(run, collab, collab.judge, judgeInput, LIMITS_SHORT, 'judge');
      finalOutput = judged.output || 'Judge failed to produce output';
      run.totalCost += judged.cost;
      run.totalTokens += judged.tokens;
    } else {
      // No judge — return the last round's responses
      finalOutput = allResponses
        .filter(r => r.round === maxRounds)
        .map(r => `[${r.label}]: ${r.output}`)
        .join('\n\n');
    }

    run.output = finalOutput;
    run.status = AgentRunStatus.COMPLETED;

    const stepDuration = Date.now() - stepStart;
    run.steps.push({
      type: 'collaboration_debate',
      input: {
        participantCount: collab.participants.length,
        rounds: maxRounds,
        hasJudge: !!collab.judge,
        ...(collab.judge ? { judge: describeParticipant(collab.judge) } : {}),
      },
      output: { totalResponses: allResponses.length, outputPreview: String(finalOutput).substring(0, 200) },
      duration: stepDuration,
      timestamp: new Date().toISOString(),
    });
    return this.complete(run, stepDuration);
  }

  // ---------------------------------------------------------------------------
  // Participants
  // ---------------------------------------------------------------------------

  /** Run one participant to completion. */
  private async runParticipant(
    run: AgentRun,
    collab: AgentCollaboration,
    p: CollaborationParticipant,
    input: string,
    limits: ParticipantLimits,
    defaultRole?: string,
  ): Promise<ParticipantResult> {
    const handle = await this.startParticipant(run, collab, p, input, limits, undefined, defaultRole);
    return handle.result;
  }

  /**
   * Start one participant. An agent becomes a child run of `run` with the
   * given step/cost ceilings; a model is one chat call whose system message
   * carries the same collaboration context an agent participant's prompt does.
   */
  private async startParticipant(
    run: AgentRun,
    collab: AgentCollaboration,
    p: CollaborationParticipant,
    input: string,
    limits: ParticipantLimits,
    signal?: AbortSignal,
    defaultRole?: string,
  ): Promise<ParticipantHandle> {
    const label = participantLabel(p);

    if (p.kind === 'agent') {
      const subRun = await this.runtime.startRun(
        p.agentId,
        run.organizationId,
        run.userId,
        input,
        // A participant runs in the orchestrating run's scope, unchanged.
        { parentRunId: run.id, maxSteps: limits.maxSteps, maxCostCents: limits.maxCostCents, principal: principalOfRun(run) },
      );
      const result = this.runtime.waitForRun(subRun.id, limits.timeoutMs).then((r) => ({
        output: r?.output ? asText(r.output) : 'No output',
        cost: r?.totalCost || 0,
        tokens: r?.totalTokens || 0,
        label,
      }));
      return { participant: p, label, runId: subRun.id, result };
    }

    const result = this.callModel(run, collab, p, input, limits.timeoutMs, signal, defaultRole).then((response) => ({
      output: response?.message?.content || 'No output',
      cost: response?.cost || 0,
      tokens: response?.usage?.totalTokens || 0,
      label,
    }));
    // A racer that is aborted rejects; mark it handled here so it is not
    // reported as unhandled before the race gets to settle it.
    result.catch(() => undefined);
    return { participant: p, label, result };
  }

  private async callModel(
    run: AgentRun,
    collab: AgentCollaboration,
    p: Extract<CollaborationParticipant, { kind: 'model' }>,
    input: string,
    timeoutMs: number,
    signal?: AbortSignal,
    defaultRole?: string,
  ) {
    const system: string[] = [];
    const context = buildCollaborationContext(collab, p.role || defaultRole);
    if (context.length) system.push(`[COLLABORATION CONTEXT]\n${context.join('\n')}`);
    if (p.instructions) system.push(`[INSTRUCTIONS]\n${p.instructions}`);
    if (collab.rules?.outputFormat === 'json') {
      system.push('[OUTPUT FORMAT]\nRespond with a single valid JSON value only: no prose, no code fences.');
    }

    // Abort on the caller's signal (a lost race) or on the timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.runtime.llmProvidersService.chat(
        p.providerId ?? null,
        {
          messages: [
            ...(system.length ? [{ role: 'system' as any, content: system.join('\n\n') }] : []),
            { role: 'user' as any, content: input },
          ],
          model: p.routing ? undefined : p.model,
          ...(p.routing ? { routing: p.routing } : {}),
          temperature: p.temperature,
          maxTokens: p.maxTokens,
          signal: controller.signal,
        },
        run.organizationId,
        principalOfRun(run),
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The first participant to finish. A model racer that errors (or is
   * aborted) does not win; if every racer fails, the first error is thrown.
   */
  private firstToFinish(handles: ParticipantHandle[]): Promise<{ index: number; result: ParticipantResult }> {
    return new Promise((resolve, reject) => {
      let failures = 0;
      let firstError: unknown;
      if (handles.length === 0) {
        reject(new Error('Race has no participants'));
        return;
      }
      handles.forEach((h, index) => {
        h.result.then(
          (result) => resolve({ index, result }),
          (error) => {
            failures++;
            firstError = firstError ?? error;
            if (failures === handles.length) reject(firstError);
          },
        );
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Rules of engagement
  // ---------------------------------------------------------------------------

  /**
   * `rules.maxTotalCost`: once the collaboration has spent its budget, the
   * next participant does not start. Records the stop and fails the run.
   */
  private async stopOnCostLimit(
    run: AgentRun,
    collab: AgentCollaboration,
    next: string,
    stepStart: number,
  ): Promise<boolean> {
    const limit = collab.rules?.maxTotalCost;
    if (!limit || (run.totalCost || 0) < limit) return false;

    const error =
      `Collaboration total cost limit reached ($${(run.totalCost || 0).toFixed(2)} >= $${limit}); ` +
      `stopped before ${next}`;
    const stepDuration = Date.now() - stepStart;
    run.steps.push({
      type: 'collaboration_cost_limit',
      error,
      input: { strategy: collab.strategy, next },
      output: { totalCost: run.totalCost, maxTotalCost: limit },
      duration: stepDuration,
      timestamp: new Date().toISOString(),
    });
    run.status = AgentRunStatus.FAILED;
    run.error = error;
    run.executionTime += stepDuration;
    await this.runRepository.save(run);
    this.runtime.emitEvent(run.id, 'run.failed', { error });
    return true;
  }

  private async complete(run: AgentRun, stepDuration: number): Promise<'done'> {
    run.currentStep++;
    run.executionTime += stepDuration;
    await this.runRepository.save(run);
    this.runtime.emitEvent(run.id, 'run.completed', { output: run.output });
    return 'done';
  }
}