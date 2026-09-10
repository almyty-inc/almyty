/**
 * The Anthropic Messages protocol, inbound.
 *
 * This is what lets someone point Claude Code, or any Anthropic SDK
 * client, at almyty with a base-URL change and have it work. It is the
 * highest-value inbound protocol for exactly that reason: the client
 * already exists and already speaks it.
 *
 * A translator at the edge, never a branch through the core. It converts
 * an Anthropic request into the one internal shape everything downstream
 * already understands, and converts the internal answer back out. Nothing
 * below this file learns that Anthropic Messages exists, which is what
 * makes a new inbound protocol one adapter rather than a change to every
 * layer.
 *
 * See docs/design/layers.md, L2.
 */

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
}
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicMessagesRequest {
  model: string;
  /** Required by the Anthropic API, unlike OpenAI's optional max_tokens. */
  max_tokens: number;
  messages: AnthropicMessage[];
  /** Top-level, not a message with role "system". */
  system?: string | AnthropicTextBlock[];
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
}

/** The internal shape. Deliberately the same one the OpenAI path produces. */
export interface InternalRequest {
  model: string;
  systemPrompt?: string;
  messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }>;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream?: boolean;
  stopSequences?: string[];
  tools?: Array<{ name: string; description?: string; parameters: Record<string, unknown> }>;
  toolChoice?: 'auto' | 'required' | { name: string };
}

export class AnthropicRequestInvalid extends Error {
  readonly code = 'INVALID_REQUEST';
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'AnthropicRequestInvalid';
  }
}

function blocksToText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is AnthropicTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Anthropic request to internal.
 *
 * The shape differences that actually matter, each handled rather than
 * flattened away:
 *   - `system` is a top-level field here and a message elsewhere.
 *   - content is blocks, and a turn may carry both text and tool uses.
 *   - a tool result arrives as a **user** message containing
 *     `tool_result` blocks, which internally is a `tool` role message per
 *     result. Collapsing those into user text is how a client's tool loop
 *     silently stops working.
 *   - `max_tokens` is required, so its absence is a request error rather
 *     than a default we invent.
 */
export function fromAnthropicRequest(body: AnthropicMessagesRequest): InternalRequest {
  if (!body || typeof body !== 'object') throw new AnthropicRequestInvalid('body', 'the request body must be an object');
  if (!body.model) throw new AnthropicRequestInvalid('model', 'model is required');
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AnthropicRequestInvalid('messages', 'messages must be a non-empty array');
  }
  if (typeof body.max_tokens !== 'number' || body.max_tokens <= 0) {
    throw new AnthropicRequestInvalid('max_tokens', 'max_tokens is required and must be a positive number');
  }

  const messages: InternalRequest['messages'] = [];
  for (const [i, message] of body.messages.entries()) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new AnthropicRequestInvalid(`messages[${i}].role`, `role must be "user" or "assistant", not "${message.role}"`);
    }
    const blocks = typeof message.content === 'string' ? [] : message.content ?? [];

    const toolResults = blocks.filter((b): b is AnthropicToolResultBlock => b.type === 'tool_result');
    for (const result of toolResults) {
      messages.push({
        role: 'tool',
        toolCallId: result.tool_use_id,
        content: typeof result.content === 'string' ? result.content : blocksToText(result.content),
      });
    }

    const toolUses = blocks.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');
    const text = blocksToText(message.content);
    // A turn that was only tool results has already been emitted above;
    // emitting an empty user message after it would confuse the model.
    if (text || toolUses.length > 0 || toolResults.length === 0) {
      messages.push({
        role: message.role,
        content: text,
        ...(toolUses.length
          ? { toolCalls: toolUses.map((t) => ({ id: t.id, name: t.name, arguments: JSON.stringify(t.input ?? {}) })) }
          : {}),
      });
    }
  }

  return {
    model: body.model,
    ...(body.system ? { systemPrompt: blocksToText(body.system) } : {}),
    messages,
    maxTokens: body.max_tokens,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    ...(body.stop_sequences ? { stopSequences: body.stop_sequences } : {}),
    ...(body.tools
      ? { tools: body.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }
      : {}),
    ...(body.tool_choice ? { toolChoice: toolChoice(body.tool_choice) } : {}),
  };
}

function toolChoice(choice: NonNullable<AnthropicMessagesRequest['tool_choice']>): InternalRequest['toolChoice'] {
  if (choice.type === 'tool' && choice.name) return { name: choice.name };
  if (choice.type === 'any') return 'required';
  return 'auto';
}

export interface InternalResponse {
  id: string;
  model: string;
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Internal answer back out.
 *
 * `stop_reason` is not `finish_reason` under another name: a client
 * branches on it, and an assistant turn carrying tool uses must report
 * `tool_use` or the client will never run the tools and the loop stops.
 */
export function toAnthropicResponse(response: InternalResponse): AnthropicMessagesResponse {
  const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [];
  if (response.content) content.push({ type: 'text', text: response.content });
  for (const call of response.toolCalls ?? []) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: safeParse(call.arguments) });
  }
  // A turn with neither text nor tools would be an empty content array,
  // which some clients reject outright.
  if (content.length === 0) content.push({ type: 'text', text: '' });

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
    stop_reason: stopReason(response),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.inputTokens ?? 0,
      output_tokens: response.usage?.outputTokens ?? 0,
    },
  };
}

function stopReason(response: InternalResponse): AnthropicMessagesResponse['stop_reason'] {
  if ((response.toolCalls ?? []).length > 0) return 'tool_use';
  switch (response.finishReason) {
    case 'length':
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** An error in the shape an Anthropic client knows how to read. */
export function toAnthropicError(status: number, message: string, type?: string): { type: 'error'; error: { type: string; message: string } } {
  const kind =
    type ??
    (status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 404
          ? 'not_found_error'
          : status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'api_error'
              : 'invalid_request_error');
  return { type: 'error', error: { type: kind, message } };
}
