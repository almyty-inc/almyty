import { Injectable, Logger, NotFoundException, BadRequestException, Inject, forwardRef, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { Agent } from '../../entities/agent.entity';
import { Organization } from '../../entities/organization.entity';
import { Tool } from '../../entities/tool.entity';
import { EventEmitter } from 'events';
import { LlmProvidersService, ChatRequest, ChatResponse } from '../llm-providers/llm-providers.service';
import { ToolExecutorService, ToolExecutionOptions, ToolExecutionResult } from '../tools/tool-executor.service';
import { CanonicalMemoryService } from '../memory/canonical/canonical-memory.service';
import { MemoryError, Provenance, Tier } from '../memory/canonical/canonical.types';
import { MessageRole } from '../../entities/message.entity';
import { Conversation, ConversationStatus } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { batchAsync } from '../../common/utils/batch-async';
import { AgentRuntimeBuilders } from './agent-runtime-builders';
import { AgentCollaborationHelper } from './agent-collaboration.helper';
import { AgentHeartbeatHelper } from './agent-heartbeat.helper';
import { AgentBuiltInToolsHelper } from './agent-builtin-tools.helper';
import { AgentRuntimeEventsHelper } from './agent-runtime-events.helper';
import { AgentRuntimeMiscHelper } from './agent-runtime-misc.helper';

/**
 * Built-in tool definitions that the agent runtime injects for autonomous agents.
 */
export const BUILT_IN_TOOLS = {
  wait: {
    name: 'wait',
    description: 'Pause execution for a specified duration (in seconds). Use this when you need to wait before continuing, e.g. waiting for an external process.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Number of seconds to wait (1-3600)' },
        reason: { type: 'string', description: 'Why the agent is waiting' },
      },
      required: ['seconds'],
    },
  },
  ask_user: {
    name: 'ask_user',
    description: 'Ask the user a question and wait for their response. Use this when you need clarification or approval.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
      },
      required: ['question'],
    },
  },
  store_memory: {
    name: 'store_memory',
    description: 'Save an important fact, preference, or piece of context to long-term memory for future use.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content to store' },
        type: { type: 'string', enum: ['fact', 'preference', 'context', 'episode', 'instruction'], description: 'Type of memory' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['content'],
    },
  },
  recall_memory: {
    name: 'recall_memory',
    description: 'Search long-term memory for relevant information about a topic.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memory' },
        limit: { type: 'number', description: 'Max number of results (default 5)' },
      },
      required: ['query'],
    },
  },
};

/** Interval between orphaned-emitter sweeps. */
const RUNTIME_EMITTER_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

@Injectable()
export class AgentRuntimeService implements OnModuleInit {
  private readonly logger = new Logger(AgentRuntimeService.name);

