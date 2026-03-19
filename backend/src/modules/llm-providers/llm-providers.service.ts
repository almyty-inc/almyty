import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

import { LlmProvider, LlmProviderType, LlmProviderStatus, LlmProviderConfig } from '../../entities/llm-provider.entity';
import { LlmSession, SessionStatus, SessionType } from '../../entities/llm-session.entity';
import { LlmMessage, MessageRole, MessageType, MessageStatus, ToolCall, MessageContent } from '../../entities/llm-message.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool } from '../../entities/tool.entity';
import { ToolExecutorService, ToolExecutionOptions } from '../tools/tool-executor.service';

export interface CreateLlmProviderDto {
  name: string;
  description?: string;
  type: LlmProviderType;
  configuration: LlmProviderConfig;
  capabilities?: LlmProvider['capabilities'];
  metadata?: LlmProvider['metadata'];
}

export interface UpdateLlmProviderDto {
  name?: string;
  description?: string;
  configuration?: Partial<LlmProviderConfig>;
  capabilities?: Partial<LlmProvider['capabilities']>;
  metadata?: Partial<LlmProvider['metadata']>;
}

export interface ChatRequest {
  messages: Array<{
    role: MessageRole;
    content: string | MessageContent[];
    toolCalls?: ToolCall[];
    toolCallId?: string;
  }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, any>;
  }>;
  toolIds?: string[];
  stream?: boolean;
  sessionId?: string;
  gatewayId?: string;
}

export interface ChatResponse {
  message: {
    role: MessageRole;
    content?: string;
    toolCalls?: ToolCall[];
    finishReason?: string;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  cost: number;
  model: string;
  sessionId: string;
  messageId: string;
  cached?: boolean;
  responseTime: number;
}

export interface LlmProviderSearchFilters {
  search?: string;
  type?: LlmProviderType;
  status?: LlmProviderStatus;
  organizationId: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'lastUsedAt' | 'totalRequests';
  sortOrder?: 'ASC' | 'DESC';
}

@Injectable()
export class LlmProvidersService {
  private readonly logger = new Logger(LlmProvidersService.name);

  constructor(
    @InjectRepository(LlmProvider)
    private llmProviderRepository: Repository<LlmProvider>,
    @InjectRepository(LlmSession)
    private llmSessionRepository: Repository<LlmSession>,
    @InjectRepository(LlmMessage)
    private llmMessageRepository: Repository<LlmMessage>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    private toolExecutorService: ToolExecutorService,
  ) {}

  async createProvider(
    createDto: CreateLlmProviderDto,
    organizationId: string,
    userId: string
  ): Promise<LlmProvider> {
    try {
      // Verify organization and user permissions
      const organization = await this.organizationRepository.findOne({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_llm_providers')) {
        throw new ForbiddenException('User does not have permission to manage LLM providers');
      }

      // Validate configuration
      this.validateProviderConfiguration(createDto.type, createDto.configuration);

      // Set default capabilities if not provided
      const capabilities = createDto.capabilities || this.getDefaultCapabilities(createDto.type);

      // Create provider
      const provider = this.llmProviderRepository.create({
        ...createDto,
        organizationId,
        capabilities,
        status: LlmProviderStatus.ACTIVE,
      });

      const savedProvider = await this.llmProviderRepository.save(provider);

      // Perform initial health check
      setTimeout(() => this.performHealthCheck(savedProvider.id), 1000);

      this.logger.log(`LLM provider '${savedProvider.name}' created for organization ${organizationId}`);

      return savedProvider;

    } catch (error) {
      this.logger.error(`Failed to create LLM provider: ${error.message}`);
      throw error;
    }
  }

  async updateProvider(
    providerId: string,
    updateDto: UpdateLlmProviderDto,
    organizationId: string,
    userId: string
  ): Promise<LlmProvider> {
    try {
      const provider = await this.llmProviderRepository.findOne({
        where: { id: providerId, organizationId },
      });

      if (!provider) {
        throw new NotFoundException('LLM provider not found');
      }

      // Check permissions
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'manage_llm_providers')) {
        throw new ForbiddenException('User does not have permission to manage LLM providers');
      }

      // Update configuration
      if (updateDto.configuration) {
        provider.configuration = { ...provider.configuration, ...updateDto.configuration };
        this.validateProviderConfiguration(provider.type, provider.configuration);
      }

      // Update other fields
      if (updateDto.name) provider.name = updateDto.name;
      if (updateDto.description !== undefined) provider.description = updateDto.description;
      if (updateDto.capabilities) {
        provider.capabilities = { ...provider.capabilities, ...updateDto.capabilities };
      }
      if (updateDto.metadata) {
        provider.metadata = { ...provider.metadata, ...updateDto.metadata };
      }

      const updatedProvider = await this.llmProviderRepository.save(provider);

      // Perform health check after update
      setTimeout(() => this.performHealthCheck(provider.id), 1000);

      this.logger.log(`LLM provider '${updatedProvider.name}' updated`);

      return updatedProvider;

    } catch (error) {
      this.logger.error(`Failed to update LLM provider: ${error.message}`);
      throw error;
    }
  }

