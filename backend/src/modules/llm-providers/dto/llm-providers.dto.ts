import { LlmProvider, LlmProviderType, LlmProviderStatus, LlmProviderConfig } from '../../../entities/llm-provider.entity';
import { MessageRole, MessageContent, ToolCall } from '../../../entities/message.entity';

export type StreamChunk = { content?: string; toolCalls?: any[] };

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
  skipToolExecution?: boolean; // When true, return tool_calls without executing them (used by agent runtime)
  /**
   * Cooperative cancellation signal. When this fires (e.g. the
   * originating HTTP client disconnected, or a parent agent run
   * was cancelled), the in-flight provider HTTP call aborts at
   * the socket level via axios's native signal config, and any
   * tool calls the provider triggered via the tool-call loop also
   * abort because the same signal is threaded through into
   * ToolExecutorService.executeTool.
   */
  signal?: AbortSignal;
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
  conversationId: string;
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
