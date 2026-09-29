import type { RoutingPolicy } from '../../model-catalog/routing/model-router';
import type { RouteAttribution } from '../../model-catalog/routing/model-router.service';
import { LlmProvider, LlmProviderType, LlmProviderStatus, LlmProviderConfig } from '../../../entities/llm-provider.entity';
import { MessageRole, MessageContent, ToolCall } from '../../../entities/message.entity';
import { type ResourceVisibility } from '../../../common/authorization/access-policy.service';

/**
 * One piece of a streamed model reply.
 *
 * `content` is a text delta. `stepKind` says, once and only when the
 * provider's stream makes it certain, whether this reply is a plain
 * answer (`text`) or one that calls tools (`tool`). A stream that never
 * reaches certainty never sends it, and consumers must treat the reply
 * as undecided until its final response lands. The hosted chat page
 * relies on this to stream the final answer without ever showing the
 * narration of a step that goes on to call tools.
 */
export type StreamChunk = { content?: string; toolCalls?: any[]; stepKind?: StreamStepKind };
export type StreamStepKind = 'text' | 'tool';

/**
 * The once-only `stepKind` signal for one streamed reply. The first
 * decision wins and later calls are ignored, so a provider can report
 * the earliest certain point and still call a fallback at stream end.
 */
export function stepKindSignal(onChunk: (chunk: StreamChunk) => void): {
  decide: (kind: StreamStepKind) => void;
  readonly decided: StreamStepKind | null;
} {
  let decided: StreamStepKind | null = null;
  return {
    decide(kind: StreamStepKind) {
      if (decided) return;
      decided = kind;
      onChunk({ stepKind: kind });
    },
    get decided() {
      return decided;
    },
  };
}

export interface CreateLlmProviderDto {
  name: string;
  description?: string;
  type: LlmProviderType;
  /** `apiKey` / `usageApiKey` here are pasted keys; they become Credential rows, never provider columns. */
  configuration: LlmProviderConfig;
  /** Point the provider at an existing connection instead of pasting a key. */
  credentialId?: string | null;
  usageCredentialId?: string | null;
  capabilities?: LlmProvider['capabilities'];
  metadata?: LlmProvider['metadata'];
  // Team-scoping fields from the dashboard VisibilityField.
  visibility?: ResourceVisibility;
  teamId?: string | null;
}

/** Connect a provider in one step (POST /llm-providers/connect); the name defaults to the provider's own. */
export interface ConnectProviderInput {
  type: LlmProviderType;
  name?: string;
  configuration?: LlmProviderConfig;
  credentialId?: string | null;
  visibility?: ResourceVisibility;
  teamId?: string | null;
}

export interface UpdateLlmProviderDto {
  name?: string;
  description?: string;
  configuration?: Partial<LlmProviderConfig>;
  /** A new connection to point at; null clears the reference (and deletes a key the provider created). */
  credentialId?: string | null;
  usageCredentialId?: string | null;
  capabilities?: Partial<LlmProvider['capabilities']>;
  metadata?: Partial<LlmProvider['metadata']>;
  visibility?: ResourceVisibility;
  teamId?: string | null;
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
  /**
   * When set, the catalog picks the model: the runner walks the policy's
   * candidates in order and records which card answered (see
   * ChatResponse.routing). `model` is then ignored.
   */
  routing?: RoutingPolicy;
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
  /** Present when the catalog router chose the model for this call. */
  routing?: RouteAttribution;
}


export interface LlmProviderSearchFilters {
  search?: string;
  type?: LlmProviderType;
  status?: LlmProviderStatus;
  organizationId: string;
  // Required so getProviders can apply the team-scope visibility
  // filter via AccessPolicyService.applyListFilter. System contexts
  // (almyty-mcp list_providers, internal callers) set
  // bypassTeamFilter=true to opt out explicitly.
  caller?: { id: string };
  bypassTeamFilter?: boolean;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'lastUsedAt' | 'totalRequests';
  sortOrder?: 'ASC' | 'DESC';
}