  async getProvider(
    providerId: string,
    organizationId: string,
    includeSecrets = false
  ): Promise<LlmProvider> {
    const provider = await this.llmProviderRepository.findOne({
      where: { id: providerId, organizationId },
    });

    if (!provider) {
      throw new NotFoundException('LLM provider not found');
    }

    return includeSecrets ? provider : provider.maskSensitiveData() as LlmProvider;
  }

  async getProviders(filters: LlmProviderSearchFilters): Promise<{
    providers: LlmProvider[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const queryBuilder = this.llmProviderRepository
      .createQueryBuilder('provider')
      .where('provider.organizationId = :organizationId', { organizationId: filters.organizationId });

    // Apply filters
    if (filters.search) {
      queryBuilder.andWhere(
        '(provider.name ILIKE :search OR provider.description ILIKE :search)',
        { search: `%${filters.search}%` }
      );
    }

    if (filters.type) {
      queryBuilder.andWhere('provider.type = :type', { type: filters.type });
    }

    if (filters.status) {
      queryBuilder.andWhere('provider.status = :status', { status: filters.status });
    }

    // Apply sorting
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'DESC';
    queryBuilder.orderBy(`provider.${sortBy}`, sortOrder);

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const providers = await queryBuilder
      .skip(skip)
      .take(limit)
      .getMany();

    // Mask sensitive data
    const maskedProviders = providers.map(provider => provider.maskSensitiveData() as LlmProvider);

    const totalPages = Math.ceil(total / limit);

    return {
      providers: maskedProviders,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async deleteProvider(
    providerId: string,
    organizationId: string,
    userId: string
  ): Promise<void> {
    const provider = await this.getProvider(providerId, organizationId);

    // Check permissions
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships'],
    });

    if (!user?.hasPermissionInOrganization(organizationId, 'manage_llm_providers')) {
      throw new ForbiddenException('User does not have permission to manage LLM providers');
    }

    await this.llmProviderRepository.remove(provider);

    this.logger.log(`LLM provider '${provider.name}' deleted`);
  }

  async chat(
    providerId: string,
    request: ChatRequest,
    organizationId: string,
    userId?: string
  ): Promise<ChatResponse> {
    const startTime = Date.now();

    try {
      const provider = await this.getProvider(providerId, organizationId, true);

      if (!provider.isHealthy) {
        throw new BadRequestException('LLM provider is not healthy');
      }

      // Get or create session
      let session: LlmSession;
      if (request.sessionId) {
        session = await this.llmSessionRepository.findOne({
          where: { id: request.sessionId, organizationId },
        });
        if (!session) {
          throw new NotFoundException('Session not found');
        }
      } else {
        session = LlmSession.createSession({
          providerId: provider.id,
          organizationId,
          gatewayId: request.gatewayId,
          userId,
          type: SessionType.CHAT,
          context: {
            model: request.model || provider.configuration.model,
            maxTokens: request.maxTokens || provider.configuration.maxTokens,
            temperature: request.temperature ?? provider.configuration.temperature,
            topP: request.topP ?? provider.configuration.topP,
            topK: request.topK ?? provider.configuration.topK,
            frequencyPenalty: request.frequencyPenalty ?? provider.configuration.frequencyPenalty,
            presencePenalty: request.presencePenalty ?? provider.configuration.presencePenalty,
            stopSequences: request.stopSequences,
            toolsEnabled: (request.tools && request.tools.length > 0) || (request.toolIds && request.toolIds.length > 0),
          },
        });
        session = await this.llmSessionRepository.save(session);
      }

      // Resolve toolIds to tool entities directly if provided
      let tools: Tool[] = [];
      if (request.toolIds && request.toolIds.length > 0) {
        tools = await this.toolRepository.find({
          where: request.toolIds.map(id => ({ id, organizationId })),
        });
      } else {
        // Prepare tools from inline tool definitions
        tools = await this.prepareTools(request.tools || [], organizationId);
      }

      // Make API call to LLM provider
      const response = await this.callLlmProvider(provider, request, session, tools);

      // Process tool calls if present
      if (response.message.toolCalls && response.message.toolCalls.length > 0) {
        await this.executeToolCalls(response.message.toolCalls, session, organizationId);
      }

      // Save message to database
      const message = this.llmMessageRepository.create({
        sessionId: session.id,
        role: response.message.role,
        type: response.message.toolCalls?.length > 0 ? MessageType.TOOL_CALL : MessageType.TEXT,
        content: response.message.content,
        toolCalls: response.message.toolCalls,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cost: Math.round(response.cost),
        responseTime: response.responseTime,
        model: response.model,
        finishReason: response.message.finishReason,
        status: MessageStatus.COMPLETED,
      });

      const savedMessage = await this.llmMessageRepository.save(message);

      // Update session stats
      session.addMessage(response.usage.inputTokens, response.usage.outputTokens, Math.round(response.cost));
      if (response.message.toolCalls?.length > 0) {
        session.addToolCall(true);
      }
      await this.llmSessionRepository.save(session);

      // Update provider stats
      provider.incrementUsage(response.usage.totalTokens, Math.round(response.cost), true);
      await this.llmProviderRepository.save(provider);

      return {
        ...response,
        sessionId: session.id,
        messageId: savedMessage.id,
      };

    } catch (error) {
      this.logger.error(`Chat request failed: ${error.message}`, error.stack);
      
      // Update provider error stats
      try {
        const provider = await this.getProvider(providerId, organizationId, true);
        provider.incrementUsage(0, 0, false);
        await this.llmProviderRepository.save(provider);
      } catch (updateError) {
        this.logger.warn(`Failed to update provider error stats: ${updateError.message}`);
      }

      throw error;
    }
  }

  private async callLlmProvider(
    provider: LlmProvider,
    request: ChatRequest,
    session: LlmSession,
    tools: Tool[]
  ): Promise<ChatResponse> {
    const startTime = Date.now();

    try {
      switch (provider.type) {
        case LlmProviderType.OPENAI:
        case LlmProviderType.AZURE_OPENAI:
        case LlmProviderType.MISTRAL:
        case LlmProviderType.XAI:
        case LlmProviderType.DEEPSEEK:
        case LlmProviderType.GROQ:
        case LlmProviderType.TOGETHER:
        case LlmProviderType.OPENROUTER:
          return this.callOpenAI(provider, request, session, tools, startTime);
        case LlmProviderType.ANTHROPIC:
          return this.callAnthropic(provider, request, session, tools, startTime);
        case LlmProviderType.GOOGLE:
          return this.callGoogle(provider, request, session, tools, startTime);
        case LlmProviderType.COHERE:
          return this.callCohere(provider, request, session, tools, startTime);
        case LlmProviderType.HUGGINGFACE:
          return this.callHuggingFace(provider, request, session, tools, startTime);
        case LlmProviderType.CUSTOM:
          return this.callCustomProvider(provider, request, session, tools, startTime);
        default:
          throw new BadRequestException(`Unsupported LLM provider type: ${provider.type}`);
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.logger.error(`LLM provider call failed after ${responseTime}ms: ${error.message}`);
      throw error;
    }
  }

  private async callOpenAI(
    provider: LlmProvider,
    request: ChatRequest,
    session: LlmSession,
    tools: Tool[],
    startTime: number
  ): Promise<ChatResponse> {
    const apiUrl = provider.getApiUrl();
    const headers = provider.getAuthHeaders();

    // Prepare OpenAI request
    const openaiRequest: any = {
      model: request.model || provider.configuration.model || 'gpt-4o',
      messages: request.messages.map(msg => {
        const openaiMsg: any = {
          role: msg.role,
          content: msg.content,
        };

        if (msg.toolCalls?.length > 0) {
          openaiMsg.tool_calls = msg.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.parameters),
            },
          }));
        }

        if (msg.toolCallId) {
          openaiMsg.tool_call_id = msg.toolCallId;
        }

        return openaiMsg;
      }),
      max_tokens: request.maxTokens || session.context?.maxTokens,
      temperature: request.temperature ?? session.context?.temperature,
      top_p: request.topP ?? session.context?.topP,
      frequency_penalty: request.frequencyPenalty ?? session.context?.frequencyPenalty,
      presence_penalty: request.presencePenalty ?? session.context?.presencePenalty,
      stop: request.stopSequences || session.context?.stopSequences,
      stream: request.stream || false,
    };

    // Add tools if available
    if (tools.length > 0) {
      openaiRequest.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: `${apiUrl}/chat/completions`,
      headers,
      data: openaiRequest,
      timeout: provider.configuration.timeout || 30000,
    };

    const response: AxiosResponse = await axios(config);
    const responseTime = Date.now() - startTime;

    const choice = response.data.choices[0];
    const usage = response.data.usage;
    
    const cost = this.calculateProviderCost(provider, usage.prompt_tokens, usage.completion_tokens);

    // Process tool calls
    let toolCalls: ToolCall[] = [];
    if (choice.message.tool_calls) {
      toolCalls = choice.message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        parameters: JSON.parse(tc.function.arguments),
      }));
    }

    return {
      message: {
        role: MessageRole.ASSISTANT,
        content: choice.message.content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: choice.finish_reason,
      },
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      },
      cost,
      model: response.data.model,
      sessionId: session.id,
      messageId: '',
      responseTime,
    };
  }

  private async callAnthropic(
    provider: LlmProvider,
    request: ChatRequest,
    session: LlmSession,
    tools: Tool[],
    startTime: number
  ): Promise<ChatResponse> {
    const apiUrl = provider.getApiUrl();
    const headers = provider.getAuthHeaders();

    // Extract system messages for Anthropic's system parameter
    const systemMessages = request.messages.filter(msg => msg.role === MessageRole.SYSTEM || msg.role === 'system' as any);
    const nonSystemMessages = request.messages.filter(msg => msg.role !== MessageRole.SYSTEM && msg.role !== 'system' as any);

    // Prepare Anthropic request
    const anthropicRequest: any = {
      model: request.model || provider.configuration.model || 'claude-sonnet-4-20250514',
      max_tokens: request.maxTokens || session.context?.maxTokens || 1024,
      temperature: request.temperature ?? session.context?.temperature,
      top_p: request.topP ?? session.context?.topP,
      stop_sequences: request.stopSequences || session.context?.stopSequences,
      messages: nonSystemMessages.map(msg => ({
        role: msg.role === MessageRole.ASSISTANT ? 'assistant' : 'user',
        content: msg.content,
      })),
    };

    // Add system prompt if present
    if (systemMessages.length > 0) {
      anthropicRequest.system = systemMessages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    }

    // Add tools if available
    if (tools.length > 0) {
      anthropicRequest.tools = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: `${apiUrl}/messages`,
      headers,
      data: anthropicRequest,
      timeout: provider.configuration.timeout || 30000,
    };

    const response: AxiosResponse = await axios(config);
    const responseTime = Date.now() - startTime;

    const usage = response.data.usage;
    
    const cost = this.calculateProviderCost(provider, usage.input_tokens, usage.output_tokens);

    // Process tool use
    let toolCalls: ToolCall[] = [];
    if (response.data.content) {
      const toolUseContent = response.data.content.find(c => c.type === 'tool_use');
      if (toolUseContent) {
        toolCalls = [{
          id: toolUseContent.id,
          name: toolUseContent.name,
          parameters: toolUseContent.input,
        }];
      }
    }

    const textContent = response.data.content
      ?.filter(c => c.type === 'text')
      ?.map(c => c.text)
      ?.join(' ') || '';

    return {
      message: {
        role: MessageRole.ASSISTANT,
        content: textContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: response.data.stop_reason,
      },
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.input_tokens + usage.output_tokens,
      },
      cost,
      model: response.data.model,
      sessionId: session.id,
      messageId: '',
      responseTime,
    };
  }

  private async callGoogle(
    provider: LlmProvider,
    request: ChatRequest,
    session: LlmSession,
    tools: Tool[],
    startTime: number
  ): Promise<ChatResponse> {
    // Google Gemini API implementation
    const apiUrl = provider.getApiUrl();
    const apiKey = provider.configuration.apiKey;

    const googleRequest: any = {
      contents: request.messages.map(msg => ({
        role: msg.role === MessageRole.USER ? 'user' : 'model',
        parts: [{ text: msg.content }],
      })),
      generationConfig: {
        maxOutputTokens: request.maxTokens || session.context?.maxTokens,
        temperature: request.temperature ?? session.context?.temperature,
        topP: request.topP ?? session.context?.topP,
        topK: request.topK ?? session.context?.topK,
      },
    };

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: `${apiUrl}/models/${request.model || 'gemini-pro'}:generateContent?key=${apiKey}`,
      headers: {
        'Content-Type': 'application/json',
      },
      data: googleRequest,
      timeout: provider.configuration.timeout || 30000,
    };

    const response: AxiosResponse = await axios(config);
    const responseTime = Date.now() - startTime;

    const candidate = response.data.candidates?.[0];
    const content = candidate?.content?.parts?.[0]?.text || '';
    const usage = response.data.usageMetadata || {};
    
    const cost = this.calculateProviderCost(provider, usage.promptTokenCount || 0, usage.candidatesTokenCount || 0);

    return {
      message: {
        role: MessageRole.ASSISTANT,
        content,
        finishReason: candidate?.finishReason,
      },
      usage: {
        inputTokens: usage.promptTokenCount || 0,
        outputTokens: usage.candidatesTokenCount || 0,
        totalTokens: usage.totalTokenCount || 0,
      },
      cost,
      model: request.model || 'gemini-pro',
      sessionId: session.id,
      messageId: '',
      responseTime,
    };
  }

  private async callCohere(
    provider: LlmProvider,
    request: ChatRequest,
    session: LlmSession,
    tools: Tool[],
    startTime: number
  ): Promise<ChatResponse> {
    // Cohere API implementation - simplified
    const apiUrl = provider.getApiUrl();
    const headers = provider.getAuthHeaders();

    const lastMessage = request.messages[request.messages.length - 1];
    const chatHistory = request.messages.slice(0, -1).map(msg => ({
      role: msg.role === MessageRole.USER ? 'USER' : 'CHATBOT',
      message: msg.content,
    }));

    const cohereRequest: any = {
      model: request.model || provider.configuration.model || 'command',
      message: lastMessage.content,
      chat_history: chatHistory,
      max_tokens: request.maxTokens || session.context?.maxTokens,
      temperature: request.temperature ?? session.context?.temperature,
      p: request.topP ?? session.context?.topP,
      k: request.topK ?? session.context?.topK,
      frequency_penalty: request.frequencyPenalty ?? session.context?.frequencyPenalty,
      presence_penalty: request.presencePenalty ?? session.context?.presencePenalty,
      stop_sequences: request.stopSequences || session.context?.stopSequences,
    };

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: `${apiUrl}/chat`,
      headers,
      data: cohereRequest,
      timeout: provider.configuration.timeout || 30000,
    };

    const response: AxiosResponse = await axios(config);
    const responseTime = Date.now() - startTime;

    const inputTokens = JSON.stringify(cohereRequest).length / 4;
    const outputTokens = response.data.text?.length / 4 || 0;
    const cost = this.calculateProviderCost(provider, inputTokens, outputTokens);

    return {
      message: {
        role: MessageRole.ASSISTANT,
        content: response.data.text,
        finishReason: response.data.finish_reason,
      },
      usage: {
        inputTokens: Math.round(inputTokens),
        outputTokens: Math.round(outputTokens),
        totalTokens: Math.round(inputTokens + outputTokens),
      },
      cost,
      model: cohereRequest.model,
      sessionId: session.id,
      messageId: '',
      responseTime,
    };
  }

  private async callHuggingFace(
    provider: LlmProvider,
    request: ChatRequest,
    session: LlmSession,
    tools: Tool[],
    startTime: number
  ): Promise<ChatResponse> {
    // HuggingFace Inference API implementation
    const apiUrl = provider.getApiUrl();
    const headers = provider.getAuthHeaders();

    const prompt = request.messages.map(msg => `${msg.role}: ${msg.content}`).join('\n') + '\nassistant:';

    const hfRequest: any = {
      inputs: prompt,
      parameters: {
        max_new_tokens: request.maxTokens || session.context?.maxTokens || 100,
        temperature: request.temperature ?? session.context?.temperature ?? 0.7,
        top_p: request.topP ?? session.context?.topP,
        top_k: request.topK ?? session.context?.topK,
        repetition_penalty: (request.frequencyPenalty || 0) + 1,
        stop_sequences: request.stopSequences || session.context?.stopSequences,
      },
    };

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: `${apiUrl}/${request.model || provider.configuration.model}`,
      headers,
      data: hfRequest,
      timeout: provider.configuration.timeout || 30000,
    };

    const response: AxiosResponse = await axios(config);
    const responseTime = Date.now() - startTime;

    let content = '';
    if (Array.isArray(response.data) && response.data.length > 0) {
      content = response.data[0].generated_text || '';
      // Remove the original prompt from the response
      content = content.replace(prompt, '').trim();
    }

    // Approximate token counting (no usage info from HF)
    const inputTokens = prompt.length / 4;
    const outputTokens = content.length / 4;
    const cost = 0; // HuggingFace Inference API is often free

    return {
      message: {
        role: MessageRole.ASSISTANT,
        content,
        finishReason: 'stop',
      },
      usage: {
        inputTokens: Math.round(inputTokens),
        outputTokens: Math.round(outputTokens),
        totalTokens: Math.round(inputTokens + outputTokens),
      },
      cost,
      model: request.model || provider.configuration.model || 'unknown',
      sessionId: session.id,
      messageId: '',
      responseTime,
    };
  }

  private async callCustomProvider(
    provider: LlmProvider,
    request: ChatRequest,
    session: LlmSession,
    tools: Tool[],
    startTime: number
  ): Promise<ChatResponse> {
    // Custom provider implementation
    const apiUrl = provider.getApiUrl();
    const headers = provider.getAuthHeaders();

    let requestData: any;
    
    // Format based on custom configuration
    const requestFormat = provider.configuration.custom?.requestFormat || 'openai';
    
    if (requestFormat === 'openai') {
      requestData = {
        model: request.model || provider.configuration.model,
        messages: request.messages,
        max_tokens: request.maxTokens || session.context?.maxTokens,
        temperature: request.temperature ?? session.context?.temperature,
      };
    } else if (requestFormat === 'anthropic') {
      requestData = {
        model: request.model || provider.configuration.model,
        messages: request.messages,
        max_tokens: request.maxTokens || session.context?.maxTokens,
        temperature: request.temperature ?? session.context?.temperature,
      };
    } else {
      // Custom format
      requestData = {
        prompt: request.messages.map(m => m.content).join('\n'),
        max_tokens: request.maxTokens || session.context?.maxTokens,
        temperature: request.temperature ?? session.context?.temperature,
      };
    }

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: apiUrl,
      headers,
      data: requestData,
      timeout: provider.configuration.timeout || 30000,
    };

    const response: AxiosResponse = await axios(config);
    const responseTime = Date.now() - startTime;

    // Try to parse response based on common formats
    let content = '';
    let usage = { inputTokens: 0, outputTokens: 0 };
    
    if (response.data.choices && response.data.choices[0]) {
      // OpenAI format
      content = response.data.choices[0].message?.content || response.data.choices[0].text || '';
      if (response.data.usage) {
        usage = {
          inputTokens: response.data.usage.prompt_tokens || 0,
          outputTokens: response.data.usage.completion_tokens || 0,
        };
      }
    } else if (response.data.content) {
      // Anthropic format
      content = Array.isArray(response.data.content) 
        ? response.data.content.map(c => c.text).join('')
        : response.data.content;
      if (response.data.usage) {
        usage = {
          inputTokens: response.data.usage.input_tokens || 0,
          outputTokens: response.data.usage.output_tokens || 0,
        };
      }
    } else if (response.data.text || response.data.response) {
      // Generic text response
      content = response.data.text || response.data.response || '';
    }

    // Fallback token counting
    if (usage.inputTokens === 0) {
      usage.inputTokens = Math.round(JSON.stringify(requestData).length / 4);
    }
    if (usage.outputTokens === 0) {
      usage.outputTokens = Math.round(content.length / 4);
    }

    return {
      message: {
        role: MessageRole.ASSISTANT,
        content,
        finishReason: 'stop',
      },
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
      },
      cost: 0, // Custom providers would need their own cost calculation
      model: request.model || provider.configuration.model || 'custom',
      sessionId: session.id,
      messageId: '',
      responseTime,
    };
  }

  private async prepareTools(
    requestTools: ChatRequest['tools'],
    organizationId: string
  ): Promise<Tool[]> {
    if (!requestTools || requestTools.length === 0) {
      return [];
    }

    // Find tools by name in the organization
    const toolNames = requestTools.map(t => t.name);
    const tools = await this.toolRepository.find({
      where: {
        name: requestTools.length === 1 ? requestTools[0].name : undefined,
      },
    });

    return tools.filter(tool => toolNames.includes(tool.name));
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    session: LlmSession,
    organizationId: string
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      try {
        // Find the tool
        const tool = await this.toolRepository.findOne({
          where: { name: toolCall.name },
        });

        if (!tool) {
          toolCall.error = `Tool '${toolCall.name}' not found`;
          continue;
        }

        // Execute the tool
        const executionOptions: ToolExecutionOptions = {
          userId: session.userId || 'system',
          organizationId,
        };

        const result = await this.toolExecutorService.executeTool(
          tool.id,
          toolCall.parameters,
          executionOptions
        );

        toolCall.result = result.data;
        toolCall.error = result.success ? undefined : result.error;
        toolCall.executionTime = result.executionTime;
        toolCall.cached = result.cached;

      } catch (error) {
        toolCall.error = error.message;
      }
    }
  }

  private validateProviderConfiguration(type: LlmProviderType, config: LlmProviderConfig): void {
    switch (type) {
      case LlmProviderType.OPENAI:
      case LlmProviderType.ANTHROPIC:
      case LlmProviderType.GOOGLE:
      case LlmProviderType.MISTRAL:
      case LlmProviderType.XAI:
      case LlmProviderType.DEEPSEEK:
      case LlmProviderType.GROQ:
      case LlmProviderType.TOGETHER:
      case LlmProviderType.OPENROUTER:
      case LlmProviderType.COHERE:
      case LlmProviderType.HUGGINGFACE:
        if (!config.apiKey) {
          throw new BadRequestException(`${type} provider requires an API key`);
        }
        break;

      case LlmProviderType.AZURE_OPENAI:
        if (!config.apiKey || !config.azure?.resourceName || !config.azure?.deploymentName) {
          throw new BadRequestException('Azure OpenAI provider requires API key, resource name, and deployment name');
        }
        break;

      case LlmProviderType.AWS_BEDROCK:
        if (!config.bedrock?.region) {
          throw new BadRequestException('AWS Bedrock provider requires region');
        }
        break;

      case LlmProviderType.CUSTOM:
        if (!config.apiUrl) {
          throw new BadRequestException('Custom provider requires API URL');
        }
        break;
    }
  }

  /**
   * Fetch available models dynamically from the provider's API.
   * Falls back to hardcoded defaults if the API call fails.
   */
  async fetchModelsFromProvider(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    try {
      switch (provider.type) {
        case LlmProviderType.OPENAI:
        case LlmProviderType.MISTRAL:
        case LlmProviderType.XAI:
        case LlmProviderType.DEEPSEEK:
        case LlmProviderType.GROQ:
        case LlmProviderType.TOGETHER:
        case LlmProviderType.OPENROUTER:
          return this.fetchOpenAIModels(provider);
        case LlmProviderType.ANTHROPIC:
          return this.fetchAnthropicModels(provider);
        case LlmProviderType.GOOGLE:
          return this.fetchGoogleModels(provider);
        default:
          // For other providers, return the hardcoded defaults
          return this.getDefaultCapabilities(provider.type).supportedModels.map(m => ({
            id: m,
            name: m,
          }));
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch models from ${provider.type} API: ${error.message}`);
      // Fallback to hardcoded defaults
      return this.getDefaultCapabilities(provider.type).supportedModels.map(m => ({
        id: m,
        name: m,
      }));
    }
  }

  private async fetchOpenAIModels(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    const apiUrl = provider.configuration.apiUrl || 'https://api.openai.com/v1';
    const response = await axios.get(`${apiUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${provider.configuration.apiKey}`,
      },
      timeout: 10000,
    });

    const models = response.data?.data || [];

    // Filter to chat-compatible models and sort by created date (newest first)
    const isOpenAI = provider.type === LlmProviderType.OPENAI;
    const chatModels = models
      .filter((m: any) => {
        const id = m.id?.toLowerCase() || '';
        // Always exclude non-chat models
        if (id.includes('embedding') || id.includes('whisper') || id.includes('tts')
          || id.includes('dall-e') || id.includes('realtime') || id.includes('moderation')) {
          return false;
        }
        // For OpenAI specifically, only include GPT and o-series models
        if (isOpenAI) {
          return id.includes('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4');
        }
        // For other OpenAI-compatible providers, include all non-excluded models
        return true;
      })
      .sort((a: any, b: any) => (b.created || 0) - (a.created || 0))
      .map((m: any) => ({
        id: m.id,
        name: m.id,
        created: m.created,
        owned_by: m.owned_by,
      }));

    return chatModels;
  }

  private async fetchAnthropicModels(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    const apiUrl = provider.configuration.apiUrl || 'https://api.anthropic.com/v1';
    const response = await axios.get(`${apiUrl}/models`, {
      headers: {
        'x-api-key': provider.configuration.apiKey,
        'anthropic-version': provider.configuration.apiVersion || '2023-06-01',
      },
      timeout: 10000,
    });

    const models = response.data?.data || [];

    return models
      .sort((a: any, b: any) => {
        // Sort by created_at descending (newest first)
        const aDate = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bDate = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bDate - aDate;
      })
      .map((m: any) => ({
        id: m.id,
        name: m.display_name || m.id,
        created: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : undefined,
        owned_by: 'anthropic',
      }));
  }

  private async fetchGoogleModels(provider: LlmProvider): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    const apiKey = provider.configuration.apiKey;
    const response = await axios.get(
      `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
      { timeout: 10000 }
    );

    const models = response.data?.models || [];

    return models
      .filter((m: any) => {
        // Only include generative models
        const methods = m.supportedGenerationMethods || [];
        return methods.includes('generateContent');
      })
      .map((m: any) => ({
        id: m.name?.replace('models/', '') || m.name,
        name: m.displayName || m.name,
        owned_by: 'google',
      }));
  }

  /**
   * Fetch models by provider type and API key without needing a saved provider.
   * Used during provider creation to show available models before the provider is saved.
   */
  async fetchModelsByType(type: LlmProviderType, apiKey: string): Promise<Array<{
    id: string;
    name: string;
    created?: number;
    owned_by?: string;
  }>> {
    // Create a temporary provider-like object
    const tempProvider = new LlmProvider();
    tempProvider.type = type;
    tempProvider.configuration = { apiKey };

    return this.fetchModelsFromProvider(tempProvider);
  }

  private getDefaultCapabilities(type: LlmProviderType): LlmProvider['capabilities'] {
    const baseCapabilities = {
      supportedModels: [],
      maxTokens: 4096,
      supportsFunctionCalling: false,
      supportsStreaming: false,
      supportsBatching: false,
      supportsVision: false,
      supportsAudio: false,
      supportsToolUse: false,
      supportedToolFormats: [],
    };

    // Models are fetched dynamically from provider APIs via fetchModelsFromProvider().
    // These defaults only define capability flags — supportedModels is intentionally
    // empty because the real list comes from the API at runtime.
    const openaiCompatible = {
      ...baseCapabilities,
      supportedModels: [],
      supportsFunctionCalling: true,
      supportsStreaming: true,
      supportsToolUse: true,
      supportedToolFormats: ['openai'],
    };

    switch (type) {
      case LlmProviderType.OPENAI:
        return { ...openaiCompatible, maxTokens: 128000, supportsVision: true };

      case LlmProviderType.ANTHROPIC:
        return {
          ...baseCapabilities,
          supportedModels: [],
          maxTokens: 200000,
          supportsStreaming: true,
          supportsVision: true,
          supportsToolUse: true,
          supportedToolFormats: ['anthropic'],
        };

      case LlmProviderType.GOOGLE:
        return {
          ...baseCapabilities,
          supportedModels: [],
          maxTokens: 1000000,
          supportsStreaming: true,
          supportsVision: true,
          supportsToolUse: true,
          supportedToolFormats: ['google'],
        };

      case LlmProviderType.MISTRAL:
        return { ...openaiCompatible, maxTokens: 128000 };

      case LlmProviderType.XAI:
        return { ...openaiCompatible, maxTokens: 131072, supportsVision: true };

      case LlmProviderType.DEEPSEEK:
        return { ...openaiCompatible, maxTokens: 64000 };

      case LlmProviderType.GROQ:
        return { ...openaiCompatible, maxTokens: 131072 };

      case LlmProviderType.TOGETHER:
        return { ...openaiCompatible, maxTokens: 131072 };

      case LlmProviderType.OPENROUTER:
        return { ...openaiCompatible, maxTokens: 200000, supportsVision: true };

      case LlmProviderType.AZURE_OPENAI:
        return { ...openaiCompatible, maxTokens: 128000, supportsVision: true };

      case LlmProviderType.AWS_BEDROCK:
        return { ...baseCapabilities, supportedModels: [], maxTokens: 200000 };

      case LlmProviderType.COHERE:
        return { ...openaiCompatible, maxTokens: 128000 };

      case LlmProviderType.HUGGINGFACE:
        return { ...baseCapabilities, supportedModels: [], supportsStreaming: true };

      default:
        return baseCapabilities;
    }
  }

  private calculateProviderCost(provider: LlmProvider, inputTokens: number, outputTokens: number): number {
    // Use the provider's configured pricing from metadata. If no pricing is set, return 0.
    // Users set pricing via provider metadata or it can be fetched from provider APIs.
    const modelInfo = provider.metadata?.modelInfo;
    if (modelInfo?.inputTokenCost && modelInfo?.outputTokenCost) {
      return ((inputTokens / 1000) * modelInfo.inputTokenCost) + ((outputTokens / 1000) * modelInfo.outputTokenCost);
    }
    return 0;
  }


  async performHealthCheck(providerId: string): Promise<{
    isHealthy: boolean;
    responseTime?: number;
    error?: string;
    details?: Record<string, any>;
  }> {
    try {
      const provider = await this.llmProviderRepository.findOne({
        where: { id: providerId },
      });

      if (!provider) {
        return { isHealthy: false, error: 'Provider not found' };
      }

      const startTime = Date.now();

      // Perform a simple health check request
      const testRequest: ChatRequest = {
        messages: [{ role: MessageRole.USER, content: 'Hello' }],
        maxTokens: 10,
        temperature: 0.1,
      };

      const session = LlmSession.createSession({
        providerId: provider.id,
        organizationId: provider.organizationId,
        type: SessionType.CHAT,
        title: 'Health Check',
      });

      const response = await this.callLlmProvider(provider, testRequest, session, []);
      const responseTime = Date.now() - startTime;

      // Update provider health status
      provider.updateHealthStatus(true);
      await this.llmProviderRepository.save(provider);

      return {
        isHealthy: true,
        responseTime,
        details: {
          model: response.model,
          tokenUsage: response.usage.totalTokens,
          cost: response.cost,
        },
      };

    } catch (error) {
      const responseTime = Date.now() - Date.now();

      // Update provider health status
      try {
        const provider = await this.llmProviderRepository.findOne({
          where: { id: providerId },
        });
        if (provider) {
          provider.updateHealthStatus(false, error.message);
          await this.llmProviderRepository.save(provider);
        }
      } catch (updateError) {
        this.logger.warn(`Failed to update provider health status: ${updateError.message}`);
      }

      return {
        isHealthy: false,
        responseTime,
        error: error.message,
      };
    }
  }

  // Session management methods
  async createSession(
    providerId: string,
    organizationId: string,
    userId?: string,
    sessionData?: Partial<LlmSession>
  ): Promise<LlmSession> {
    const provider = await this.getProvider(providerId, organizationId);

    const session = LlmSession.createSession({
      providerId: provider.id,
      organizationId,
      userId,
      ...sessionData,
    });

    return this.llmSessionRepository.save(session);
  }

  async getSession(sessionId: string, organizationId: string): Promise<LlmSession> {
    const session = await this.llmSessionRepository.findOne({
      where: { id: sessionId, organizationId },
      relations: ['provider', 'messages'],
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    return session;
  }

  async getSessions(
    organizationId: string,
    providerId?: string,
    userId?: string,
    status?: SessionStatus,
    page = 1,
    limit = 20
  ): Promise<{
    sessions: LlmSession[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const skip = (page - 1) * limit;
    
    const queryBuilder = this.llmSessionRepository
      .createQueryBuilder('session')
      .leftJoinAndSelect('session.provider', 'provider')
      .where('session.organizationId = :organizationId', { organizationId });

    if (providerId) {
      queryBuilder.andWhere('session.providerId = :providerId', { providerId });
    }

    if (userId) {
      queryBuilder.andWhere('session.userId = :userId', { userId });
    }

    if (status) {
      queryBuilder.andWhere('session.status = :status', { status });
    }

    queryBuilder.orderBy('session.createdAt', 'DESC');

    const total = await queryBuilder.getCount();
    const sessions = await queryBuilder.skip(skip).take(limit).getMany();

    return {
      sessions,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async updateSession(
    sessionId: string,
    organizationId: string,
    updates: Partial<{
      status: SessionStatus;
      title: string;
      context: LlmSession['context'];
      metadata: LlmSession['metadata'];
    }>
  ): Promise<LlmSession> {
    const session = await this.getSession(sessionId, organizationId);

    Object.assign(session, updates);

    return this.llmSessionRepository.save(session);
  }

  async deleteSession(sessionId: string, organizationId: string): Promise<void> {
    const session = await this.getSession(sessionId, organizationId);
    await this.llmSessionRepository.remove(session);
  }
}