  onModuleInit(): void {
    // Wire the emitter cleanup hook so terminal events flush
    // collaboration-temp agents tied to the run.
    this.events.setCleanupHook((runId) => this.misc.cleanupTemporaryAgents(runId));
  }

  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectQueue('agent-runtime')
    private readonly runtimeQueue: Queue,
    @Inject(forwardRef(() => LlmProvidersService))
    private readonly llmProvidersService: LlmProvidersService,
    @Inject(forwardRef(() => ToolExecutorService))
    private readonly toolExecutorService: ToolExecutorService,
    @Inject(forwardRef(() => CanonicalMemoryService))
    private readonly memoryService: CanonicalMemoryService,
    @InjectRedis() private readonly redis: Redis,
    private readonly builders: AgentRuntimeBuilders,
    private readonly heartbeat: AgentHeartbeatHelper,
    @Inject(forwardRef(() => AgentCollaborationHelper))
    private readonly collaboration: AgentCollaborationHelper,
    @Inject(forwardRef(() => AgentBuiltInToolsHelper))
    private readonly builtInTools: AgentBuiltInToolsHelper,
    private readonly events: AgentRuntimeEventsHelper,
    private readonly misc: AgentRuntimeMiscHelper,
  ) {}

  /**
   * Start a new autonomous agent run
   */
  async startRun(
    agentId: string,
    organizationId: string,
    userId: string,
    input: any,
    options?: {
      maxSteps?: number;
      maxCostCents?: number;
      maxDurationMs?: number;
      parentRunId?: string;
      conversationId?: string;
    },
  ): Promise<AgentRun> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');

    if (agent.mode !== 'autonomous') {
      throw new BadRequestException('Agent is not in autonomous mode. Use /invoke for workflow agents.');
    }

    // Enforce maxChainDepth: count how many ancestors the new run will have
    // by walking the parentRunId chain. The new run's nesting level equals
    // (ancestor count) + 1, so we reject when ancestor count >= maxChainDepth.
    //
    // The previous version only checked AFTER finding another grandparent,
    // so a maxChainDepth of 1 ("only roots") never fired even when creating
    // a child of a root run. Now the check fires from the start (depth=1
    // means "the new run already has 1 ancestor — its parent"), and again
    // after each step up the chain.
    //
    // Also added a hard iteration cap (MAX_PARENT_WALK) so a corrupted
    // parent chain with a cycle can't loop forever.
    if (options?.parentRunId && agent.collaboration?.rules?.maxChainDepth) {
      const maxChainDepth = agent.collaboration.rules.maxChainDepth;
      const MAX_PARENT_WALK = 1000;
      let depth = 1;
      let currentParentId: string | null = options.parentRunId;
      let walks = 0;
      while (currentParentId) {
        if (depth >= maxChainDepth) {
          throw new BadRequestException(`Chain depth limit exceeded (max: ${maxChainDepth})`);
        }
        if (++walks > MAX_PARENT_WALK) {
          this.logger.warn(`Parent chain walk exceeded ${MAX_PARENT_WALK} hops for run ${currentParentId} — possible cycle, aborting walk`);
          break;
        }
        // Scope the parent-chain walk to the caller's org. Without
        // this, a caller in org A could pass a parent run id from
        // org B and the walker would traverse org B's chain to
        // calculate depth — a cross-org probe vector (the walker's
        // depth outcome observably affects whether the new run is
        // accepted or rejected).
        const parentRun = await this.runRepository.findOne({
          where: { id: currentParentId, organizationId },
          select: ['id', 'parentRunId'],
        });
        if (!parentRun || !parentRun.parentRunId) break;
        depth++;
        currentParentId = parentRun.parentRunId;
      }
    }

    // Reuse an existing conversation or create a new one
    let savedConversation: Conversation;
    if (options?.conversationId) {
      const existing = await this.conversationRepository.findOne({
        where: { id: options.conversationId, organizationId },
      } as any);
      if (!existing) {
        throw new BadRequestException('Conversation not found');
      }
      savedConversation = existing;
    } else {
      const conversation = Conversation.createConversation({
        agentId,
        organizationId,
        userId,
      });
      savedConversation = await this.conversationRepository.save(conversation);
    }

    // Persist initial user message
    const userMessage = Message.createUserMessage(
      savedConversation.id,
      typeof input === 'string' ? input : JSON.stringify(input),
    );
    await this.messageRepository.save(userMessage);

    const run = this.runRepository.create({
      agentId,
      organizationId,
      userId,
      conversationId: savedConversation.id,
      mode: AgentMode.AUTONOMOUS,
      status: AgentRunStatus.RUNNING,
      input,
      steps: [],
      currentStep: 0,
      maxSteps: options?.maxSteps || 50,
      limits: {
        maxSteps: options?.maxSteps || 50,
        maxDurationMs: options?.maxDurationMs || 3600000, // 1 hour
        maxCostCents: options?.maxCostCents || 100,       // $1
        maxToolCalls: 100,
      },
      parentRunId: options?.parentRunId || null,
    });

    const savedRun = await this.runRepository.save(run);

    // Create event emitter for this run (for SSE streaming)
    this.events.ensureRunEmitter(savedRun.id);

    // Enqueue first step
    await this.runtimeQueue.add('next-step', { runId: savedRun.id }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 50,
    });

    this.logger.log(`Started run ${savedRun.id} for agent ${agent.name}`);
    return savedRun;
  }

  /**
   * Process one step of a run (called by BullMQ processor).
   * Makes a single LLM call. If the LLM returns tool_calls, executes them and returns 'continue'.
   * If the LLM returns content without tool_calls, the run is done.
   */
  async processStep(runId: string): Promise<'continue' | 'done' | 'waiting'> {
    const run = await this.runRepository.findOne({ where: { id: runId }, relations: ['agent'] });
    if (!run) {
      this.logger.warn(`Run ${runId} not found, skipping`);
      return 'done';
    }

    // Check if run is still active
    if (run.isDone()) {
      this.logger.debug(`Run ${runId} already done (${run.status}), skipping`);
      return 'done';
    }

    // Enforce limits
    const limitCheck = this.misc.checkLimits(run);
    if (limitCheck) {
      run.status = AgentRunStatus.FAILED;
      run.error = limitCheck;
      await this.runRepository.save(run);
      this.emitEvent(runId, 'run.failed', { error: limitCheck });
      return 'done';
    }

    const stepStart = Date.now();
    const agent = run.agent;

    // Enforce collaboration rules.maxTotalCost across sibling runs
    if (run.parentRunId && agent.collaboration?.rules?.maxTotalCost) {
      const siblingRuns = await this.runRepository.find({ where: { parentRunId: run.parentRunId } });
      const totalSiblingCost = siblingRuns.reduce((sum, sr) => sum + (sr.totalCost || 0), 0);
      if (totalSiblingCost >= agent.collaboration.rules.maxTotalCost) {
        run.status = AgentRunStatus.FAILED;
        run.error = `Collaboration total cost limit exceeded ($${totalSiblingCost.toFixed(2)} >= $${agent.collaboration.rules.maxTotalCost})`;
        await this.runRepository.save(run);
        this.emitEvent(runId, 'run.failed', { error: run.error });
        return 'done';
      }
    }

    // If this is a collaboration orchestrator (and NOT a child run), delegate to collaboration handler
    if (agent.collaboration?.strategy && agent.collaboration.agents?.length > 0 && !run.parentRunId) {
      return this.collaboration.processCollaborationStep(run, agent);
    }

    try {
      // Load agent's tools from DB
      const tools = agent.toolIds?.length
        ? await this.toolRepository.find({ where: { id: In(agent.toolIds) } })
        : [];

      // Recall memories if memory is enabled
      let memoryContext = '';
      if (agent.memoryConfig?.enabled) {
        try {
          const recentMessages = run.conversationId
            ? await this.messageRepository.find({ where: { conversationId: run.conversationId, role: MessageRole.USER as any }, order: { createdAt: 'DESC' }, take: 1 })
            : [];
          const lastUserMessage = recentMessages[0];
          if (lastUserMessage) {
            // Canonical search: workspace-scoped, hybrid (vector + FTS).
            // Tier filter is omitted on read so the agent sees memories
            // it stored in any tier (short/project/long/shared).
            const ranked = await this.memoryService.search({
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
          this.logger.warn(`Failed to recall memories for run ${runId}: ${err.message}`);
        }
      }

      // Load organization defaults for system prompt
      const org = await this.organizationRepository.findOne({ where: { id: run.organizationId } });

      // Build messages for the LLM
      const messages = await this.builders.buildMessages(agent, run, tools, memoryContext, org);

      // Build tool definitions for the LLM (user tools + built-in tools)
      const llmTools = this.builders.buildToolDefinitions(tools, agent);

      // Resolve sub-agent tools (only if canCallAgents is enabled)
      let subAgentDefs: Array<{ name: string; description: string; parameters: Record<string, any> }> = [];
      const subAgentMap = new Map<string, string>();
      if (agent.agentConfig?.canCallAgents) {
        const otherAgents = await this.agentRepository.find({
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
      this.logger.debug(`Run ${runId} step ${run.currentStep}: calling LLM with ${messages.length} messages, ${allToolDefs.length} tools`);

      this.emitEvent(runId, 'llm.started', { step: run.currentStep });

      const llmResponse: ChatResponse = await this.llmProvidersService.chatStream(
        providerId,
        chatRequest,
        run.organizationId,
        run.userId,
        (chunk) => {
          if (chunk.content) {
            this.emitEvent(runId, 'llm.chunk', { step: run.currentStep, content: chunk.content });
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

      this.emitEvent(runId, 'llm.response', {
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
          await this.messageRepository.save(assistantMsg);
        }

        // Execute each tool call
        for (const toolCall of responseMessage.toolCalls) {
          const toolExecStart = Date.now();

          // Check for built-in tools first
          this.emitEvent(runId, 'tool.started', { step: run.currentStep, toolCallId: toolCall.id, tool: toolCall.name });

          const builtInResult = await this.builtInTools.executeBuiltInTool(toolCall.name, toolCall.parameters || {}, run, agent);
          if (builtInResult) {
            // Built-in tool was handled
            toolCall.result = builtInResult.result;
            toolCall.error = builtInResult.error;
            toolCall.executionTime = Date.now() - toolExecStart;

            this.emitEvent(runId, 'tool.result', {
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
              await this.messageRepository.save(toolMsg);
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
              await this.runRepository.save(run);
              this.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'sleeping' });
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
              await this.runRepository.save(run);
              this.emitEvent(runId, 'step.completed', { step: run.currentStep, status: 'waiting_input' });
              return 'waiting';
            }

            continue;
          }

          // Check for sub-agent calls
          const subAgentId = subAgentMap.get(toolCall.name);
          if (subAgentId) {
            // tool.started was already emitted above (before built-in check)
            try {
              const subRun = await this.startRun(
                subAgentId,
                run.organizationId,
                run.userId,
                toolCall.parameters?.input || '',
                { parentRunId: run.id, maxSteps: 20, maxCostCents: 50 },
              );
              // Wait for the sub-run to complete (poll with timeout)
              const subResult = await this.misc.waitForRun(subRun.id, 120000);
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
              await this.messageRepository.save(subMsg);
            }

            this.emitEvent(runId, 'tool.result', {
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

            this.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: toolCall.name,
              success: false,
              executionTime: toolCall.executionTime,
            });

            if (run.conversationId) {
              const errMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, `Error: Tool '${toolCall.name}' not found`, toolCall.error);
              errMsg.runId = run.id;
              await this.messageRepository.save(errMsg);
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

            const toolResult: ToolExecutionResult = await this.toolExecutorService.executeTool(
              matchingTool.id,
              toolCall.parameters || {},
              execOptions,
            );

            toolCall.result = toolResult.data;
            toolCall.error = toolResult.success ? undefined : toolResult.error;
            toolCall.executionTime = toolResult.executionTime;
            toolCall.cached = toolResult.cached;

            this.emitEvent(runId, 'tool.result', {
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
              await this.messageRepository.save(toolMsg);
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

            this.emitEvent(runId, 'tool.result', {
              step: run.currentStep,
              toolCallId: toolCall.id,
              tool: matchingTool.name,
              success: false,
              executionTime: toolCall.executionTime,
            });

            if (run.conversationId) {
              const errMsg = Message.createToolResultMessage(run.conversationId, toolCall.id, `Error executing tool: ${err.message}`, err.message);
              errMsg.runId = run.id;
              await this.messageRepository.save(errMsg);
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
        await this.runRepository.save(run);

        // Auto-save memory if enabled
        if (agent.memoryConfig?.autoSave) {
          await this.misc.autoSaveMemory(run, agent);
        }

        this.emitEvent(runId, 'step.completed', { step: run.currentStep, total: run.maxSteps });
        return 'continue';

      } else {
        // No tool calls — the agent has a final response
        const finalContent = responseMessage.content || '';

        // Persist final assistant message
        if (run.conversationId) {
          const finalMsg = Message.createAssistantMessage(run.conversationId, finalContent);
          finalMsg.runId = run.id;
          await this.messageRepository.save(finalMsg);
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
        await this.misc.bumpAgentStats(agent.id, true, run.executionTime, run.totalCost);

        await this.runRepository.save(run);

        // Auto-save memory if enabled
        if (agent.memoryConfig?.autoSave) {
          await this.misc.autoSaveMemory(run, agent);
        }

        this.emitEvent(runId, 'run.completed', { output: run.output });
        return 'done';
      }
    } catch (error) {
      this.logger.error(`Step failed for run ${runId}: ${error.message}`, error.stack);

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
      await this.misc.bumpAgentStats(agent.id, false, run.executionTime, run.totalCost);

      await this.runRepository.save(run);
      this.emitEvent(runId, 'run.failed', { error: error.message });
      return 'done';
    }
  }

  // ---------------------------------------------------------------------------
  // Built-in tool execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a built-in tool. Returns null if the tool name is not a built-in.
   */

  // ---------------------------------------------------------------------------
  // Public API (unchanged)
  // ---------------------------------------------------------------------------

  /**
   * Get a run by ID. Optionally also asserts that the run belongs to
   * a specific agent — the run-scoped controller endpoints
   * `/agents/:id/runs/:runId/...` use this to enforce routing
   * correctness. Previously the `:id` path segment was decorative:
   * any runId in the caller's org would resolve through the endpoint
   * regardless of which agent it was attached to, which meant the
   * URL path wasn't actually a hierarchical constraint.
   */
  async getRun(runId: string, organizationId: string, agentId?: string): Promise<AgentRun> {
    const run = await this.runRepository.findOne({
      where: agentId
        ? { id: runId, organizationId, agentId }
        : { id: runId, organizationId },
      relations: ['agent'],
    });
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  /**
   * List runs for an agent
   */
  async listRuns(agentId: string, organizationId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await this.runRepository.findAndCount({
      where: { agentId, organizationId },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Cancel a run. Optional agentId argument asserts the run belongs
   * to that agent (for the /agents/:id/runs/:runId/cancel route).
   */
  async cancelRun(runId: string, organizationId: string, agentId?: string): Promise<AgentRun> {
    const run = await this.getRun(runId, organizationId, agentId);
    if (run.isDone()) {
      throw new BadRequestException('Run is already completed');
    }
    run.status = AgentRunStatus.CANCELLED;
    await this.runRepository.save(run);
    this.emitEvent(runId, 'run.cancelled', {});
    return run;
  }

  /**
   * Send input to a waiting run (human-in-the-loop). Same optional
   * agentId assertion as cancelRun.
   */
  async sendInput(runId: string, organizationId: string, input: string, agentId?: string): Promise<AgentRun> {
    const run = await this.getRun(runId, organizationId, agentId);
    if (run.status !== AgentRunStatus.WAITING_INPUT) {
      throw new BadRequestException('Run is not waiting for input');
    }

    // Persist user message
    if (run.conversationId) {
      const userMsg = Message.createUserMessage(run.conversationId, input);
      userMsg.runId = run.id;
      await this.messageRepository.save(userMsg);
    }
    run.status = AgentRunStatus.RUNNING;
    await this.runRepository.save(run);

    // Resume execution
    await this.runtimeQueue.add('next-step', { runId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    return run;
  }

  /** Get SSE event emitter for a run. */
  getRunEmitter(runId: string): EventEmitter | null {
    return this.events.getRunEmitter(runId);
  }

  /** Emit an event for SSE subscribers. */
  emitEvent(runId: string, type: string, data: any) {
    this.events.emitEvent(runId, type, data);
  }

  /** Subscribe to run events via Redis Streams (cross-pod). */
  async subscribeRunEvents(
    runId: string,
    handler: (event: { type: string; data: any; timestamp: string }) => void,
    signal?: AbortSignal,
    timeoutMs = 300_000,
  ): Promise<void> {
    return this.events.subscribeRunEvents(runId, handler, signal, timeoutMs);
  }

  /** Best-effort periodic sweep of orphaned run emitters. */
  async sweepOrphanedRunEmitters(): Promise<void> {
    return this.events.sweepOrphanedRunEmitters();
  }

  // ── Delegations to AgentRuntimeMiscHelper ──
  waitForRun(...args: Parameters<AgentRuntimeMiscHelper['waitForRun']>) { return this.misc.waitForRun(...args); }

  // ── Delegations to AgentHeartbeatHelper
  enableHeartbeat(...args: Parameters<AgentHeartbeatHelper['enableHeartbeat']>) { return this.heartbeat.enableHeartbeat(...args); }
  disableHeartbeat(...args: Parameters<AgentHeartbeatHelper['disableHeartbeat']>) { return this.heartbeat.disableHeartbeat(...args); }
}

/**
 * Translate a legacy `type` parameter ('fact', 'preference', 'context',
 * 'episode', 'instruction') into a canonical memory tier. The legacy
 * type field carried two orthogonal axes — durability and shape —
 * that the canonical schema separates: durability becomes `tier`, shape
 * becomes free-form metadata. This mapping keeps existing prompts and
 * agent definitions working without re-prompting.
 */
export function legacyTypeToTier(t: string | undefined): Tier {
  switch (t) {
    case 'context':
      return 'short';
    case 'fact':
    case 'preference':
    case 'instruction':
      return 'long';
    case 'episode':
    default:
      return 'project';
  }
}
