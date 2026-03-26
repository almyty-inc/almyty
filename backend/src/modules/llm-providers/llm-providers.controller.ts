import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  ValidationPipe,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsObject, IsArray, IsNumber, Min, Max, IsBoolean } from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { LlmProvidersService, CreateLlmProviderDto, UpdateLlmProviderDto, ChatRequest, LlmProviderSearchFilters } from './llm-providers.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { LlmProviderType, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { MessageRole, MessageContent } from '../../entities/llm-message.entity';
import { SessionStatus, SessionType } from '../../entities/llm-session.entity';

class CreateLlmProviderBodyDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(LlmProviderType)
  type: LlmProviderType;

  @IsObject()
  configuration: {
    apiKey?: string;
    apiUrl?: string;
    apiVersion?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    timeout?: number;
    retries?: number;
    rateLimits?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
      tokensPerMinute?: number;
      tokensPerHour?: number;
    };
    azure?: {
      deploymentName?: string;
      resourceName?: string;
      apiVersion?: string;
    };
    bedrock?: {
      region?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
    };
    huggingface?: {
      endpoint?: string;
      taskType?: string;
    };
    custom?: {
      headers?: Record<string, string>;
      authMethod?: 'bearer' | 'api_key' | 'custom';
      requestFormat?: 'openai' | 'anthropic' | 'custom';
    };
  };

  @IsOptional()
  @IsObject()
  capabilities?: {
    supportedModels?: string[];
    maxTokens?: number;
    supportsFunctionCalling?: boolean;
    supportsStreaming?: boolean;
    supportsBatching?: boolean;
    supportsVision?: boolean;
    supportsAudio?: boolean;
    supportsToolUse?: boolean;
    supportedToolFormats?: string[];
  };

  @IsOptional()
  @IsObject()
  metadata?: {
    version?: string;
    region?: string;
    endpoint?: string;
    modelInfo?: {
      contextWindow?: number;
      inputTokenCost?: number;
      outputTokenCost?: number;
      currency?: string;
    };
  };
}

class UpdateLlmProviderBodyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  configuration?: Partial<CreateLlmProviderBodyDto['configuration']>;

  @IsOptional()
  @IsObject()
  capabilities?: Partial<CreateLlmProviderBodyDto['capabilities']>;

  @IsOptional()
  @IsObject()
  metadata?: Partial<CreateLlmProviderBodyDto['metadata']>;
}

class ChatMessageDto {
  @IsEnum(MessageRole)
  role: MessageRole;

  @IsString()
  content: string | MessageContent[];

  @IsOptional()
  @IsArray()
  toolCalls?: Array<{
    id: string;
    name: string;
    parameters: Record<string, any>;
  }>;

  @IsOptional()
  @IsString()
  toolCallId?: string;
}

class ChatRequestBodyDto {
  @IsArray()
  messages: ChatMessageDto[];

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(200000)
  maxTokens?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  topP?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  topK?: number;

  @IsOptional()
  @IsNumber()
  @Min(-2)
  @Max(2)
  frequencyPenalty?: number;

  @IsOptional()
  @IsNumber()
  @Min(-2)
  @Max(2)
  presencePenalty?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  stopSequences?: string[];

  @IsOptional()
  @IsArray()
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, any>;
  }>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  toolIds?: string[];

  @IsOptional()
  @IsBoolean()
  stream?: boolean;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  gatewayId?: string;
}

