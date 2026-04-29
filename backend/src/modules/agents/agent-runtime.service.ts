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

/**
 * Built-in tool definitions that the agent runtime injects for autonomous agents.
 */
const BUILT_IN_TOOLS = {
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
export class AgentRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRuntimeService.name);
  private readonly runEmitters = new Map<string, EventEmitter>();
  private emitterSweepTimer?: NodeJS.Timeout;

  onModuleInit(): void {
    // Orphaned emitter sweep — see sweepOrphanedRunEmitters below.
    // Previously the runEmitters map had no cleanup path beyond the
    // emitEvent() terminal branch, so any run that died without
    // emitting completed/failed/cancelled (process crash mid-run,
    // BullMQ worker exit, unhandled exception) left its emitter in
    // the map forever. The sweep catches those orphans.
    this.emitterSweepTimer = setInterval(() => {
      this.sweepOrphanedRunEmitters().catch((err) => {
        this.logger.warn(`Emitter sweep failed: ${err.message}`);
      });
    }, RUNTIME_EMITTER_SWEEP_INTERVAL_MS);
    this.emitterSweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.emitterSweepTimer) {
      clearInterval(this.emitterSweepTimer);
      this.emitterSweepTimer = undefined;
    }
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
    this.runEmitters.set(savedRun.id, new EventEmitter());

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
    const limitCheck = this.checkLimits(run);
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
      return this.processCollaborationStep(run, agent);
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
      const messages = await this.buildMessages(agent, run, tools, memoryContext, org);

      // Build tool definitions for the LLM (user tools + built-in tools)
      const llmTools = this.buildToolDefinitions(tools, agent);

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

          const builtInResult = await this.executeBuiltInTool(toolCall.name, toolCall.parameters || {}, run, agent);
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
              const subResult = await this.waitForRun(subRun.id, 120000);
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
          await this.autoSaveMemory(run, agent);
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
        await this.bumpAgentStats(agent.id, true, run.executionTime, run.totalCost);

        await this.runRepository.save(run);

        // Auto-save memory if enabled
        if (agent.memoryConfig?.autoSave) {
          await this.autoSaveMemory(run, agent);
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
      await this.bumpAgentStats(agent.id, false, run.executionTime, run.totalCost);

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
  private async executeBuiltInTool(
    toolName: string,
    parameters: Record<string, any>,
    run: AgentRun,
    agent: Agent,
  ): Promise<{ result?: any; error?: string; status?: 'sleeping' | 'waiting_input' } | null> {
    switch (toolName) {
      case 'wait': {
        const seconds = Math.min(Math.max(Number(parameters.seconds) || 10, 1), 3600);
        run.status = AgentRunStatus.SLEEPING;

        // Enqueue the next step with a delay
        await this.runtimeQueue.add('next-step', { runId: run.id }, {
          delay: seconds * 1000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        });

        return {
          result: `Sleeping for ${seconds} seconds. Will resume automatically.`,
          status: 'sleeping',
        };
      }

      case 'ask_user': {
        const question = parameters.question || 'Please provide input';
        run.status = AgentRunStatus.WAITING_INPUT;

        return {
          result: `Waiting for user input. Question: ${question}`,
          status: 'waiting_input',
        };
      }

      case 'store_memory': {
        try {
          // Map the legacy `type` hint into the canonical tier:
          //   'fact'/'preference'/'instruction' → 'long' (durable)
          //   'context' → 'short' (within-session)
          //   'episode' → 'project' (work-product)
          //   anything else → 'project' (sane default)
          const tier: Tier = legacyTypeToTier(parameters.type as string | undefined);
          const provenance: Provenance = {
            agent_id: agent.id,
            session_id: run.id,
            collab_id: null,
            model: null,
            provider: null,
            tool_chain: ['store_memory'],
            created_by: 'agent',
            source_backend: 'almyty-native',
          };
          const item = await this.memoryService.put(
            {
              mode: 'memory',
              scope: { scope_type: 'workspace', scope_id: run.organizationId },
              content: parameters.content,
              tier,
              tags: parameters.tags || [],
              metadata: { source: { type: 'agent_runtime', id: run.id, name: agent.name } },
              provenance,
            },
            { user_id: run.userId },
          );
          return { result: `Memory stored (id: ${item.id})` };
        } catch (err) {
          if (err instanceof MemoryError) {
            return { result: null, error: `memory rejected: ${err.tag.kind}` };
          }
          return { result: null, error: `Failed to store memory: ${(err as Error).message}` };
        }
      }

      case 'recall_memory': {
        try {
          const ranked = await this.memoryService.search({
            scope: { scope_type: 'workspace', scope_id: run.organizationId },
            query: parameters.query,
            mode: 'memory',
            top_k: parameters.limit || 5,
          });
          if (ranked.length === 0) {
            return { result: 'No relevant memories found.' };
          }
          const formatted = ranked.map((r, i) =>
            `${i + 1}. [${r.item.tier ?? 'memory'}] (score: ${r.score.toFixed(2)}) ${r.item.content}`,
          ).join('\n');
          return { result: formatted };
        } catch (err) {
          return { result: null, error: `Failed to recall memory: ${err.message}` };
        }
      }

      case 'create_agent': {
        try {
          const tempAgent = this.agentRepository.create({
            name: parameters.name,
            description: `Temporary agent created by ${agent.name}`,
            organizationId: run.organizationId,
            mode: 'autonomous' as any,
            status: 'active' as any,
            personality: parameters.personality || null,
            instructions: parameters.instructions,
            toolIds: parameters.toolIds || [],
            modelConfig: agent.modelConfig,
            isTemporary: true,
            parentRunId: run.id,
            pipeline: { nodes: [], edges: [] },
            createdBy: 'system',
          });
          const savedAgent = await this.agentRepository.save(tempAgent);
          return { result: { agentId: savedAgent.id, name: savedAgent.name, status: 'created' } };
        } catch (err) {
          return { result: null, error: `Failed to create temporary agent: ${err.message}` };
        }
      }

      case 'invoke_agent': {
        try {
          const childRun = await this.startRun(
            parameters.agentId,
            run.organizationId,
            run.userId || 'system',
            parameters.input,
            { parentRunId: run.id, maxSteps: 20 },
          );
          const result = await this.waitForRun(childRun.id, 60000);
          if (result?.status === AgentRunStatus.COMPLETED) {
            return { result: { status: 'completed', output: result.output } };
          } else {
            return { result: null, error: result?.error || 'Agent did not complete in time' };
          }
        } catch (err) {
          return { result: null, error: `Failed to invoke agent: ${err.message}` };
        }
      }

      default:
        return null; // Not a built-in tool
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup temporary agents
  // ---------------------------------------------------------------------------

  /**
   * Delete all temporary agents created during a specific run.
   */
  private async cleanupTemporaryAgents(runId: string): Promise<void> {
    try {
      const tempAgents = await this.agentRepository.find({
        where: { isTemporary: true, parentRunId: runId },
      });
      if (tempAgents.length > 0) {
        await this.agentRepository.remove(tempAgents);
        this.logger.log(`Cleaned up ${tempAgents.length} temporary agent(s) for run ${runId}`);
      }
    } catch (err) {
      this.logger.warn(`Failed to cleanup temporary agents for run ${runId}: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Collaboration strategies
  // ---------------------------------------------------------------------------

  /**
   * Handle collaboration orchestration. The orchestrator agent delegates to child agents
   * based on the configured strategy.
   */
  private async processCollaborationStep(run: AgentRun, agent: Agent): Promise<'continue' | 'done' | 'waiting'> {
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
      this.emitEvent(run.id, 'run.failed', { error: error.message });
      return 'done';
    }
  }

  /**
   * Sequential: run agents one after another, each receiving the previous agent's output as input.
   */
  private async runSequentialCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = typeof run.input === 'string' ? run.input : JSON.stringify(run.input);
    const agentOutputs: Array<{ agentId: string; role?: string; output: any }> = [];

    // Step 1: Run the orchestrator agent itself first (its own ReAct loop with tools)
    // The child run has parentRunId set, so it won't re-enter collaboration
    const orchestratorRun = await this.startRun(
      agent.id,
      run.organizationId,
      run.userId,
      inputText,
      { parentRunId: run.id, maxSteps: 20, maxCostCents: 50 },
    );
    const orchestratorResult = await this.waitForRun(orchestratorRun.id, 300000);

    let currentInput = orchestratorResult?.output
      ? (typeof orchestratorResult.output === 'string' ? orchestratorResult.output : JSON.stringify(orchestratorResult.output))
      : inputText;
    agentOutputs.push({ agentId: agent.id, role: 'orchestrator', output: currentInput });
    run.totalCost += orchestratorResult?.totalCost || 0;
    run.totalTokens += orchestratorResult?.totalTokens || 0;

    // Step 2: Run each collaborator agent in sequence, piping output → input
    for (const agentDef of collab.agents) {
      const subRun = await this.startRun(
        agentDef.agentId,
        run.organizationId,
        run.userId,
        currentInput,
        { parentRunId: run.id, maxSteps: 20, maxCostCents: 50 },
      );

      const result = await this.waitForRun(subRun.id, 300000);
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
    this.emitEvent(run.id, 'run.completed', { output: run.output });
    return 'done';
  }

  /**
   * Parallel: run all agents simultaneously, wait for all to complete, merge outputs.
   */
  private async runParallelCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = typeof run.input === 'string' ? run.input : JSON.stringify(run.input);

    // Start all sub-runs simultaneously
    const subRunPromises = collab.agents.map(agentDef =>
      this.startRun(
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
      subRuns.map(sr => this.waitForRun(sr.id, 300000)),
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

      const judgeRun = await this.startRun(
        collab.judgeAgentId,
        run.organizationId,
        run.userId,
        judgeInput,
        { parentRunId: run.id, maxSteps: 10, maxCostCents: 25 },
      );
      const judgeResult = await this.waitForRun(judgeRun.id, 120000);
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
    this.emitEvent(run.id, 'run.completed', { output: run.output });
    return 'done';
  }

  /**
   * Race: run all agents, take the first one to complete, cancel the rest.
   */
  private async runRaceCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
    const collab = agent.collaboration;
    const stepStart = Date.now();
    const inputText = typeof run.input === 'string' ? run.input : JSON.stringify(run.input);

    // Start all sub-runs simultaneously
    const subRuns = await Promise.all(
      collab.agents.map(agentDef =>
        this.startRun(
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
      subRuns.map(sr => this.waitForRun(sr.id, 300000)),
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
    this.emitEvent(run.id, 'run.completed', { output: run.output });
    return 'done';
  }

  /**
   * Debate: run rounds where each agent sees previous responses, then a judge summarizes.
   */
  private async runDebateCollaboration(run: AgentRun, agent: Agent): Promise<'continue' | 'done'> {
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
        this.startRun(
          agentDef.agentId,
          run.organizationId,
          run.userId,
          debateInput,
          { parentRunId: run.id, maxSteps: 10, maxCostCents: 25 },
        ),
      );

      // Wait for all of this round's debaters to finish before recording.
      const results = await batchAsync(subRuns, 3, async (sr) => this.waitForRun(sr.id, 120000));

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

      const judgeRun = await this.startRun(
        collab.judgeAgentId,
        run.organizationId,
        run.userId,
        judgeInput,
        { parentRunId: run.id, maxSteps: 10, maxCostCents: 25 },
      );
      const judgeResult = await this.waitForRun(judgeRun.id, 120000);
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
    this.emitEvent(run.id, 'run.completed', { output: run.output });
    return 'done';
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Build messages array for LLM call
   */
  private async buildMessages(agent: Agent, run: AgentRun, tools: Tool[], memoryContext: string, org?: Organization): Promise<any[]> {
    const messages: any[] = [];

    // Build structured system prompt
    const parts: string[] = [];

    // [ORGANIZATION DEFAULTS] — org-level personality and rules
    const orgDefaults = org?.agentDefaults;
    if (orgDefaults?.personality || orgDefaults?.rules) {
      const orgParts: string[] = [];
      if (orgDefaults.personality) orgParts.push(orgDefaults.personality);
      if (orgDefaults.rules) orgParts.push(orgDefaults.rules);
      parts.push(`[ORGANIZATION DEFAULTS]\n${orgParts.join('\n')}`);
    }

    // [PERSONALITY] — agent-level personality, tone, boundaries
    if (agent.personality) {
      parts.push(`[PERSONALITY]\n${agent.personality}`);
    }

    // [COLLABORATION CONTEXT] — only if this run is part of a collaboration
    const collab = agent.collaboration;
    if (run.parentRunId || (collab?.strategy && collab?.agents?.length > 0)) {
      const collabParts: string[] = [];
      // Find the role of the current agent in the collaboration
      const currentAgentRole = collab?.agents?.find(a => a.agentId === agent.id)?.role;
      if (currentAgentRole && collab?.strategy) {
        collabParts.push(`You are the "${currentAgentRole}" in a ${collab.strategy} collaboration.`);
      } else if (collab?.strategy) {
        collabParts.push(`You are participating in a ${collab.strategy} collaboration.`);
      }
      if (collab?.sharedBrief) {
        collabParts.push(`Brief: ${collab.sharedBrief}`);
      }
      if (collab?.rules) {
        const rulesParts: string[] = [];
        if (collab.rules.maxTotalCost) rulesParts.push(`max cost $${collab.rules.maxTotalCost}`);
        if (collab.rules.outputFormat) rulesParts.push(`output format: ${collab.rules.outputFormat}`);
        if (collab.rules.escalation) rulesParts.push(`escalation: ${collab.rules.escalation}`);
        if (collab.rules.conflictResolution) rulesParts.push(`conflict resolution: ${collab.rules.conflictResolution}`);
        if (rulesParts.length > 0) collabParts.push(`Rules: ${rulesParts.join(', ')}`);
      }
      if (collab?.agents?.length > 0) {
        const teamList = collab.agents.map(a => `${a.role || a.agentId}`).join(', ');
        collabParts.push(`Team members: ${teamList}`);
      }
      if (collabParts.length > 0) {
        parts.push(`[COLLABORATION CONTEXT]\n${collabParts.join('\n')}`);
      }
    }

    // [INSTRUCTIONS] — what to do
    parts.push(`[INSTRUCTIONS]\n${agent.instructions || 'You are a helpful autonomous agent.'}`);

    // [MEMORY] — relevant memories
    if (memoryContext) {
      parts.push(`[RELEVANT MEMORIES]\nRelevant memories:${memoryContext}`);
    }

    // [TOOLS] — available tools
    const toolLines: string[] = [];
    if (tools.length > 0) {
      for (const tool of tools) {
        toolLines.push(`- ${tool.name}: ${tool.description || 'No description'}`);
      }
    }
    toolLines.push('- wait: Pause execution');
    toolLines.push('- ask_user: Ask user a question');
    toolLines.push('- store_memory: Save to long-term memory');
    toolLines.push('- recall_memory: Search long-term memory');
    parts.push(`[AVAILABLE TOOLS]\nYou have access to these tools:\n${toolLines.join('\n')}`);

    const systemPrompt = parts.join('\n\n');

    messages.push({ role: 'system', content: systemPrompt });

    // Thread history: load from messages table
    if (run.conversationId) {
      const conversationMessages = await this.messageRepository.find({
        where: { conversationId: run.conversationId },
        order: { createdAt: 'ASC' },
      });
      for (const msg of conversationMessages) {
        const msgObj: any = { role: msg.role, content: msg.content };
        if (msg.toolCalls) {
          msgObj.toolCalls = msg.toolCalls;
        }
        if (msg.toolCallId) {
          msgObj.toolCallId = msg.toolCallId;
        }
        messages.push(msgObj);
      }
    }

    return messages;
  }

  /**
   * Build tool definitions for the LLM (user tools + built-in tools)
   */
  private buildToolDefinitions(tools: Tool[], agent: Agent): Array<{ name: string; description: string; parameters: Record<string, any> }> {
    const defs: Array<{ name: string; description: string; parameters: Record<string, any> }> = [];

    // User-defined tools
    for (const tool of tools) {
      defs.push({
        name: tool.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
      });
    }

    // Built-in tools
    defs.push(BUILT_IN_TOOLS.wait);
    defs.push(BUILT_IN_TOOLS.ask_user);
    if (agent.memoryConfig?.enabled) {
      defs.push(BUILT_IN_TOOLS.store_memory);
      defs.push(BUILT_IN_TOOLS.recall_memory);
    }

    // Agent creation and invocation tools (only when canCreateAgents is enabled)
    if (agent.agentConfig?.canCreateAgents) {
      defs.push({
        name: 'create_agent',
        description: 'Create a temporary specialist agent for a specific task. The agent will be automatically cleaned up after your run completes.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name for the temporary agent' },
            instructions: { type: 'string', description: 'What this agent should do' },
            personality: { type: 'string', description: 'Personality and style of this agent' },
            toolIds: { type: 'array', items: { type: 'string' }, description: 'Tool IDs this agent can use (from your available tools)' },
          },
          required: ['name', 'instructions'],
        },
      });
      defs.push({
        name: 'invoke_agent',
        description: 'Run an agent (existing or temporary) with the given input and wait for its response.',
        parameters: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'ID of the agent to invoke' },
            input: { type: 'string', description: 'Input message for the agent' },
          },
          required: ['agentId', 'input'],
        },
      });
    }

    return defs;
  }

  /**
   * Wait for a run to complete (polling).
   */
  private async waitForRun(runId: string, timeoutMs: number): Promise<AgentRun | null> {
    const pollInterval = 1000;
    const maxAttempts = Math.ceil(timeoutMs / pollInterval);

    for (let i = 0; i < maxAttempts; i++) {
      const run = await this.runRepository.findOne({ where: { id: runId } });
      if (!run) return null;
      if (run.isDone()) return run;
      await this.sleep(pollInterval);
    }

    // Timeout — cancel the run
    try {
      const run = await this.runRepository.findOne({ where: { id: runId } });
      if (run && !run.isDone()) {
        run.status = AgentRunStatus.TIMEOUT;
        run.error = 'Timed out waiting for sub-agent';
        await this.runRepository.save(run);
      }
      return run;
    } catch (_) {
      return null;
    }
  }

  /**
   * Auto-save a summary of the run as a memory entry after completion.
   */
  private async autoSaveMemory(run: AgentRun, agent: Agent): Promise<void> {
    try {
      // Only save on completion with substantive output
      if (run.status !== AgentRunStatus.COMPLETED || !run.output) return;

      const inputSummary = typeof run.input === 'string' ? run.input : JSON.stringify(run.input);
      const outputSummary = typeof run.output === 'string' ? run.output : JSON.stringify(run.output);

      // Don't save trivially short interactions
      if (inputSummary.length < 20 && outputSummary.length < 20) return;

      const content = `Task: ${inputSummary.substring(0, 500)}\nResult: ${outputSummary.substring(0, 500)}`;

      const provenance: Provenance = {
        agent_id: agent.id,
        session_id: run.id,
        collab_id: null,
        model: null,
        provider: null,
        tool_chain: ['auto_save'],
        created_by: 'agent',
        source_backend: 'almyty-native',
      };
      await this.memoryService.put(
        {
          mode: 'memory',
          scope: { scope_type: 'workspace', scope_id: run.organizationId },
          content,
          tier: 'project',
          tags: ['auto-saved', 'agent-run'],
          metadata: { source: { type: 'agent_runtime', id: run.id, name: agent.name } },
          provenance,
        },
        { user_id: run.userId },
      );
    } catch (err) {
      this.logger.warn(`Failed to auto-save memory for run ${run.id}: ${err.message}`);
    }
  }

  /**
   * Check resource limits.
   *
   * Unit note: `run.totalCost` accumulates values from `llmResponse.cost`, which
   * `LlmProvidersService.calculateProviderCost` returns in **dollars** (see
   * "in dollars per 1K tokens" in llm-providers.service.ts). The `maxCostCents`
   * limit is, per its name, in **cents**. We therefore multiply totalCost by 100
   * when comparing — previously the comparison was dollars-vs-cents, which
   * silently allowed a 100x cost overrun (a `maxCostCents: 100` cap let a run
   * spend $100 before tripping).
   */
  private checkLimits(run: AgentRun): string | null {
    const limits = run.limits || {};

    if (run.currentStep >= (limits.maxSteps || run.maxSteps)) {
      return 'MAX_STEPS_EXCEEDED';
    }
    if (limits.maxCostCents && (run.totalCost * 100) >= limits.maxCostCents) {
      return 'BUDGET_EXCEEDED';
    }
    if (limits.maxDurationMs && (Date.now() - run.createdAt.getTime()) > limits.maxDurationMs) {
      return 'TIMEOUT';
    }
    if (limits.maxTokens && run.totalTokens >= limits.maxTokens) {
      return 'TOKEN_LIMIT_EXCEEDED';
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Atomically update an agent's running stats. Mirrors the helper
   * in AgentExecutionEngine — both paths used to do a load-modify-
   * save pair which lost increments under concurrency. See the
   * engine's `bumpAgentStats` for the full rationale + the Welford
   * rolling-average formula.
   */
  private async bumpAgentStats(
    agentId: string,
    success: boolean,
    executionTime: number,
    cost: number,
  ): Promise<void> {
    try {
      await this.agentRepository
        .createQueryBuilder()
        .update(Agent)
        .set({
          totalExecutions: () => '"totalExecutions" + 1',
          successfulExecutions: success
            ? () => '"successfulExecutions" + 1'
            : () => '"successfulExecutions"',
          totalCost: () => `"totalCost" + ${Number(cost) || 0}`,
          averageExecutionTime: () =>
            `ROUND("averageExecutionTime" + (${Number(executionTime) || 0} - "averageExecutionTime") / ("totalExecutions" + 1))`,
          lastExecutedAt: new Date(),
        })
        .where('id = :id', { id: agentId })
        .execute();
    } catch (err: any) {
      // Best-effort — never mask the run result on a stats failure.
      this.logger.error(`Failed to update agent stats: ${err.message}`);
    }
  }

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

  /**
   * Get SSE event emitter for a run
   */
  getRunEmitter(runId: string): EventEmitter | null {
    return this.runEmitters.get(runId) || null;
  }

  // ---------------------------------------------------------------------------
  // Heartbeat management
  // ---------------------------------------------------------------------------

  /**
   * Enable heartbeat: creates a repeating BullMQ job for this agent.
   */
  async enableHeartbeat(agentId: string, organizationId: string, intervalMinutes: number, prompt: string): Promise<Agent> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');

    // Remove any existing heartbeat job for this agent
    await this.disableHeartbeatJob(agentId);

    // Save heartbeat config on the agent
    agent.heartbeat = { enabled: true, intervalMinutes, prompt };
    await this.agentRepository.save(agent);

    // Create a repeating job
    await this.runtimeQueue.add(
      'heartbeat',
      { agentId, organizationId },
      {
        repeat: { every: intervalMinutes * 60 * 1000 },
        jobId: `heartbeat-${agentId}`,
        removeOnComplete: 50,
        removeOnFail: 20,
      },
    );

    this.logger.log(`Heartbeat enabled for agent ${agentId}: every ${intervalMinutes}m`);
    return agent;
  }

  /**
   * Disable heartbeat: removes the repeating BullMQ job and updates the agent.
   */
  async disableHeartbeat(agentId: string, organizationId: string): Promise<Agent> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');

    agent.heartbeat = { ...agent.heartbeat, enabled: false } as any;
    await this.agentRepository.save(agent);

    await this.disableHeartbeatJob(agentId);

    this.logger.log(`Heartbeat disabled for agent ${agentId}`);
    return agent;
  }

  /**
   * Remove the repeating heartbeat job from the queue.
   */
  private async disableHeartbeatJob(agentId: string): Promise<void> {
    try {
      const repeatableJobs = await this.runtimeQueue.getRepeatableJobs();
      for (const job of repeatableJobs) {
        if (job.id === `heartbeat-${agentId}`) {
          await this.runtimeQueue.removeRepeatableByKey(job.key);
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to remove heartbeat job for agent ${agentId}: ${err.message}`);
    }
  }

  /**
   * Emit an event for SSE subscribers. The emitter is cleaned up
   * on terminal event types (completed / failed / cancelled). If a
   * run dies without ever emitting a terminal event — a process
   * crash mid-run, a BullMQ worker timeout that doesn't get caught,
   * an unhandled exception — the emitter would otherwise leak.
   * The onModuleInit sweeper below handles that case.
   */
  private emitEvent(runId: string, type: string, data: any) {
    const event = { type, data, timestamp: new Date().toISOString() };

    // Local emitter (same-pod fast path)
    const emitter = this.runEmitters.get(runId);
    if (emitter) {
      emitter.emit('event', event);

      if (['run.completed', 'run.failed', 'run.cancelled'].includes(type)) {
        emitter.emit('done');
        this.runEmitters.delete(runId);
        this.cleanupTemporaryAgents(runId).catch(() => {});
      }
    }

    // Redis Stream (cross-pod distribution)
    const streamKey = `run:${runId}:events`;
    this.redis.xadd(streamKey, '*', 'event', JSON.stringify(event)).catch(err => {
      this.logger.warn(`Failed to write event to Redis stream ${streamKey}: ${err.message}`);
    });

    // Set TTL on the stream after terminal events so it auto-cleans
    if (['run.completed', 'run.failed', 'run.cancelled'].includes(type)) {
      this.redis.expire(streamKey, 300).catch(() => {}); // 5 min TTL
    }
  }

  /**
   * Subscribe to run events via Redis Streams. Works across pods.
   * Calls handler for each event. Resolves when a terminal event
   * is received or the timeout expires.
   *
   * Used by SSE endpoints instead of getRunEmitter() for cross-pod support.
   */
  async subscribeRunEvents(
    runId: string,
    handler: (event: { type: string; data: any; timestamp: string }) => void,
    signal?: AbortSignal,
    timeoutMs = 300_000,
  ): Promise<void> {
    const streamKey = `run:${runId}:events`;
    const deadline = Date.now() + timeoutMs;
    let lastId = '0'; // Start from beginning to replay missed events

    // Use a duplicate connection for blocking reads
    const subscriber = this.redis.duplicate();

    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) break;

        const blockMs = Math.min(2000, deadline - Date.now());
        if (blockMs <= 0) break;

        const results = await (subscriber as any).xread(
          'BLOCK', blockMs, 'COUNT', 100,
          'STREAMS', streamKey, lastId,
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (!results) continue;

        for (const [, messages] of results) {
          for (const [id, fields] of messages) {
            lastId = id;
            const raw = fields[1]; // fields = ['event', jsonString]
            try {
              const event = JSON.parse(raw);
              handler(event);
              if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
                return;
              }
            } catch { /* skip malformed */ }
          }
        }
      }
    } finally {
      subscriber.disconnect();
    }
  }

  /**
   * Best-effort periodic sweep of orphaned run emitters. Any
   * emitter whose corresponding run has been in a terminal state
   * in the DB for more than 15 minutes is evicted. The sweep is
   * started in onModuleInit (see module lifecycle) and unref'd
   * so it doesn't keep the event loop alive at shutdown.
   */
  async sweepOrphanedRunEmitters(): Promise<void> {
    if (this.runEmitters.size === 0) return;
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);

    for (const runId of Array.from(this.runEmitters.keys())) {
      try {
        const run = await this.runRepository.findOne({
          where: { id: runId },
          select: ['id', 'status', 'updatedAt'],
        });
        // Run gone → orphaned.
        if (!run) {
          this.runEmitters.delete(runId);
          continue;
        }
        // Run in a terminal state for longer than the cutoff → orphaned.
        const terminal = ['completed', 'failed', 'cancelled', 'timeout'];
        if (terminal.includes(run.status as any) && run.updatedAt < cutoff) {
          this.runEmitters.delete(runId);
        }
      } catch {
        // Best-effort — swallow DB hiccups.
      }
    }
  }
}

/**
 * Translate a legacy `type` parameter ('fact', 'preference', 'context',
 * 'episode', 'instruction') into a canonical memory tier. The legacy
 * type field carried two orthogonal axes — durability and shape —
 * that the canonical schema separates: durability becomes `tier`, shape
 * becomes free-form metadata. This mapping keeps existing prompts and
 * agent definitions working without re-prompting.
 */
function legacyTypeToTier(t: string | undefined): Tier {
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
