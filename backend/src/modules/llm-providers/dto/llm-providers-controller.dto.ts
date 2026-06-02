import { IsString, IsOptional, IsEnum, IsObject, IsArray, IsNumber, Min, Max, IsBoolean, MaxLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { LlmProviderType, LlmProviderStatus } from '../../../entities/llm-provider.entity';
import { MessageRole, MessageContent } from '../../../entities/message.entity';
import { ConversationStatus } from '../../../entities/conversation.entity';

export class CreateLlmProviderBodyDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
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

  // Team-scoping fields sent by the dashboard create/update dialogs.
  // The VisibilityField component always emits both; without these
  // entries on the whitelist the ValidationPipe 400s the request.
  @IsOptional()
  @IsEnum(['org', 'team'])
  visibility?: 'org' | 'team';

  @IsOptional()
  @IsString()
  teamId?: string | null;
}

export class UpdateLlmProviderBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
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

  // Team-scoping fields sent by the dashboard create/update dialogs.
  // The VisibilityField component always emits both; without these
  // entries on the whitelist the ValidationPipe 400s the request.
  @IsOptional()
  @IsEnum(['org', 'team'])
  visibility?: 'org' | 'team';

  @IsOptional()
  @IsString()
  teamId?: string | null;
}

export class ChatMessageDto {
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

export class ChatRequestBodyDto {
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


export class LlmProviderSearchQueryDto {
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
