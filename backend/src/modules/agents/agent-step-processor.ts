import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { In } from 'typeorm';

import { AgentRunStatus } from '../../entities/agent-run.entity';
import { ConversationStatus } from '../../entities/conversation.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message, MessageRole } from '../../entities/message.entity';
import { batchAsync } from '../../common/utils/batch-async';
import { AgentRuntimeService } from './agent-runtime.service';
import { ChatRequest, ChatResponse } from '../llm-providers/llm-providers.service';
import { ToolExecutionOptions, ToolExecutionResult } from '../tools/tool-executor.service';
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
      const messages = await this.s.builders.buildMessages(agent, run, tools, memoryContext, org);

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
              await this.s.runRepository.save(run);
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
              await this.s.runRepository.save(run);
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
        await this.s.runRepository.save(run);

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

        // Update agent stats atomically (see bumpAgentStats
        // rationale — same race as the engine used to have).
        await this.s.misc.bumpAgentStats(agent.id, true, run.executionTime, run.totalCost);

        await this.s.runRepository.save(run);

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

      // Update agent stats (failure). bumpAgentStats already
      // swallows DB errors internally so no outer try/catch needed.
      await this.s.misc.bumpAgentStats(agent.id, false, run.executionTime, run.totalCost);

      await this.s.runRepository.save(run);
      this.s.emitEvent(runId, 'run.failed', { error: error.message });
      return 'done';
    }
  }
}
