import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';
import axios, { AxiosRequestConfig } from 'axios';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

import {
  A2AAgent,
  A2AAgentType,
  A2AMessage,
  A2AMessageType,
  A2ASession,
  A2ASessionStatus,
  A2AWorkflow,
  A2AMetrics,
  A2AToolRegistration,
  A2AEvent,
  A2AContext,
} from './types/a2a.types';

import { Tool } from '../../entities/tool.entity';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { McpSessionService } from './mcp-session.service';
import { ToolExecutorService } from '../tools/tool-executor.service';

@Injectable()
export class A2AService extends EventEmitter {
  private readonly logger = new Logger(A2AService.name);
  private readonly agents = new Map<string, A2AAgent>();
  private readonly sessions = new Map<string, A2ASession>();
  private readonly workflows = new Map<string, A2AWorkflow>();
  private readonly messageQueue = new Map<string, A2AMessage[]>();

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private mcpSessionService: McpSessionService,
    private toolExecutorService: ToolExecutorService,
    @InjectRedis() private readonly redis: Redis.Redis,
  ) {
    super();
    this.setupEventHandlers();
  }

  // Agent Registration and Management
  async registerAgent(
    organizationId: string,
    agentData: {
      name: string;
      description?: string;
      type: A2AAgentType;
      endpoint: string;
      capabilities?: any;
      configuration?: any;
      authentication?: any;
      metadata?: any;
    }
  ): Promise<A2AAgent> {
    // Verify organization exists
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    // Test agent connectivity
    await this.testAgentConnection(agentData.endpoint, agentData.authentication);

    const agent: A2AAgent = {
      id: `a2a_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: agentData.name,
      description: agentData.description,
      type: agentData.type,
      organizationId,
      endpoint: agentData.endpoint,
      capabilities: agentData.capabilities || this.getDefaultCapabilities(agentData.type),
      configuration: agentData.configuration || this.getDefaultConfiguration(),
      authentication: agentData.authentication,
      isActive: true,
      lastSeen: new Date(),
      metadata: {
        ...agentData.metadata,
        registeredAt: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    this.agents.set(agent.id, agent);

    // Store in Redis for persistence
    await this.redis.setex(
      `agent:${agent.id}`,
      86400, // 24 hours
      JSON.stringify(agent)
    );

    // Emit registration event
    await this.emitA2AEvent('agent_registered', {
      agentId: agent.id,
      organizationId,
      data: { name: agent.name, type: agent.type },
    });

    this.logger.log(`A2A agent registered: ${agent.id} (${agent.name}) for org: ${organizationId}`);

    return agent;
  }

  async getAgent(agentId: string): Promise<A2AAgent | null> {
    const agent = this.agents.get(agentId);
    if (agent) {
      return agent;
    }

    // Check Redis
    try {
      const cached = await this.redis.get(`agent:${agentId}`);
      if (cached) {
        const agent = JSON.parse(cached);
        this.agents.set(agentId, agent);
        return agent;
      }
    } catch (error) {
      this.logger.error(`Failed to get agent from Redis: ${error.message}`);
    }

    return null;
  }

  async listAgents(organizationId: string): Promise<A2AAgent[]> {
    return Array.from(this.agents.values()).filter(
      agent => agent.organizationId === organizationId && agent.isActive
    );
  }

  async updateAgent(agentId: string, updates: Partial<A2AAgent>): Promise<A2AAgent | null> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      return null;
    }

    Object.assign(agent, updates, { lastSeen: new Date() });
    this.agents.set(agentId, agent);

    // Update Redis
    await this.redis.setex(`agent:${agentId}`, 86400, JSON.stringify(agent));

    this.logger.log(`A2A agent updated: ${agentId}`);
    return agent;
  }

  async deregisterAgent(agentId: string): Promise<boolean> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      return false;
    }

    // Mark as inactive
    agent.isActive = false;
    this.agents.set(agentId, agent);

    // Remove from Redis
    await this.redis.del(`agent:${agentId}`);

    // Emit deregistration event
    await this.emitA2AEvent('agent_deregistered', {
      agentId,
      organizationId: agent.organizationId,
      data: { name: agent.name, type: agent.type },
    });

    this.logger.log(`A2A agent deregistered: ${agentId}`);
    return true;
  }

  // Agent Communication
  async sendMessage(
    fromAgentId: string,
    toAgentId: string,
    content: any,
    type: A2AMessageType = A2AMessageType.REQUEST,
    context?: any,
  ): Promise<A2AMessage> {
    const fromAgent = await this.getAgent(fromAgentId);
    const toAgent = await this.getAgent(toAgentId);

    if (!fromAgent || !toAgent) {
      throw new NotFoundException('Agent not found');
    }

    // Verify agents are in same organization or authorized
    if (fromAgent.organizationId !== toAgent.organizationId) {
      throw new ForbiddenException('Cross-organization communication not allowed');
    }

    const message: A2AMessage = {
      id: uuidv4(),
      fromAgentId,
      toAgentId,
      type,
      content,
      context: {
        ...context,
        organizationId: fromAgent.organizationId,
        timestamp: new Date().toISOString(),
      },
      metadata: {
        timestamp: new Date().toISOString(),
        correlationId: context?.correlationId || uuidv4(),
      },
    };

    // Add to message queue
    if (!this.messageQueue.has(toAgentId)) {
      this.messageQueue.set(toAgentId, []);
    }
    this.messageQueue.get(toAgentId)!.push(message);

    // Deliver message to target agent
    await this.deliverMessage(message);

    // Emit message event
    await this.emitA2AEvent('message_sent', {
      agentId: fromAgentId,
      organizationId: fromAgent.organizationId,
      data: { toAgentId, messageType: type },
    });

    return message;
  }

  private async deliverMessage(message: A2AMessage): Promise<void> {
    const toAgent = await this.getAgent(message.toAgentId);
    if (!toAgent) {
      this.logger.error(`Cannot deliver message: agent ${message.toAgentId} not found`);
      return;
    }

    try {
      // Build request based on agent type
      const requestConfig = await this.buildAgentRequest(toAgent, message);
      
      // Send message to agent
      const response = await axios(requestConfig);
      
      // Update agent last seen
      await this.updateAgent(toAgent.id, { lastSeen: new Date() });

      this.logger.debug(`Message delivered to agent ${toAgent.id}: ${message.id}`);

      // Handle response if it's a request
      if (message.type === A2AMessageType.REQUEST && response.data) {
        await this.handleAgentResponse(message, response.data);
      }

    } catch (error) {
      this.logger.error(`Failed to deliver message to agent ${toAgent.id}: ${error.message}`);
      
      // Mark agent as potentially inactive
      if (error.code === 'ECONNREFUSED' || error.response?.status >= 500) {
        await this.updateAgent(toAgent.id, { isActive: false });
      }
    }
  }

  private async buildAgentRequest(agent: A2AAgent, message: A2AMessage): Promise<AxiosRequestConfig> {
    const config: AxiosRequestConfig = {
      url: agent.endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'apifai-a2a/1.0.0',
        ...agent.configuration?.headers,
      },
      data: message,
      timeout: agent.configuration?.timeout || 30000,
    };

    // Apply authentication
    if (agent.authentication) {
      this.applyAuthentication(config, agent.authentication);
    }

    // Handle different agent types
    switch (agent.type) {
      case A2AAgentType.OPENAI:
        return await this.buildOpenAIRequest(config, message);
      case A2AAgentType.ANTHROPIC:
        return await this.buildAnthropicRequest(config, message);
      case A2AAgentType.CUSTOM_LLM:
        return this.buildCustomLLMRequest(config, message);
      default:
        return config;
    }
  }

  private async buildOpenAIRequest(config: AxiosRequestConfig, message: A2AMessage): Promise<AxiosRequestConfig> {
    config.url = 'https://api.openai.com/v1/chat/completions';

    // Resolve real tool schemas from context
    const tools = await this.resolveToolsFromContext(message.context);
    const openaiTools = tools.length > 0
      ? tools.map(t => t.toOpenAPITool())
      : undefined;

    // Use model from agent metadata or message context, default to gpt-4o
    const model = message.context?.preferences?.model || 'gpt-4o';

    // Build user content — prefer text, fall back to JSON serialization
    const userContent = message.content.text || JSON.stringify(message.content.data || message.content);

    config.data = {
      model,
      messages: [
        { role: 'user', content: userContent },
      ],
      ...(openaiTools && { tools: openaiTools }),
    };

    return config;
  }

  private async buildAnthropicRequest(config: AxiosRequestConfig, message: A2AMessage): Promise<AxiosRequestConfig> {
    config.url = 'https://api.anthropic.com/v1/messages';
    config.headers['anthropic-version'] = '2023-06-01';

    // Resolve real tool schemas from context
    const tools = await this.resolveToolsFromContext(message.context);
    const anthropicTools = tools.length > 0
      ? tools.map(t => t.toAnthropicTool())
      : undefined;

    // Use model from agent metadata or message context
    const model = message.context?.preferences?.model || 'claude-sonnet-4-20250514';
    const maxTokens = message.context?.preferences?.maxTokens || 4096;

    const userContent = message.content.text || JSON.stringify(message.content.data || message.content);

    config.data = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'user', content: userContent },
      ],
      ...(anthropicTools && { tools: anthropicTools }),
    };

    return config;
  }

  private buildCustomLLMRequest(config: AxiosRequestConfig, message: A2AMessage): AxiosRequestConfig {
    // Keep message in A2A format for custom agents
    return config;
  }

  private applyAuthentication(config: AxiosRequestConfig, auth: any): void {
    switch (auth.type) {
      case 'api_key':
        if (auth.location === 'header') {
          config.headers = config.headers || {};
          config.headers[auth.parameter || 'Authorization'] = auth.config.apiKey;
        } else if (auth.location === 'query') {
          config.params = config.params || {};
          config.params[auth.parameter || 'api_key'] = auth.config.apiKey;
        }
        break;

      case 'bearer':
        config.headers = config.headers || {};
        config.headers['Authorization'] = `Bearer ${auth.config.token}`;
        break;

      case 'oauth2':
        config.headers = config.headers || {};
        config.headers['Authorization'] = `Bearer ${auth.config.accessToken}`;
        break;
    }
  }

  // Handle agent responses — including LLM tool call loops
  private async handleAgentResponse(originalMessage: A2AMessage, responseData: any): Promise<void> {
    const toAgent = await this.getAgent(originalMessage.toAgentId);

    // For LLM agents, process tool call loop before delivering final response
    let finalData = responseData;
    if (toAgent && (toAgent.type === A2AAgentType.OPENAI || toAgent.type === A2AAgentType.ANTHROPIC)) {
      finalData = await this.processLLMToolCallLoop(toAgent, originalMessage, responseData);
    }

    const responseMessage: A2AMessage = {
      id: uuidv4(),
      fromAgentId: originalMessage.toAgentId,
      toAgentId: originalMessage.fromAgentId,
      type: A2AMessageType.RESPONSE,
      content: { data: finalData },
      context: {
        ...originalMessage.context,
        parentMessageId: originalMessage.id,
      },
      metadata: {
        timestamp: new Date().toISOString(),
        correlationId: originalMessage.metadata?.correlationId,
      },
    };

    // Queue response message
    if (!this.messageQueue.has(originalMessage.fromAgentId)) {
      this.messageQueue.set(originalMessage.fromAgentId, []);
    }
    this.messageQueue.get(originalMessage.fromAgentId)!.push(responseMessage);

    this.emit('messageReceived', responseMessage);
  }

  /**
   * Process LLM tool call loop: execute tool calls from LLM responses
   * and feed results back until the LLM produces a final text response.
   */
  private async processLLMToolCallLoop(
    agent: A2AAgent,
    originalMessage: A2AMessage,
    initialResponse: any,
    maxIterations = 10,
  ): Promise<any> {
    let currentResponse = initialResponse;
    let messages: any[] = [];

    // Build initial conversation from the original message
    const userContent = originalMessage.content.text
      || JSON.stringify(originalMessage.content.data || originalMessage.content);
    messages.push({ role: 'user', content: userContent });

    for (let i = 0; i < maxIterations; i++) {
      const toolCalls = this.extractToolCalls(agent.type, currentResponse);

      if (toolCalls.length === 0) {
        return currentResponse; // No more tool calls — final response
      }

      this.logger.debug(`LLM tool call loop iteration ${i + 1}: ${toolCalls.length} tool calls`);

      // Execute all tool calls
      const toolResults = await this.executeToolCalls(toolCalls, agent.organizationId);

      // Append assistant message (with tool calls) and tool results to conversation
      messages = this.appendToolCallRound(agent.type, messages, currentResponse, toolCalls, toolResults);

      // Resolve tools for the next request
      const tools = await this.resolveToolsFromContext(originalMessage.context);

      // Build and send the next LLM request
      const nextConfig = this.buildLLMFollowUpRequest(agent, messages, tools);
      const response = await axios(nextConfig);
      currentResponse = response.data;
    }

    this.logger.warn(`LLM tool call loop exceeded ${maxIterations} iterations for agent ${agent.id}`);
    return currentResponse;
  }

  /**
   * Extract tool calls from an LLM response, supporting both OpenAI and Anthropic formats.
   */
  private extractToolCalls(agentType: A2AAgentType, responseData: any): Array<{
    id: string;
    name: string;
    arguments: Record<string, any>;
  }> {
    if (agentType === A2AAgentType.OPENAI) {
      // OpenAI format: choices[0].message.tool_calls
      const toolCalls = responseData?.choices?.[0]?.message?.tool_calls;
      if (!toolCalls || !Array.isArray(toolCalls)) return [];
      return toolCalls.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      }));
    }

    if (agentType === A2AAgentType.ANTHROPIC) {
      // Anthropic format: content[] with type === 'tool_use'
      const contentBlocks = responseData?.content;
      if (!contentBlocks || !Array.isArray(contentBlocks)) return [];
      return contentBlocks
        .filter((block: any) => block.type === 'tool_use')
        .map((block: any) => ({
          id: block.id,
          name: block.name,
          arguments: block.input || {},
        }));
    }

    return [];
  }

  /**
   * Execute tool calls via the ToolExecutorService.
   */
  private async executeToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, any> }>,
    organizationId: string,
  ): Promise<Array<{ id: string; name: string; result: any; error?: string }>> {
    const results = await Promise.allSettled(
      toolCalls.map(async (tc) => {
        // Look up tool by name within the organization
        const tool = await this.toolRepository.findOne({
          where: { name: tc.name, organizationId, status: 'active' as any },
        });

        if (!tool) {
          return { id: tc.id, name: tc.name, result: null, error: `Tool '${tc.name}' not found` };
        }

        try {
          const execResult = await this.toolExecutorService.executeTool(
            tool.id,
            tc.arguments,
            { userId: null, organizationId, skipRateLimit: false },
          );
          return {
            id: tc.id,
            name: tc.name,
            result: execResult.success ? execResult.data : null,
            error: execResult.error,
          };
        } catch (err) {
          this.logger.error(`A2A tool execution failed for ${tc.name}: ${err.message}`);
          return { id: tc.id, name: tc.name, result: null, error: err.message };
        }
      }),
    );

    return results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { id: '', name: '', result: null, error: (r.reason as Error).message },
    );
  }

  /**
   * Append a tool call round (assistant tool_calls + tool results) to the conversation.
   */
  private appendToolCallRound(
    agentType: A2AAgentType,
    messages: any[],
    responseData: any,
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, any> }>,
    toolResults: Array<{ id: string; name: string; result: any; error?: string }>,
  ): any[] {
    if (agentType === A2AAgentType.OPENAI) {
      // Append the assistant message with tool_calls
      messages.push(responseData.choices[0].message);
      // Append each tool result
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.id,
          content: JSON.stringify(tr.error ? { error: tr.error } : tr.result),
        });
      }
      return messages;
    }

    if (agentType === A2AAgentType.ANTHROPIC) {
      // Append assistant message (all content blocks including tool_use)
      messages.push({ role: 'assistant', content: responseData.content });
      // Append tool results as a user message with tool_result blocks
      messages.push({
        role: 'user',
        content: toolResults.map((tr) => ({
          type: 'tool_result',
          tool_use_id: tr.id,
          content: tr.error ? JSON.stringify({ error: tr.error }) : JSON.stringify(tr.result),
          is_error: !!tr.error,
        })),
      });
      return messages;
    }

    return messages;
  }

  /**
   * Build a follow-up LLM request with the full conversation history.
   */
  private buildLLMFollowUpRequest(
    agent: A2AAgent,
    messages: any[],
    tools: Tool[],
  ): AxiosRequestConfig {
    const config: AxiosRequestConfig = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: agent.configuration?.timeout || 60000,
    };

    if (agent.authentication) {
      this.applyAuthentication(config, agent.authentication);
    }

    if (agent.type === A2AAgentType.OPENAI) {
      config.url = 'https://api.openai.com/v1/chat/completions';
      const model = agent.metadata?.model || 'gpt-4o';
      const openaiTools = tools.length > 0 ? tools.map(t => t.toOpenAPITool()) : undefined;
      config.data = { model, messages, ...(openaiTools && { tools: openaiTools }) };
    } else if (agent.type === A2AAgentType.ANTHROPIC) {
      config.url = 'https://api.anthropic.com/v1/messages';
      config.headers['anthropic-version'] = '2023-06-01';
      const model = agent.metadata?.model || 'claude-sonnet-4-20250514';
      const anthropicTools = tools.length > 0 ? tools.map(t => t.toAnthropicTool()) : undefined;
      config.data = {
        model,
        max_tokens: 4096,
        messages,
        ...(anthropicTools && { tools: anthropicTools }),
      };
    }

    return config;
  }

  /**
   * Resolve Tool entities from message context (tool names or IDs).
   */
  private async resolveToolsFromContext(context?: A2AContext): Promise<Tool[]> {
    if (!context) return [];

    const orgId = context.organizationId;
    if (!orgId) return [];

    // Support both tool names and tool IDs
    const toolNames = context.tools || [];
    if (toolNames.length === 0) return [];

    // Try loading by name first (most common in context)
    const tools = await this.toolRepository.find({
      where: toolNames.map(name => ({
        name,
        organizationId: orgId,
        status: 'active' as any,
      })),
    });

    // If no results by name, try by ID
    if (tools.length === 0) {
      const toolsById = await this.toolRepository.find({
        where: toolNames.map(id => ({
          id,
          organizationId: orgId,
          status: 'active' as any,
        })),
      });
      return toolsById;
    }

    return tools;
  }

  // Session Management
  async createSession(
    organizationId: string,
    participantAgentIds: string[],
    metadata?: any,
  ): Promise<A2ASession> {
    // Verify all agents exist and belong to organization
    for (const agentId of participantAgentIds) {
      const agent = await this.getAgent(agentId);
      if (!agent || agent.organizationId !== organizationId) {
        throw new BadRequestException(`Agent ${agentId} not found or not accessible`);
      }
    }

    const session: A2ASession = {
      id: uuidv4(),
      organizationId,
      participantAgents: participantAgentIds,
      status: A2ASessionStatus.ACTIVE,
      startedAt: new Date(),
      lastActivity: new Date(),
      messageCount: 0,
      metadata,
    };

    this.sessions.set(session.id, session);

    // Store in Redis
    await this.redis.setex(
      `session:${session.id}`,
      86400, // 24 hours
      JSON.stringify(session)
    );

    // Emit session event
    await this.emitA2AEvent('session_started', {
      sessionId: session.id,
      organizationId,
      data: { participantAgents: participantAgentIds },
    });

    this.logger.log(`A2A session created: ${session.id} with ${participantAgentIds.length} agents`);

    return session;
  }

  async getSession(sessionId: string): Promise<A2ASession | null> {
    const session = this.sessions.get(sessionId);
    if (session) {
      return session;
    }

    // Check Redis
    try {
      const cached = await this.redis.get(`session:${sessionId}`);
      if (cached) {
        const session = JSON.parse(cached);
        this.sessions.set(sessionId, session);
        return session;
      }
    } catch (error) {
      this.logger.error(`Failed to get session from Redis: ${error.message}`);
    }

    return null;
  }

  // Tool Registration for Agents
  async registerAgentTool(
    agentId: string,
    toolRegistration: A2AToolRegistration,
  ): Promise<Tool> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    // Create tool directly via repository (system-level operation, no user context)
    const tool = this.toolRepository.create({
      name: `${agent.name}_${toolRegistration.toolName}`,
      description: toolRegistration.description || `Tool from agent ${agent.name}`,
      parameters: toolRegistration.inputSchema,
      type: 'function' as any,
      status: 'active' as any,
      organizationId: agent.organizationId,
      metadata: {
        a2aAgent: {
          agentId,
          originalName: toolRegistration.toolName,
          endpoint: toolRegistration.endpoint,
          method: toolRegistration.method,
        },
        outputSchema: toolRegistration.outputSchema,
        autoGenerated: true,
        source: 'a2a_agent',
      },
    });

    const savedTool = await this.toolRepository.save(tool);

    this.logger.log(`Tool registered for A2A agent ${agentId}: ${toolRegistration.toolName} (tool ID: ${savedTool.id})`);
    return savedTool;
  }

  // Message retrieval
  async getAgentMessages(agentId: string, limit = 50): Promise<A2AMessage[]> {
    const messages = this.messageQueue.get(agentId) || [];
    // Return most recent messages, up to limit
    return messages.slice(-limit);
  }

  // Agent Discovery and Health Monitoring
  async discoverAgents(organizationId: string): Promise<A2AAgent[]> {
    const agents = await this.listAgents(organizationId);
    const healthyAgents: A2AAgent[] = [];

    for (const agent of agents) {
      try {
        await this.pingAgent(agent);
        healthyAgents.push(agent);
      } catch (error) {
        this.logger.warn(`Agent ${agent.id} not responding: ${error.message}`);
        await this.updateAgent(agent.id, { isActive: false });
      }
    }

    return healthyAgents;
  }

  private async pingAgent(agent: A2AAgent): Promise<void> {
    const pingConfig: AxiosRequestConfig = {
      url: `${agent.endpoint}/health`,
      method: 'GET',
      timeout: 5000,
    };

    if (agent.authentication) {
      this.applyAuthentication(pingConfig, agent.authentication);
    }

    await axios(pingConfig);
  }

  private async testAgentConnection(endpoint: string, auth?: any): Promise<void> {
    const testConfig: AxiosRequestConfig = {
      url: endpoint,
      method: 'GET',
      timeout: 10000,
    };

    if (auth) {
      this.applyAuthentication(testConfig, auth);
    }

    try {
      await axios(testConfig);
    } catch (error) {
      throw new BadRequestException(`Cannot connect to agent endpoint: ${error.message}`);
    }
  }

  // Agent Orchestration
  async orchestrateAgents(
    organizationId: string,
    workflow: {
      name: string;
      description?: string;
      steps: Array<{
        agentId: string;
        action: string;
        parameters: Record<string, any>;
        dependencies?: string[];
      }>;
    }
  ): Promise<string> {
    const workflowId = uuidv4();
    
    const a2aWorkflow: A2AWorkflow = {
      id: workflowId,
      name: workflow.name,
      description: workflow.description,
      organizationId,
      steps: workflow.steps.map((step, index) => ({
        id: `step_${index}`,
        name: step.action,
        type: 'agent_call',
        agentId: step.agentId,
        configuration: step.parameters,
        dependencies: step.dependencies,
      })),
      triggers: [
        {
          id: 'manual',
          type: 'manual',
          configuration: {},
          isActive: true,
        },
      ],
      isActive: true,
      metadata: {
        createdAt: new Date().toISOString(),
        totalSteps: workflow.steps.length,
      },
    };

    this.workflows.set(workflowId, a2aWorkflow);

    // Start workflow execution
    await this.executeWorkflow(workflowId);

    return workflowId;
  }

  private async executeWorkflow(workflowId: string): Promise<void> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return;
    }

    // Emit workflow start event
    await this.emitA2AEvent('workflow_triggered', {
      workflowId,
      organizationId: workflow.organizationId,
      data: { name: workflow.name, steps: workflow.steps.length },
    });

    // Execute steps (simplified - in production, would handle dependencies and parallel execution)
    for (const step of workflow.steps) {
      if (step.agentId) {
        const message: A2AMessage = {
          id: uuidv4(),
          fromAgentId: 'workflow_orchestrator',
          toAgentId: step.agentId,
          type: A2AMessageType.FUNCTION_CALL,
          content: {
            function: {
              name: step.name,
              arguments: step.configuration,
            },
          },
          context: {
            organizationId: workflow.organizationId,
            workflowId,
            stepId: step.id,
          },
          metadata: {
            timestamp: new Date().toISOString(),
          },
        };

        await this.deliverMessage(message);
      }
    }
  }

  // A2A Advanced Features
  async createAgentCluster(
    organizationId: string,
    clusterData: {
      name: string;
      agentIds: string[];
      loadBalancing: 'round_robin' | 'random' | 'performance';
      fallback: boolean;
    }
  ): Promise<string> {
    const clusterId = `cluster_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Store cluster configuration in Redis
    await this.redis.setex(
      `cluster:${clusterId}`,
      86400,
      JSON.stringify({
        id: clusterId,
        organizationId,
        ...clusterData,
        createdAt: new Date().toISOString(),
      })
    );

    this.logger.log(`A2A agent cluster created: ${clusterId} with ${clusterData.agentIds.length} agents`);
    
    return clusterId;
  }

  async getAgentMetrics(agentId: string): Promise<A2AMetrics> {
    // Get metrics from Redis
    const metricsKey = `metrics:agent:${agentId}`;
    
    try {
      const cached = await this.redis.get(metricsKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      this.logger.error(`Failed to get agent metrics: ${error.message}`);
    }

    // Default metrics
    return {
      agentId,
      totalMessages: 0,
      successfulMessages: 0,
      failedMessages: 0,
      averageResponseTime: 0,
      lastActivity: new Date(),
      capabilities: {
        functionsUsed: [],
        toolsUsed: [],
        workflowsParticipated: [],
      },
      performance: {
        uptime: 0,
        errorRate: 0,
        throughput: 0,
      },
    };
  }

  // Event handling
  private setupEventHandlers(): void {
    this.on('messageReceived', async (message: A2AMessage) => {
      // Update metrics
      await this.updateAgentMetrics(message.toAgentId, 'message_received');
    });

    this.on('messageSent', async (message: A2AMessage) => {
      // Update metrics
      await this.updateAgentMetrics(message.fromAgentId, 'message_sent');
    });
  }

  private async updateAgentMetrics(agentId: string, eventType: string): Promise<void> {
    const metricsKey = `metrics:agent:${agentId}`;
    
    try {
      const metrics = await this.getAgentMetrics(agentId);
      
      if (eventType === 'message_sent') {
        metrics.totalMessages++;
      } else if (eventType === 'message_received') {
        metrics.successfulMessages++;
      }
      
      metrics.lastActivity = new Date();
      
      await this.redis.setex(metricsKey, 86400, JSON.stringify(metrics));
    } catch (error) {
      this.logger.error(`Failed to update agent metrics: ${error.message}`);
    }
  }

  private async emitA2AEvent(type: string, data: any): Promise<void> {
    const event: A2AEvent = {
      id: uuidv4(),
      type: type as any,
      ...data,
      timestamp: new Date(),
    };

    // Emit for local listeners
    this.emit('a2aEvent', event);

    // Store in Redis for event history
    await this.redis.lpush('a2a:events', JSON.stringify(event));
    await this.redis.ltrim('a2a:events', 0, 1000); // Keep last 1000 events
  }

  // Default configurations
  private getDefaultCapabilities(type: A2AAgentType): any {
    const baseCapabilities = {
      protocols: ['http'],
      messageFormats: ['json'],
      functions: {
        calling: true,
        streaming: false,
        chaining: false,
        parallel: false,
      },
      memory: {
        persistent: false,
        contextWindow: 4096,
        retrieval: false,
      },
    };

    switch (type) {
      case A2AAgentType.OPENAI:
        return {
          ...baseCapabilities,
          functions: { ...baseCapabilities.functions, streaming: true, parallel: true },
          memory: { ...baseCapabilities.memory, contextWindow: 128000 },
          specializations: ['code', 'reasoning', 'analysis'],
        };
        
      case A2AAgentType.ANTHROPIC:
        return {
          ...baseCapabilities,
          functions: { ...baseCapabilities.functions, streaming: true, chaining: true },
          memory: { ...baseCapabilities.memory, contextWindow: 200000 },
          specializations: ['reasoning', 'analysis', 'writing'],
        };
        
      default:
        return baseCapabilities;
    }
  }

  private getDefaultConfiguration(): any {
    return {
      timeout: 30000,
      retries: 3,
      headers: {
        'User-Agent': 'apifai-a2a/1.0.0',
      },
    };
  }

  // Statistics and monitoring
  async getA2AStats(organizationId: string): Promise<{
    totalAgents: number;
    activeAgents: number;
    activeSessions: number;
    totalMessages: number;
    activeWorkflows: number;
  }> {
    // Get ALL agents for organization (both active and inactive)
    const allAgents = Array.from(this.agents.values()).filter(
      agent => agent.organizationId === organizationId
    );
    const activeAgents = allAgents.filter(a => a.isActive);
    const activeSessions = Array.from(this.sessions.values())
      .filter(s => s.organizationId === organizationId && s.status === A2ASessionStatus.ACTIVE);
    const activeWorkflows = Array.from(this.workflows.values())
      .filter(w => w.organizationId === organizationId && w.isActive);

    // Get message count from Redis
    let totalMessages = 0;
    try {
      const messageKeys = await this.redis.keys(`messages:${organizationId}:*`);
      for (const key of messageKeys) {
        const count = await this.redis.llen(key);
        totalMessages += count;
      }
    } catch (error) {
      this.logger.error(`Failed to get message count: ${error.message}`);
    }

    return {
      totalAgents: allAgents.length,
      activeAgents: activeAgents.length,
      activeSessions: activeSessions.length,
      totalMessages,
      activeWorkflows: activeWorkflows.length,
    };
  }

  async shutdown(): Promise<void> {
    // Deregister all agents
    const agentIds = Array.from(this.agents.keys());
    for (const agentId of agentIds) {
      await this.deregisterAgent(agentId);
    }

    this.logger.log('A2A service shutdown complete');
  }
}