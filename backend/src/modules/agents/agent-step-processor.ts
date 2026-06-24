import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { In } from 'typeorm';

import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { ConversationStatus } from '../../entities/conversation.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message, MessageRole } from '../../entities/message.entity';
import { batchAsync } from '../../common/utils/batch-async';
import { AgentRuntimeService } from './agent-runtime.service';
import { ChatRequest, ChatResponse } from '../llm-providers/llm-providers.service';
import { ToolExecutionOptions, ToolExecutionResult } from '../tools/tool-executor.service';
import { Agent } from '../../entities/agent.entity';
import { AgentVerifierHelper, VerifyPanelResult } from './agent-verifier.helper';
import { AgentContextCompactor } from './agent-context-compactor.helper';
/**
 * `processStep` was the bulk of AgentRuntimeService — a single 500-line
 * method orchestrating the autonomous-agent inner loop. Splitting it
 * into its own class keeps the runtime service focused on
 * lifecycle / public API.
 *
 * The processor holds a `forwardRef` to AgentRuntimeService so it can
 * reach the same repos and helpers without re-injecting them. All
 * other state (run rows, conversations, messages) is read from the
 * database fresh on every step — there is no per-instance state on
 * this class.
 */
@Injectable()
export class AgentStepProcessor {
  constructor(
    @Inject(forwardRef(() => AgentRuntimeService))
    private readonly s: AgentRuntimeService,
    private readonly verifier: AgentVerifierHelper,
    private readonly compactor: AgentContextCompactor,
  ) {}