class CreateSessionDto {
  @IsOptional()
  @IsEnum(SessionType)
  type?: SessionType;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsObject()
  context?: {
    model?: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
    toolsEnabled?: boolean;
    availableTools?: string[];
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

class UpdateSessionDto {
  @IsOptional()
  @IsEnum(SessionStatus)
  status?: SessionStatus;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsObject()
  context?: CreateSessionDto['context'];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

class LlmProviderSearchQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(LlmProviderType)
  type?: LlmProviderType;

  @IsOptional()
  @IsEnum(LlmProviderStatus)
  status?: LlmProviderStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsEnum(['name', 'createdAt', 'lastUsedAt', 'totalRequests'])
  sortBy?: 'name' | 'createdAt' | 'lastUsedAt' | 'totalRequests';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

@Controller('llm-providers')
@ApiTags('LLM Providers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class LlmProvidersController {
  constructor(
    private readonly llmProvidersService: LlmProvidersService,
  ) {}

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a new LLM provider' })
  @ApiResponse({ status: 201, description: 'LLM provider created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async createProvider(
    @Body(ValidationPipe) createDto: CreateLlmProviderBodyDto,
    @Request() req: any,
  ) {
    try {
      // Get organizationId from user's JWT token (first organization)
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          {
            success: false,
            message: 'No organization found for user',
            error: 'NO_ORGANIZATION',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const provider = await this.llmProvidersService.createProvider(
        createDto as CreateLlmProviderDto,
        organizationId,
        req.user.id
      );

      return {
        success: true,
        data: provider.toPublicView(),
        message: 'LLM provider created successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'PROVIDER_CREATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get all LLM providers for organization' })
  @ApiResponse({ status: 200, description: 'LLM providers retrieved successfully' })
  async getProviders(
    @Query(ValidationPipe) query: LlmProviderSearchQueryDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const filters: LlmProviderSearchFilters = {
        ...query,
        organizationId,
      };

      const result = await this.llmProvidersService.getProviders(filters);

      return {
        success: true,
        data: result,
        message: 'LLM providers retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'PROVIDERS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':providerId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get LLM provider by ID' })
  @ApiResponse({ status: 200, description: 'LLM provider retrieved successfully' })
  @ApiResponse({ status: 404, description: 'LLM provider not found' })
  async getProvider(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Query('includeSecrets') includeSecrets: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const showSecrets = includeSecrets === 'true';

      // Only admins/owners can see secrets
      const user = req.user;
      const canViewSecrets = showSecrets && user.roles &&
        (user.roles.includes('admin') || user.roles.includes('owner'));

      const provider = await this.llmProvidersService.getProvider(
        providerId,
        organizationId,
        canViewSecrets
      );

      return {
        success: true,
        data: provider,
        message: 'LLM provider retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'PROVIDER_NOT_FOUND',
        },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  @Get(':providerId/usage')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get LLM provider usage stats' })
  async getProviderUsage(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Request() req: any,
  ) {
    const organizationId = req.user.organizations?.[0]?.id;
    const provider = await this.llmProvidersService.getProvider(providerId, organizationId);
    return {
      success: true,
      data: {
        totalRequests: provider.totalRequests || 0,
        successfulRequests: provider.successfulRequests || 0,
        failedRequests: (provider.totalRequests || 0) - (provider.successfulRequests || 0),
        totalTokensUsed: provider.totalTokensUsed || 0,
        totalCost: provider.totalCost || 0,
        lastRequestAt: provider.lastRequestAt,
        successRate: provider.totalRequests > 0
          ? ((provider.successfulRequests / provider.totalRequests) * 100).toFixed(1)
          : '0',
      },
      message: 'Usage stats retrieved',
    };
  }

  @Patch(':providerId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update LLM provider' })
  @ApiResponse({ status: 200, description: 'LLM provider updated successfully' })
  @ApiResponse({ status: 404, description: 'LLM provider not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async updateProvider(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body(ValidationPipe) updateDto: UpdateLlmProviderBodyDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const provider = await this.llmProvidersService.updateProvider(
        providerId,
        updateDto as UpdateLlmProviderDto,
        organizationId,
        req.user.id
      );

      return {
        success: true,
        data: provider.toPublicView(),
        message: 'LLM provider updated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'PROVIDER_UPDATE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':providerId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Delete LLM provider' })
  @ApiResponse({ status: 200, description: 'LLM provider deleted successfully' })
  @ApiResponse({ status: 404, description: 'LLM provider not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async deleteProvider(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.llmProvidersService.deleteProvider(providerId, organizationId, req.user.id);

      return {
        success: true,
        message: 'LLM provider deleted successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'PROVIDER_DELETION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':providerId/chat')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Chat with LLM provider' })
  @ApiResponse({ status: 200, description: 'Chat response received successfully' })
  @ApiResponse({ status: 400, description: 'Invalid chat request' })
  async chat(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body(ValidationPipe) chatRequest: ChatRequestBodyDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const response = await this.llmProvidersService.chat(
        providerId,
        chatRequest as ChatRequest,
        organizationId,
        req.user.id
      );

      return {
        success: true,
        data: response,
        message: 'Chat response received successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'CHAT_REQUEST_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':providerId/test')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Test LLM provider connection' })
  @ApiResponse({ status: 200, description: 'Connection test completed' })
  async performHealthCheck(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Request() req: any,
  ) {
    try {
      const result = await this.llmProvidersService.performHealthCheck(providerId);

      return {
        success: true,
        data: result,
        message: 'Connection test completed',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'CONNECTION_TEST_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // Session management endpoints
  @Post(':providerId/sessions')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Create a new chat session' })
  @ApiResponse({ status: 201, description: 'Session created successfully' })
  async createSession(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body(ValidationPipe) createSessionDto: CreateSessionDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const session = await this.llmProvidersService.createSession(
        providerId,
        organizationId,
        req.user.id,
        createSessionDto
      );

      return {
        success: true,
        data: session,
        message: 'Session created successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SESSION_CREATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':providerId/sessions')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get sessions for LLM provider' })
  @ApiResponse({ status: 200, description: 'Sessions retrieved successfully' })
  async getSessions(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Query('status') status?: SessionStatus,
    @Query('userId') userId?: string,
    @Query('page', new ValidationPipe({ transform: true })) page = 1,
    @Query('limit', new ValidationPipe({ transform: true })) limit = 20,
    @Request() req?: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.llmProvidersService.getSessions(
        organizationId,
        providerId,
        userId,
        status,
        page,
        Math.min(limit, 100)
      );

      return {
        success: true,
        data: result,
        message: 'Sessions retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SESSIONS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('sessions/:sessionId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get session by ID' })
  @ApiResponse({ status: 200, description: 'Session retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const session = await this.llmProvidersService.getSession(sessionId, organizationId);

      return {
        success: true,
        data: session,
        message: 'Session retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SESSION_NOT_FOUND',
        },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  @Put('sessions/:sessionId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Update session' })
  @ApiResponse({ status: 200, description: 'Session updated successfully' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async updateSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(ValidationPipe) updateSessionDto: UpdateSessionDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const session = await this.llmProvidersService.updateSession(
        sessionId,
        organizationId,
        updateSessionDto
      );

      return {
        success: true,
        data: session,
        message: 'Session updated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SESSION_UPDATE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete('sessions/:sessionId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Delete session' })
  @ApiResponse({ status: 200, description: 'Session deleted successfully' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async deleteSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.llmProvidersService.deleteSession(sessionId, organizationId);

      return {
        success: true,
        message: 'Session deleted successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SESSION_DELETION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // Utility endpoints
  @Get('provider-types')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get available LLM provider types' })
  @ApiResponse({ status: 200, description: 'Provider types retrieved successfully' })
  async getProviderTypes() {
    const providerTypes = Object.values(LlmProviderType).map(type => ({
      type,
      name: this.getProviderDisplayName(type),
      description: this.getProviderDescription(type),
      features: this.getProviderFeatures(type),
    }));

    return {
      success: true,
      data: providerTypes,
      message: 'Provider types retrieved successfully',
    };
  }

  @Post('models/by-type')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Fetch available models by provider type and API key (for pre-creation)' })
  @ApiResponse({ status: 200, description: 'Models retrieved successfully' })
  async getModelsByType(
    @Body() body: { type: string; apiKey: string },
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!body.type || !body.apiKey) {
        throw new HttpException(
          { success: false, message: 'type and apiKey are required', error: 'INVALID_INPUT' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const models = await this.llmProvidersService.fetchModelsByType(
        body.type as any,
        body.apiKey,
      );

      return {
        success: true,
        data: models,
        message: 'Models fetched from provider API',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'MODELS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':providerId/models')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Fetch available models dynamically from the provider API' })
  @ApiResponse({ status: 200, description: 'Models retrieved successfully' })
  async getProviderModels(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const provider = await this.llmProvidersService.getProvider(providerId, organizationId, true);
      const models = await this.llmProvidersService.fetchModelsFromProvider(provider);

      return {
        success: true,
        data: models,
        message: 'Models fetched from provider API',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'MODELS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  private getProviderDisplayName(type: LlmProviderType): string {
    const names = {
      [LlmProviderType.OPENAI]: 'OpenAI',
      [LlmProviderType.ANTHROPIC]: 'Anthropic',
      [LlmProviderType.GOOGLE]: 'Google Gemini',
      [LlmProviderType.MISTRAL]: 'Mistral AI',
      [LlmProviderType.XAI]: 'xAI',
      [LlmProviderType.DEEPSEEK]: 'DeepSeek',
      [LlmProviderType.GROQ]: 'Groq',
      [LlmProviderType.TOGETHER]: 'Together AI',
      [LlmProviderType.OPENROUTER]: 'OpenRouter',
      [LlmProviderType.AZURE_OPENAI]: 'Azure OpenAI',
      [LlmProviderType.AWS_BEDROCK]: 'AWS Bedrock',
      [LlmProviderType.COHERE]: 'Cohere',
      [LlmProviderType.HUGGINGFACE]: 'Hugging Face',
      [LlmProviderType.CUSTOM]: 'Custom',
    };
    return names[type] || type;
  }

  private getProviderDescription(type: LlmProviderType): string {
    const descriptions = {
      [LlmProviderType.OPENAI]: 'GPT-4o, o3, o4-mini and more',
      [LlmProviderType.ANTHROPIC]: 'Claude Opus, Sonnet, and Haiku',
      [LlmProviderType.GOOGLE]: 'Gemini 2.0 Flash, Pro and more',
      [LlmProviderType.MISTRAL]: 'Mistral Large, Small, and Codestral',
      [LlmProviderType.XAI]: 'Grok models with real-time knowledge',
      [LlmProviderType.DEEPSEEK]: 'DeepSeek Chat and Reasoner',
      [LlmProviderType.GROQ]: 'Ultra-fast inference for open models',
      [LlmProviderType.TOGETHER]: 'Open-source models at scale',
      [LlmProviderType.OPENROUTER]: 'Unified access to 200+ models from all providers',
      [LlmProviderType.AZURE_OPENAI]: 'OpenAI models on Microsoft Azure',
      [LlmProviderType.AWS_BEDROCK]: 'Foundation models through AWS',
      [LlmProviderType.COHERE]: 'Enterprise language models',
      [LlmProviderType.HUGGINGFACE]: 'Open-source model inference',
      [LlmProviderType.CUSTOM]: 'Any OpenAI-compatible API endpoint',
    };
    return descriptions[type] || 'Custom AI model provider';
  }

  private getProviderFeatures(type: LlmProviderType): string[] {
    const features = {
      [LlmProviderType.OPENAI]: ['Tool Use', 'Streaming', 'Vision', 'Reasoning'],
      [LlmProviderType.ANTHROPIC]: ['Tool Use', 'Streaming', 'Vision', '200K Context'],
      [LlmProviderType.GOOGLE]: ['Tool Use', 'Streaming', 'Vision', '1M Context'],
      [LlmProviderType.MISTRAL]: ['Tool Use', 'Streaming', 'Code Generation'],
      [LlmProviderType.XAI]: ['Tool Use', 'Streaming', 'Vision', 'Real-time Knowledge'],
      [LlmProviderType.DEEPSEEK]: ['Tool Use', 'Streaming', 'Reasoning'],
      [LlmProviderType.GROQ]: ['Tool Use', 'Streaming', 'Ultra-fast Inference'],
      [LlmProviderType.TOGETHER]: ['Tool Use', 'Streaming', 'Open Source Models'],
      [LlmProviderType.OPENROUTER]: ['Tool Use', 'Streaming', '200+ Models', 'Multi-Provider'],
      [LlmProviderType.AZURE_OPENAI]: ['Tool Use', 'Streaming', 'Enterprise Security'],
      [LlmProviderType.AWS_BEDROCK]: ['Multiple Providers', 'Enterprise Security'],
      [LlmProviderType.COHERE]: ['Tool Use', 'Streaming', 'Enterprise'],
      [LlmProviderType.HUGGINGFACE]: ['Open Source', 'Multiple Models'],
      [LlmProviderType.CUSTOM]: ['Flexible', 'Any OpenAI-Compatible API'],
    };
    return features[type] || [];
  }
}