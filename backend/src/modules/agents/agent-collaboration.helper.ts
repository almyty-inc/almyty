import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { Agent } from '../../entities/agent.entity';
import { batchAsync } from '../../common/utils/batch-async';
import { AgentRuntimeService } from './agent-runtime.service';

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
   * Sequential: run agents one after another, each receiving the previous agent's output as input.
   */
  async runSequentialCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = typeof run.input === 'string' ? run.input : JSON.stringify(run.input);
    const agentOutputs: Array<{ agentId: string; role?: string; output: any }> = [];

    // Step 1: Run the orchestrator agent itself first (its own ReAct loop with tools)
    // The child run has parentRunId set, so it won't re-enter collaboration
    const orchestratorRun = await this.runtime.startRun(
      agent.id,
      run.organizationId,
      run.userId,
      inputText,
      { parentRunId: run.id, maxSteps: 20, maxCostCents: 50 },
    );
    const orchestratorResult = await this.runtime.waitForRun(orchestratorRun.id, 300000);

    let currentInput = orchestratorResult?.output
      ? (typeof orchestratorResult.output === 'string' ? orchestratorResult.output : JSON.stringify(orchestratorResult.output))
      : inputText;
    agentOutputs.push({ agentId: agent.id, role: 'orchestrator', output: currentInput });
    run.totalCost += orchestratorResult?.totalCost || 0;
    run.totalTokens += orchestratorResult?.totalTokens || 0;

    // Step 2: Run each collaborator agent in sequence, piping output → input
    for (const agentDef of collab.agents) {
      const subRun = await this.runtime.startRun(
        agentDef.agentId,
        run.organizationId,
        run.userId,
        currentInput,
        { parentRunId: run.id, maxSteps: 20, maxCostCents: 50 },
      );

      const result = await this.runtime.waitForRun(subRun.id, 300000);
      const output = result?.output || 'No output';
      agentOutputs.push({ agentId: agentDef.agentId, role: agentDef.role, output });

      run.totalCost += result?.totalCost || 0;
      run.totalTokens += result?.totalTokens || 0;

      currentInput = typeof output === 'string' ? output : JSON.stringify(output);
    }

    // The final agent's output is the orchestrator's output
    const finalOutput = agentOutputs[agentOutputs.length - 1]?.output || 'No output';
    run.output = finalOutput;
    run.status = AgentRunStatus.COMPLETED;

    const stepDuration = Date.now() - stepStart;
    run.steps.push({
      type: 'collaboration_sequential',
      input: { agentCount: collab.agents.length },
      output: { agentOutputs: agentOutputs.map(ao => ({ agentId: ao.agentId, role: ao.role, outputPreview: String(ao.output).substring(0, 200) })) },
      duration: stepDuration,
      timestamp: new Date().toISOString(),
    });
    run.currentStep++;
    run.executionTime += stepDuration;
    await this.runRepository.save(run);
    this.runtime.emitEvent(run.id, 'run.completed', { output: run.output });
    return 'done';
  }

  /**
   * Parallel: run all agents simultaneously, wait for all to complete, merge outputs.
   */
  async runParallelCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = typeof run.input === 'string' ? run.input : JSON.stringify(run.input);

    // Start all sub-runs simultaneously
    const subRunPromises = collab.agents.map(agentDef =>
      this.runtime.startRun(
        agentDef.agentId,
        run.organizationId,
        run.userId,
        inputText,
        { parentRunId: run.id, maxSteps: 20, maxCostCents: 50 },
      ),
    );

    const subRuns = await Promise.all(subRunPromises);

    // Wait for all to complete
    const results = await Promise.all(
      subRuns.map(sr => this.runtime.waitForRun(sr.id, 300000)),
    );

    const agentOutputs = results.map((result, i) => ({
      agentId: collab.agents[i].agentId,
      role: collab.agents[i].role,
      output: result?.output || 'No output',
      cost: result?.totalCost || 0,
      tokens: result?.totalTokens || 0,
    }));

    // Aggregate costs
    for (const ao of agentOutputs) {
      run.totalCost += ao.cost;
      run.totalTokens += ao.tokens;
    }

    // Merge outputs: if there's a judge, use it; otherwise concatenate
    let finalOutput: any;
    if (collab.judgeAgentId) {
      const judgeInput = `Multiple agents were asked: "${inputText}"\n\nTheir responses:\n\n` +
        agentOutputs.map((ao, i) => `### Agent ${i + 1}${ao.role ? ` (${ao.role})` : ''}:\n${ao.output}`).join('\n\n') +
        '\n\nPlease synthesize the best answer from these responses.';

      const judgeRun = await this.runtime.startRun(
        collab.judgeAgentId,
        run.organizationId,
        run.userId,
        judgeInput,
        { parentRunId: run.id, maxSteps: 10, maxCostCents: 25 },
      );
      const judgeResult = await this.runtime.waitForRun(judgeRun.id, 120000);
      finalOutput = judgeResult?.output || 'Judge failed to produce output';
      run.totalCost += judgeResult?.totalCost || 0;
      run.totalTokens += judgeResult?.totalTokens || 0;
    } else {
      finalOutput = agentOutputs.map((ao, i) =>
        `[Agent ${i + 1}${ao.role ? ` - ${ao.role}` : ''}]: ${ao.output}`,
      ).join('\n\n');
    }

    run.output = finalOutput;
    run.status = AgentRunStatus.COMPLETED;

    const stepDuration = Date.now() - stepStart;
    run.steps.push({
      type: 'collaboration_parallel',
      input: { agentCount: collab.agents.length, hasJudge: !!collab.judgeAgentId },
      output: { agentOutputs: agentOutputs.map(ao => ({ agentId: ao.agentId, role: ao.role, outputPreview: String(ao.output).substring(0, 200) })) },
      duration: stepDuration,
      timestamp: new Date().toISOString(),
    });
    run.currentStep++;
    run.executionTime += stepDuration;
    await this.runRepository.save(run);
    this.runtime.emitEvent(run.id, 'run.completed', { output: run.output });
    return 'done';
  }

  /**
   * Race: run all agents, take the first one to complete, cancel the rest.
   */
  async runRaceCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = typeof run.input === 'string' ? run.input : JSON.stringify(run.input);

    // Start all sub-runs simultaneously
    const subRuns = await Promise.all(
      collab.agents.map(agentDef =>
        this.runtime.startRun(
          agentDef.agentId,
          run.organizationId,
          run.userId,
          inputText,
          { parentRunId: run.id, maxSteps: 20, maxCostCents: 50 },
        ),
      ),
    );

    // Race: wait for the first to complete
    const winnerResult = await Promise.race(
      subRuns.map(sr => this.runtime.waitForRun(sr.id, 300000)),
    );

    // Cancel the rest. Soft-cancel only: setting status=CANCELLED makes
    // the next processStep tick bail out early (it checks isDone()), so
    // damage is limited to whatever LLM call is currently in flight on
    // each loser. Cancelling an in-flight HTTP request would require
    // AbortSignal plumbing through llm-providers and is out of scope.
    for (const sr of subRuns) {
      try {
        const currentRun = await this.runRepository.findOne({ where: { id: sr.id } });
        if (currentRun && !currentRun.isDone()) {
          currentRun.status = AgentRunStatus.CANCELLED;
          await this.runRepository.save(currentRun);
        }
      } catch (_) { /* best effort */ }
    }

    // CRITICAL: aggregate the cost of EVERY racer (winner and losers)
    // into the parent. The previous version only added the winner's
    // cost — losing runs that already burned LLM tokens before being
    // cancelled were invisible to the parent's budget accounting,
    // letting maxCostCents be silently bypassed by N× the racer count.
    let raceTotalCost = 0;
    let raceTotalTokens = 0;
    for (const sr of subRuns) {
      try {
        const finalRun = await this.runRepository.findOne({ where: { id: sr.id } });
        if (finalRun) {
          raceTotalCost += finalRun.totalCost || 0;
          raceTotalTokens += finalRun.totalTokens || 0;
        }
      } catch (_) { /* best effort */ }
    }

    run.output = winnerResult?.output || 'No output from winning agent';
    run.status = AgentRunStatus.COMPLETED;
    run.totalCost += raceTotalCost;
    run.totalTokens += raceTotalTokens;

    const stepDuration = Date.now() - stepStart;
    run.steps.push({
      type: 'collaboration_race',
      input: { agentCount: collab.agents.length },
      output: { winnerId: winnerResult?.agentId, outputPreview: String(run.output).substring(0, 200) },
      duration: stepDuration,
      timestamp: new Date().toISOString(),
    });
    run.currentStep++;
    run.executionTime += stepDuration;
    await this.runRepository.save(run);
    this.runtime.emitEvent(run.id, 'run.completed', { output: run.output });
    return 'done';
  }

  /**
   * Debate: run rounds where each agent sees previous responses, then a judge summarizes.
   */
  async runDebateCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = typeof run.input === 'string' ? run.input : JSON.stringify(run.input);
    const maxRounds = collab.maxRounds || 3;

    const allResponses: Array<{ round: number; agentId: string; role?: string; output: string }> = [];

    // Each round, every debater sees ONLY responses from prior rounds (not
    // their peers' answers from the same round). Previously the agents ran
    // sequentially within a round and later agents saw earlier ones'
    // responses, which gave the last agent in each round an unfair info
    // advantage. Now all agents in a round run in parallel, each starting
    // from the same context (the prior rounds).
    for (let round = 1; round <= maxRounds; round++) {
      const priorRoundsContext = allResponses.length > 0
        ? 'Previous responses in this debate:\n\n' +
          allResponses
            .map(r => `[Round ${r.round}${r.role ? ` - ${r.role}` : ''}]: ${r.output}`)
            .join('\n\n') +
          `\n\nThis is round ${round}. Please provide your response, taking into account the previous arguments.`
        : 'This is round 1 of a multi-agent debate. Please provide your initial response.';

      const debateInput = `Original question: "${inputText}"\n\n${priorRoundsContext}`;

      // Start every debater for this round in batches to avoid pool exhaustion.
      const subRuns = await batchAsync(collab.agents, 3, async (agentDef) =>
        this.runtime.startRun(
          agentDef.agentId,
          run.organizationId,
          run.userId,
          debateInput,
          { parentRunId: run.id, maxSteps: 10, maxCostCents: 25 },
        ),
      );

      // Wait for all of this round's debaters to finish before recording.
      const results = await batchAsync(subRuns, 3, async (sr) => this.runtime.waitForRun(sr.id, 120000));

      results.forEach((result, i) => {
        const agentDef = collab.agents[i];
        const output = result?.output || 'No response';
        allResponses.push({
          round,
          agentId: agentDef.agentId,
          role: agentDef.role,
          output: String(output),
        });
        run.totalCost += result?.totalCost || 0;
        run.totalTokens += result?.totalTokens || 0;
      });
    }

    // Judge summarizes the debate
    let finalOutput: any;
    if (collab.judgeAgentId) {
      const judgeInput = `A multi-agent debate was conducted on: "${inputText}"\n\n` +
        'Here are all responses from the debate:\n\n' +
        allResponses.map(r =>
          `[Round ${r.round}${r.role ? ` - ${r.role}` : ''}]: ${r.output}`,
        ).join('\n\n') +
        '\n\nPlease provide a final judgment synthesizing the best arguments.';

      const judgeRun = await this.runtime.startRun(
        collab.judgeAgentId,
        run.organizationId,
        run.userId,
        judgeInput,
        { parentRunId: run.id, maxSteps: 10, maxCostCents: 25 },
      );
      const judgeResult = await this.runtime.waitForRun(judgeRun.id, 120000);
      finalOutput = judgeResult?.output || 'Judge failed to produce output';
      run.totalCost += judgeResult?.totalCost || 0;
      run.totalTokens += judgeResult?.totalTokens || 0;
    } else {
      // No judge — return the last round's responses
      const lastRound = allResponses.filter(r => r.round === maxRounds);
      finalOutput = lastRound.map(r =>
        `[${r.role || r.agentId}]: ${r.output}`,
      ).join('\n\n');
    }

    run.output = finalOutput;
    run.status = AgentRunStatus.COMPLETED;

    const stepDuration = Date.now() - stepStart;
    run.steps.push({
      type: 'collaboration_debate',
      input: { agentCount: collab.agents.length, rounds: maxRounds, hasJudge: !!collab.judgeAgentId },
      output: { totalResponses: allResponses.length, outputPreview: String(finalOutput).substring(0, 200) },
      duration: stepDuration,
      timestamp: new Date().toISOString(),
    });
    run.currentStep++;
    run.executionTime += stepDuration;
    await this.runRepository.save(run);
    this.runtime.emitEvent(run.id, 'run.completed', { output: run.output });
    return 'done';
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Build messages array for LLM call
   */
  /**
   * Wait for a run to complete (polling).
   */
}