  async processStep(runId: string): Promise<'continue' | 'done' | 'waiting'> {
    const run = await this.s.runRepository.findOne({ where: { id: runId }, relations: ['agent'] });
    if (!run) {
      this.s.logger.warn(`Run ${runId} not found, skipping`);
      return 'done';
    }

    // Check if run is still active
    if (run.isDone()) {
      this.s.logger.debug(`Run ${runId} already done (${run.status}), skipping`);
      return 'done';
    }

    // Optimistic-lock token: the step number we believe we're processing.
    // Every step-completing write is guarded on this via commitStep(), so a
    // duplicate/concurrent processing of the same step can't double-count
    // cost or steps — the loser's UPDATE matches 0 rows and it aborts.
    const expectedStep = run.currentStep;

    // Enforce limits
    const limitCheck = this.s.misc.checkLimits(run);
    if (limitCheck) {
      run.status = AgentRunStatus.FAILED;
      run.error = limitCheck;
      await this.s.runRepository.save(run);
      this.s.emitEvent(runId, 'run.failed', { error: limitCheck });
      return 'done';
    }

    const stepStart = Date.now();
    const agent = run.agent;

    // Enforce collaboration rules.maxTotalCost across sibling runs
    if (run.parentRunId && agent.collaboration?.rules?.maxTotalCost) {
      const siblingRuns = await this.s.runRepository.find({ where: { parentRunId: run.parentRunId } });
      const totalSiblingCost = siblingRuns.reduce((sum, sr) => sum + (sr.totalCost || 0), 0);
      if (totalSiblingCost >= agent.collaboration.rules.maxTotalCost) {
        run.status = AgentRunStatus.FAILED;
        run.error = `Collaboration total cost limit exceeded ($${totalSiblingCost.toFixed(2)} >= $${agent.collaboration.rules.maxTotalCost})`;
        await this.s.runRepository.save(run);
        this.s.emitEvent(runId, 'run.failed', { error: run.error });
        return 'done';
      }
    }

    // If this is a collaboration orchestrator (and NOT a child run), delegate to collaboration handler
    if (agent.collaboration?.strategy && agent.collaboration.agents?.length > 0 && !run.parentRunId) {
      return this.s.collaboration.processCollaborationStep(run, agent);
    }

    try {
      // Load agent's tools from DB
      const tools = agent.toolIds?.length
        ? await this.s.toolRepository.find({ where: { id: In(agent.toolIds) } })
        : [];

      // Recall memories if memory is enabled
      let memoryContext = '';
      if (agent.memoryConfig?.enabled) {
        try {
          const recentMessages = run.conversationId
            ? await this.s.messageRepository.find({ where: { conversationId: run.conversationId, role: MessageRole.USER as any }, order: { createdAt: 'DESC' }, take: 1 })
            : [];
          const lastUserMessage = recentMessages[0];
          if (lastUserMessage) {
            // Canonical search: workspace-scoped, hybrid (vector + FTS).
            // Tier filter is omitted on read so the agent sees memories
            // it stored in any tier (short/project/long/shared).
            const ranked = await this.s.memoryService.search({
              scope: { scope_type: 'workspace', scope_id: run.organizationId },
              query: typeof lastUserMessage.content === 'string'
                ? lastUserMessage.content
                : JSON.stringify(lastUserMessage.content),
              mode: 'memory',
              top_k: 5,
            });
            if (ranked.length > 0) {
              memoryContext = '\n\n## Relevant Memories\n' +
                ranked.map(r => `- [${r.item.tier ?? 'memory'}] ${r.item.content}`).join('\n');
            }
          }
        } catch (err) {
          this.s.logger.warn(`Failed to recall memories for run ${runId}: ${err.message}`);
        }
      }

      // Load organization defaults for system prompt
      const org = await this.s.organizationRepository.findOne({ where: { id: run.organizationId } });

      // Build messages for the LLM
      let messages = await this.s.builders.buildMessages(agent, run, tools, memoryContext, org);

      // Compact long-running context (off unless the agent opts in). Folds the
      // old prefix into a summary so per-step token cost doesn't grow unbounded.
      const compaction = agent.modelConfig?.compaction;
      if (compaction?.enabled) {
        const compacted = await this.compactor.compact(
          messages,
          run,
          { ...compaction, providerId: compaction.providerId ?? agent.modelConfig?.providerId },
          run.organizationId,
          run.userId,
        );
        messages = compacted.messages;
        run.totalCost += compacted.cost;
        run.totalTokens += compacted.tokens;
      }

      // Build tool definitions for the LLM (user tools + built-in tools)
      const llmTools = this.s.builders.buildToolDefinitions(tools, agent);

      // Resolve sub-agent tools (only if canCallAgents is enabled)
      let subAgentDefs: Array<{ name: string; description: string; parameters: Record<string, any> }> = [];
      const subAgentMap = new Map<string, string>();
      if (agent.agentConfig?.canCallAgents) {
        const otherAgents = await this.s.agentRepository.find({
          where: { organizationId: run.organizationId, status: 'active' as any, isTemporary: false },
          select: ['id', 'name', 'description'],
        });
        subAgentDefs = otherAgents
          .filter(a => a.id !== agent.id)
          .map(a => ({
            name: `call_agent_${a.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
            description: `Call sub-agent "${a.name}": ${a.description || 'No description'}`,
            parameters: {
              type: 'object',
              properties: {
                input: { type: 'string', description: 'The input/message to send to this agent' },
              },
              required: ['input'],
            },
          }));
        for (const a of otherAgents.filter(a => a.id !== agent.id)) {
          subAgentMap.set(`call_agent_${a.name.replace(/[^a-zA-Z0-9_]/g, '_')}`, a.id);
        }
      }

      const allToolDefs = [...llmTools, ...subAgentDefs];

      // Determine the LLM provider
      const providerId = agent.modelConfig?.providerId;
      if (!providerId) {
        throw new Error('Agent has no LLM provider configured (modelConfig.providerId is missing)');
      }

      // Build the chat request
      const chatRequest: ChatRequest = {
        messages: messages as any[],
        model: agent.modelConfig?.model,
        temperature: agent.modelConfig?.temperature,
        maxTokens: agent.modelConfig?.maxTokens,
        tools: allToolDefs.length > 0 ? allToolDefs : undefined,
        skipToolExecution: true, // We handle tool execution ourselves
      };

      // Call the LLM
      this.s.logger.debug(`Run ${runId} step ${run.currentStep}: calling LLM with ${messages.length} messages, ${allToolDefs.length} tools`);

      this.s.emitEvent(runId, 'llm.started', { step: run.currentStep });

      const llmResponse: ChatResponse = await this.s.llmProvidersService.chatStream(
        providerId,
        chatRequest,
        run.organizationId,
        run.userId,
        (chunk) => {
          if (chunk.content) {
            this.s.emitEvent(runId, 'llm.chunk', { step: run.currentStep, content: chunk.content });
          }
        },
      );

      // Track cost and tokens
      const stepCost = llmResponse.cost || 0;
      const stepInputTokens = llmResponse.usage?.inputTokens || 0;
      const stepOutputTokens = llmResponse.usage?.outputTokens || 0;
      const stepTotalTokens = llmResponse.usage?.totalTokens || (stepInputTokens + stepOutputTokens);

      run.totalCost += stepCost;
      run.totalTokens += stepTotalTokens;

      const responseMessage = llmResponse.message;

      this.s.emitEvent(runId, 'llm.response', {
        step: run.currentStep,
        content: responseMessage.content,
        toolCalls: responseMessage.toolCalls?.map(tc => ({ id: tc.id, name: tc.name })),
        usage: { inputTokens: stepInputTokens, outputTokens: stepOutputTokens },
        cost: stepCost,
      });

      // Check if the LLM returned tool calls
      if (responseMessage.toolCalls && responseMessage.toolCalls.length > 0) {
        // Persist assistant message with tool calls
        if (run.conversationId) {
          const assistantMsg = Message.createToolCallMessage(run.conversationId, responseMessage.toolCalls);
          assistantMsg.content = responseMessage.content || '';
          assistantMsg.runId = run.id;
          await this.s.messageRepository.save(assistantMsg);
        }

        // Execute each tool call
        for (const toolCall of responseMessage.toolCalls) {
          const toolExecStart = Date.now();

          // Check for built-in tools first
          this.s.emitEvent(runId, 'tool.started', { step: run.currentStep, toolCallId: toolCall.id, tool: toolCall.name });

          const builtInResult = await this.s.builtInTools.executeBuiltInTool(toolCall.name, toolCall.parameters || {}, run, agent);
          if (builtInResult) {
            // Built-in tool was handled
            toolCall.result = builtInResult.result;
            toolCall.error = builtInResult.error;
            toolCall.executionTime = Date.now() - toolExecStart;

            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: toolCall.name,
              success: !builtInResult.error,
              executionTime: toolCall.executionTime,
            });

            // Persist tool result message
            if (run.conversationId) {
              const toolResultContent = builtInResult.error || (typeof builtInResult.result === 'string' ? builtInResult.result : JSON.stringify(builtInResult.result));
              const toolMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, toolResultContent, builtInResult.error);
              toolMsg.runId = run.id;
              await this.s.messageRepository.save(toolMsg);
            }

            // Record tool call step
            run.steps.push({
              type: 'tool_call',
              input: { tool: toolCall.name, parameters: toolCall.parameters },
              output: builtInResult.result,
              duration: Date.now() - toolExecStart,
              timestamp: new Date().toISOString(),
              error: builtInResult.error,
            });

            // Handle special statuses from built-in tools
            if (builtInResult.status === 'sleeping') {
              // wait tool: save and return waiting, the job is re-enqueued with delay
              const stepDuration = Date.now() - stepStart;
              run.steps.push({
                type: 'llm_call',
                input: { messageCount: messages.length, toolCount: allToolDefs.length },
                output: { status: 'sleeping', reason: toolCall.parameters?.reason },
                cost: stepCost,
                tokens: { input: stepInputTokens, output: stepOutputTokens },
                duration: stepDuration,
                timestamp: new Date().toISOString(),
              });
              run.currentStep++;
              run.executionTime += stepDuration;
              if (!(await this.commitStep(run, expectedStep))) return 'done';
              this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'sleeping' });
              return 'waiting';
            }

            if (builtInResult.status === 'waiting_input') {
              const stepDuration = Date.now() - stepStart;
              run.steps.push({
                type: 'llm_call',
                input: { messageCount: messages.length, toolCount: allToolDefs.length },
                output: { status: 'waiting_input', question: toolCall.parameters?.question },
                cost: stepCost,
                tokens: { input: stepInputTokens, output: stepOutputTokens },
                duration: stepDuration,
                timestamp: new Date().toISOString(),
              });
              run.currentStep++;
              run.executionTime += stepDuration;
              if (!(await this.commitStep(run, expectedStep))) return 'done';
              this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'waiting_input' });
              return 'waiting';
            }

            continue;
          }

          // Check for sub-agent calls
          const subAgentId = subAgentMap.get(toolCall.name);
          if (subAgentId) {
            // tool.started was already emitted above (before built-in check)
            try {
              const subRun = await this.s.startRun(
                subAgentId,
                run.organizationId,
                run.userId,
                toolCall.parameters?.input || '',
                { parentRunId: run.id, maxSteps: 20, maxCostCents: 50 },
              );
              // Wait for the sub-run to complete (poll with timeout)
              const subResult = await this.s.misc.waitForRun(subRun.id, 120000);
              toolCall.result = subResult?.output || 'Sub-agent completed without output';
              toolCall.error = subResult?.error;
              toolCall.executionTime = Date.now() - toolExecStart;
            } catch (err) {
              toolCall.error = `Sub-agent call failed: ${err.message}`;
              toolCall.executionTime = Date.now() - toolExecStart;
            }

            // Persist sub-agent tool result
            if (run.conversationId) {
              const subContent = toolCall.error || (typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result));
              const subMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, subContent, toolCall.error);
              subMsg.runId = run.id;
              await this.s.messageRepository.save(subMsg);
            }

            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: toolCall.name,
              success: !toolCall.error,
              executionTime: toolCall.executionTime,
            });

            run.steps.push({
              type: 'sub_agent_call',
              input: { agentId: subAgentId, input: toolCall.parameters?.input },
              output: toolCall.result,
              duration: Date.now() - toolExecStart,
              timestamp: new Date().toISOString(),
              error: toolCall.error,
            });

            continue;
          }

          // Regular tool execution via ToolExecutorService
          const matchingTool = tools.find(
            t => t.name.replace(/[^a-zA-Z0-9_-]/g, '_') === toolCall.name || t.name === toolCall.name,
          );

          if (!matchingTool) {
            toolCall.error = `Tool '${toolCall.name}' not found`;
            toolCall.executionTime = Date.now() - toolExecStart;

            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: toolCall.name,
              success: false,
              executionTime: toolCall.executionTime,
            });

            if (run.conversationId) {
              const errMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, `Error: Tool '${toolCall.name}' not found`, toolCall.error);
              errMsg.runId = run.id;
              await this.s.messageRepository.save(errMsg);
            }

            run.steps.push({
              type: 'tool_call',
              input: { tool: toolCall.name, parameters: toolCall.parameters },
              error: toolCall.error,
              duration: Date.now() - toolExecStart,
              timestamp: new Date().toISOString(),
            });

            continue;
          }

          try {
            const execOptions: ToolExecutionOptions = {
              userId: run.userId || 'system',
              organizationId: run.organizationId,
            };

            const toolResult: ToolExecutionResult = await this.s.toolExecutorService.executeTool(
              matchingTool.id,
              toolCall.parameters || {},
              execOptions,
            );

            toolCall.result = toolResult.data;
            toolCall.error = toolResult.success ? undefined : toolResult.error;
            toolCall.executionTime = toolResult.executionTime;
            toolCall.cached = toolResult.cached;

            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: matchingTool.name,
              success: toolResult.success,
              executionTime: toolResult.executionTime,
            });

            if (run.conversationId) {
              const toolContent = toolResult.success
                ? (typeof toolResult.data === 'string' ? toolResult.data : JSON.stringify(toolResult.data))
                : `Error: ${toolResult.error}`;
              const toolMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, toolContent, toolResult.success ? undefined : toolResult.error);
              toolMsg.runId = run.id;
              await this.s.messageRepository.save(toolMsg);
            }

            run.steps.push({
              type: 'tool_call',
              input: { tool: matchingTool.name, toolId: matchingTool.id, parameters: toolCall.parameters },
              output: toolResult.data,
              cost: toolResult.metadata?.cost || 0,
              duration: toolResult.executionTime,
              timestamp: new Date().toISOString(),
              error: toolResult.success ? undefined : toolResult.error,
            });
          } catch (err) {
            toolCall.error = err.message;
            toolCall.executionTime = Date.now() - toolExecStart;

            this.s.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: matchingTool.name,
              success: false,
              executionTime: toolCall.executionTime,
            });

            if (run.conversationId) {
              const errMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, `Error executing tool: ${err.message}`, err.message);
              errMsg.runId = run.id;
              await this.s.messageRepository.save(errMsg);
            }

            run.steps.push({
              type: 'tool_call',
              input: { tool: matchingTool.name, toolId: matchingTool.id, parameters: toolCall.parameters },
              error: err.message,
              duration: Date.now() - toolExecStart,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Record the LLM call step
        const stepDuration = Date.now() - stepStart;
        run.steps.push({
          type: 'llm_call',
          input: { messageCount: messages.length, toolCount: allToolDefs.length },
          output: { toolCalls: responseMessage.toolCalls.map(tc => ({ name: tc.name, hasResult: !!tc.result })) },
          cost: stepCost,
          tokens: { input: stepInputTokens, output: stepOutputTokens },
          duration: stepDuration,
          timestamp: new Date().toISOString(),
        });

        run.currentStep++;
        run.executionTime += stepDuration;

        // Advisory mid-run verification (every_n_steps / on_tool_result). May
        // append a course-correction message + verify step before we commit.
        await this.maybeMidLoopVerify(run, agent, responseMessage, runId);
        if (!(await this.commitStep(run, expectedStep))) return 'done';

        // Auto-save memory if enabled
        if (agent.memoryConfig?.autoSave) {
          await this.s.misc.autoSaveMemory(run, agent);
        }

        this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, total: run.maxSteps });
        return 'continue';

      } else {
        // No tool calls — the agent has a final response
        const finalContent = responseMessage.content || '';

        // Persist final assistant message
        if (run.conversationId) {
          const finalMsg = Message.createAssistantMessage(run.conversationId, finalContent);
          finalMsg.runId = run.id;
          await this.s.messageRepository.save(finalMsg);
        }

        // Autonomous verify gate: a refute-only checker panel reviews the
        // final answer. On failure within the revision budget, the failures
        // are fed back as synthetic user feedback and the agent loops again
        // instead of completing.
        const verifyPanel = await this.runAutonomousVerify(run, agent, finalContent);
        if (verifyPanel) {
          const cfg = agent.agentConfig?.verify;
          const maxLoops = cfg?.maxReviseLoops ?? 2;
          const revisions = run.workingMemory?.verifyRevisions ?? 0;
          const verifyStepDuration = Date.now() - stepStart;

          if (!verifyPanel.passed && revisions < maxLoops) {
            // Send the answer back for revision.
            run.workingMemory = { ...(run.workingMemory || {}), verifyRevisions: revisions + 1 };
            const critique = this.verifier.formatFailuresForRevision(
              verifyPanel.failures,
              revisions + 1,
              maxLoops,
            );
            if (run.conversationId) {
              const critiqueMsg = Message.createUserMessage(run.conversationId, critique);
              critiqueMsg.runId = run.id;
              await this.s.messageRepository.save(critiqueMsg);
            }
            run.steps.push({
              type: 'llm_call',
              input: { messageCount: messages.length, toolCount: allToolDefs.length },
              output: { status: 'revising', content: finalContent.substring(0, 200) },
              cost: stepCost,
              tokens: { input: stepInputTokens, output: stepOutputTokens },
              duration: verifyStepDuration,
              timestamp: new Date().toISOString(),
            });
            run.steps.push({
              type: 'verify',
              input: { policy: verifyPanel.policy, checkers: verifyPanel.checkers.length },
              output: { verdict: 'fail', revision: revisions + 1, failures: verifyPanel.failures },
              cost: verifyPanel.cost,
              duration: verifyStepDuration,
              timestamp: new Date().toISOString(),
            });
            run.currentStep++;
            run.executionTime += verifyStepDuration;
            if (!(await this.commitStep(run, expectedStep))) return 'done';
            this.s.emitEvent(runId, 'verify.failed', {
              step: run.currentStep,
              revision: revisions + 1,
              failures: verifyPanel.failures,
            });
            this.s.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'revising' });
            return 'continue';
          }

          // Passed, or the revision budget is exhausted: record the verdict and
          // let the run complete with this answer.
          run.steps.push({
            type: 'verify',
            input: { policy: verifyPanel.policy, checkers: verifyPanel.checkers.length },
            output: {
              verdict: verifyPanel.verdict,
              exhausted: !verifyPanel.passed && revisions >= maxLoops,
              failures: verifyPanel.failures,
            },
            cost: verifyPanel.cost,
            duration: verifyStepDuration,
            timestamp: new Date().toISOString(),
          });
          run.metadata = {
            ...(run.metadata || {}),
            verify: {
              verdict: verifyPanel.verdict,
              revisions,
              exhausted: !verifyPanel.passed && revisions >= maxLoops,
            },
          };
        }

        run.status = AgentRunStatus.COMPLETED;
        run.output = finalContent;

        const stepDuration = Date.now() - stepStart;
        run.steps.push({
          type: 'llm_call',
          input: { messageCount: messages.length, toolCount: allToolDefs.length },
          output: { status: 'completed', content: finalContent.substring(0, 200) },
          cost: stepCost,
          tokens: { input: stepInputTokens, output: stepOutputTokens },
          duration: stepDuration,
          timestamp: new Date().toISOString(),
        });

        run.currentStep++;
        run.executionTime += stepDuration;

        // Commit the completion with a CAS first: if another worker already
        // advanced this step, abort without double-counting stats/cost.
        if (!(await this.commitStep(run, expectedStep))) return 'done';

        // Update agent stats atomically (see bumpAgentStats rationale).
        await this.s.misc.bumpAgentStats(agent.id, true, run.executionTime, run.totalCost);

        // Auto-save memory if enabled
        if (agent.memoryConfig?.autoSave) {
          await this.s.misc.autoSaveMemory(run, agent);
        }

        this.s.emitEvent(runId, 'run.completed', { output: run.output });
        return 'done';
      }
    } catch (error) {
      this.s.logger.error(`Step failed for run ${runId}: ${error.message}`, error.stack);

      const stepDuration = Date.now() - stepStart;
      run.steps.push({
        type: 'error',
        error: error.message,
        timestamp: new Date().toISOString(),
        duration: stepDuration,
      });
      run.status = AgentRunStatus.FAILED;
      run.error = error.message;
      run.executionTime += stepDuration;

      // Commit the failure with a CAS first: a worker that lost the step
      // race must not also bump stats or clobber a concurrent success.
      if (!(await this.commitStep(run, expectedStep))) return 'done';

      // bumpAgentStats swallows DB errors internally; no outer try/catch.
      await this.s.misc.bumpAgentStats(agent.id, false, run.executionTime, run.totalCost);
      this.s.emitEvent(runId, 'run.failed', { error: error.message });
      return 'done';
    }
  }

  /**
   * Persist the current run state with an optimistic compare-and-swap on
   * currentStep. If another worker already advanced this step (duplicate
   * enqueue or concurrent processing), the guarded UPDATE matches 0 rows
   * and we return false so the caller aborts without re-counting cost or
   * steps. Returns true when this worker won the step.
   */
  private async commitStep(run: AgentRun, expectedStep: number): Promise<boolean> {
    const res = await this.s.runRepository.update(
      { id: run.id, currentStep: expectedStep },
      {
        status: run.status,
        currentStep: run.currentStep,
        totalCost: run.totalCost,
        totalTokens: run.totalTokens,
        executionTime: run.executionTime,
        steps: run.steps,
        output: run.output,
        error: run.error,
        workingMemory: run.workingMemory,
        metadata: run.metadata,
      },
    );
    return (res.affected ?? 0) > 0;
  }

  /**
   * Run the autonomous verify panel against a candidate final answer. Returns
   * the merged panel result, or null when verify is not configured/enabled or
   * has no checkers (so the caller completes normally). Aggregate checker
   * cost/tokens are added to the run here so the caller doesn't double-count.
   */
  private async runAutonomousVerify(
    run: AgentRun,
    agent: Agent,
    finalContent: string,
  ): Promise<VerifyPanelResult | null> {
    const cfg = agent.agentConfig?.verify;
    if (!cfg?.enabled || !Array.isArray(cfg.checkers) || cfg.checkers.length === 0) {
      return null;
    }
    // on_final_output is the default trigger; skip the gate if it's not configured.
    if (!(cfg.triggers ?? ['on_final_output']).includes('on_final_output')) {
      return null;
    }
    if (!finalContent.trim()) {
      // Nothing to check (e.g. the agent ended with an empty message).
      return null;
    }
    const panel = await this.verifier.runPanel(
      { target: finalContent, spec: cfg.spec, checkers: cfg.checkers, policy: cfg.policy },
      run.organizationId,
      run.userId,
    );
    run.totalCost += panel.cost;
    run.totalTokens += panel.tokens;
    return panel;
  }

  /**
   * Advisory mid-run verification. Unlike the final-output gate (which can send
   * the answer back for revision), this reviews in-progress work on the
   * configured triggers (`every_n_steps`, `on_tool_result`) and, on failure,
   * injects a synthetic user note so the agent can course-correct on the next
   * step — it never ends or revises the run. Runs inside the current step,
   * before commitStep, so its cost and the synthetic message persist together.
   */
  private async maybeMidLoopVerify(
    run: AgentRun,
    agent: Agent,
    responseMessage: any,
    runId: string,
  ): Promise<void> {
    const cfg = agent.agentConfig?.verify;
    if (!cfg?.enabled || !Array.isArray(cfg.checkers) || cfg.checkers.length === 0) return;
    const triggers = cfg.triggers ?? ['on_final_output'];
    const everyN = cfg.everyNSteps ?? 5;

    const hadToolResults =
      Array.isArray(responseMessage?.toolCalls) &&
      responseMessage.toolCalls.some((tc: any) => tc.result !== undefined || tc.error);
    const fires =
      (triggers.includes('every_n_steps') && everyN > 0 && run.currentStep % everyN === 0) ||
      (triggers.includes('on_tool_result') && hadToolResults);
    if (!fires) return;

    // Target = this step's assistant content plus the tool results it produced.
    const toolSummary = (responseMessage?.toolCalls || [])
      .map((tc: any) => `${tc.name}: ${tc.error ? `ERROR ${tc.error}` : this.stringifyResult(tc.result)}`)
      .join('\n');
    const target = `Assistant: ${responseMessage?.content || ''}\n\nTool results:\n${toolSummary}`.trim();

    const panel = await this.verifier.runPanel(
      { target, spec: cfg.spec, checkers: cfg.checkers, policy: cfg.policy },
      run.organizationId,
      run.userId,
    );
    run.totalCost += panel.cost;
    run.totalTokens += panel.tokens;

    run.steps.push({
      type: 'verify',
      input: { mode: 'mid_loop', policy: panel.policy, checkers: panel.checkers.length },
      output: { verdict: panel.verdict, advisory: true, failures: panel.failures },
      cost: panel.cost,
      timestamp: new Date().toISOString(),
    });

    if (!panel.passed) {
      const note =
        `Mid-run verification flagged issues with your progress so far:\n\n` +
        panel.failures
          .map((f, i) => `${i + 1}. ${f.rule}${f.evidence ? ` — ${f.evidence}` : ''}`)
          .join('\n') +
        `\n\nAccount for these as you continue; do not repeat them.`;
      if (run.conversationId) {
        const msg = Message.createUserMessage(run.conversationId, note);
        msg.runId = run.id;
        await this.s.messageRepository.save(msg);
      }
      this.s.emitEvent(runId, 'verify.advisory', { step: run.currentStep, failures: panel.failures });
    }
  }

  private stringifyResult(r: any): string {
    if (r === undefined || r === null) return '';
    const s = typeof r === 'string' ? r : JSON.stringify(r);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  }
}