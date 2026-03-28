import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { Agent } from '../../entities/agent.entity';
import { Tool } from '../../entities/tool.entity';
import { EventEmitter } from 'events';

@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name);
  private readonly runEmitters = new Map<string, EventEmitter>();

  constructor(
    @InjectRepository(AgentRun)
    private readonly runRepository: Repository<AgentRun>,
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
    @InjectQueue('agent-runtime')
    private readonly runtimeQueue: Queue,
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
    },
  ): Promise<AgentRun> {
    const agent = await this.agentRepository.findOne({ where: { id: agentId, organizationId } });
    if (!agent) throw new NotFoundException('Agent not found');

    if (agent.mode !== 'autonomous') {
      throw new BadRequestException('Agent is not in autonomous mode. Use /invoke for workflow agents.');
    }

    const run = this.runRepository.create({
      agentId,
      organizationId,
      userId,
      mode: AgentMode.AUTONOMOUS,
      status: AgentRunStatus.RUNNING,
      input,
      thread: [
        { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input), timestamp: new Date().toISOString() },
      ],
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
   * Process one step of a run (called by BullMQ processor)
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

    try {
      // Load agent's tools
      const agent = run.agent;
      const tools = agent.toolIds?.length
        ? await this.toolRepository.findByIds(agent.toolIds)
        : [];

      // Build messages for LLM
      const messages = this.buildMessages(agent, run, tools);

      // Format tools for LLM
      const llmTools = tools.map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} },
        },
      }));

      // Add sub-agent tool if other agents exist
      // (agents can call other agents as sub-agents)
      const otherAgents = await this.agentRepository.find({
        where: { organizationId: run.organizationId, status: 'active' as any },
        select: ['id', 'name', 'description'],
      });
      const subAgentTools = otherAgents
        .filter(a => a.id !== agent.id)
        .map(a => ({
          type: 'function' as const,
          function: {
            name: `call_agent_${a.name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
            description: `Call sub-agent "${a.name}": ${a.description || 'No description'}`,
            parameters: {
              type: 'object',
              properties: {
                input: { type: 'string', description: 'The input/message to send to this agent' },
              },
              required: ['input'],
            },
          },
          _agentId: a.id,
        }));

      const allTools = [...llmTools, ...subAgentTools];

      // Build step record
      const step: any = {
        type: 'llm_call',
        input: { messageCount: messages.length, toolCount: allTools.length },
        timestamp: new Date().toISOString(),
      };

      // The actual LLM integration will be connected via LlmProvidersService.
      // For the runtime structure, we handle tool calls and responses:

      // If the last message in thread is from the assistant with no tool calls, the run is done
      const lastMessage = run.thread[run.thread.length - 1];

      if (lastMessage?.role === 'assistant' && !lastMessage?.toolCalls?.length) {
        // Agent has responded without tool calls — run is complete
        run.status = AgentRunStatus.COMPLETED;
        run.output = lastMessage.content;
        step.output = { status: 'completed' };
        step.duration = Date.now() - stepStart;
        run.steps.push(step);
        run.executionTime += step.duration;
        await this.runRepository.save(run);
        this.emitEvent(runId, 'run.completed', { output: run.output });
        return 'done';
      }

      // Otherwise, continue the ReAct loop
      // Mark that we need an LLM call (the processor will handle it)
      run.currentStep++;
      step.output = { status: 'continue', nextAction: 'llm_call' };
      step.duration = Date.now() - stepStart;
      run.steps.push(step);
      run.executionTime += step.duration;
      await this.runRepository.save(run);

      this.emitEvent(runId, 'step.completed', { step: run.currentStep, total: run.maxSteps });

      return 'continue';
    } catch (error) {
      this.logger.error(`Step failed for run ${runId}: ${error.message}`, error.stack);

      const step = {
        type: 'error',
        error: error.message,
        timestamp: new Date().toISOString(),
        duration: Date.now() - stepStart,
      };
      run.steps.push(step as any);
      run.status = AgentRunStatus.FAILED;
      run.error = error.message;
      run.executionTime += step.duration;
      await this.runRepository.save(run);
      this.emitEvent(runId, 'run.failed', { error: error.message });
      return 'done';
    }
  }

  /**
   * Build messages array for LLM call
   */
  private buildMessages(agent: Agent, run: AgentRun, tools: Tool[]): any[] {
    const messages: any[] = [];

    // System prompt from agent instructions
    if (agent.instructions) {
      let systemPrompt = agent.instructions;

      // Add tool descriptions
      if (tools.length > 0) {
        systemPrompt += '\n\nYou have access to the following tools:\n';
        for (const tool of tools) {
          systemPrompt += `- ${tool.name}: ${tool.description || 'No description'}\n`;
        }
      }

      messages.push({ role: 'system', content: systemPrompt });
    }

    // Thread history
    for (const msg of run.thread) {
      messages.push({ role: msg.role, content: msg.content, ...(msg.toolCalls ? { tool_calls: msg.toolCalls } : {}) });
    }

    return messages;
  }

  /**
   * Check resource limits
   */
  private checkLimits(run: AgentRun): string | null {
    const limits = run.limits || {};

    if (run.currentStep >= (limits.maxSteps || run.maxSteps)) {
      return 'MAX_STEPS_EXCEEDED';
    }
    if (limits.maxCostCents && run.totalCost >= limits.maxCostCents) {
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

  /**
   * Get a run by ID
   */
  async getRun(runId: string, organizationId: string): Promise<AgentRun> {
    const run = await this.runRepository.findOne({
      where: { id: runId, organizationId },
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
   * Cancel a run
   */
  async cancelRun(runId: string, organizationId: string): Promise<AgentRun> {
    const run = await this.getRun(runId, organizationId);
    if (run.isDone()) {
      throw new BadRequestException('Run is already completed');
    }
    run.status = AgentRunStatus.CANCELLED;
    await this.runRepository.save(run);
    this.emitEvent(runId, 'run.cancelled', {});
    return run;
  }

  /**
   * Send input to a waiting run (human-in-the-loop)
   */
  async sendInput(runId: string, organizationId: string, input: string): Promise<AgentRun> {
    const run = await this.getRun(runId, organizationId);
    if (run.status !== AgentRunStatus.WAITING_INPUT) {
      throw new BadRequestException('Run is not waiting for input');
    }

    // Add user message to thread
    run.thread.push({
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    });
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

  /**
   * Emit an event for SSE subscribers
   */
  private emitEvent(runId: string, type: string, data: any) {
    const emitter = this.runEmitters.get(runId);
    if (emitter) {
      emitter.emit('event', { type, data, timestamp: new Date().toISOString() });

      // Clean up emitter if run is done
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(type)) {
        emitter.emit('done');
        this.runEmitters.delete(runId);
      }
    }
  }
}
