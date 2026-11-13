import { MessageRole, ToolCall } from '../../../entities/message.entity';
import type { ChatRequest, ProviderContent } from '../dto/llm-providers.dto';
import { contentAsText, toAnthropicContent } from '../content-parts';

/**
 * The conversation in the Anthropic Messages shape.
 *
 * Earlier tool calls go back as the structured blocks the API reads as
 * calls: an assistant turn carries a `tool_use` block for every call it
 * made (a turn may make several), and the user turn right after it carries
 * a `tool_result` block per call, matched by id, all in one message. Sent
 * as plain text instead, the model does not see its own calls as calls and
 * makes them again: a run called store_memory six times with the same
 * content and hit its cost cap (model comparison, 2026-11-13).
 *
 * An assistant turn the API returned is sent back as it came
 * (`providerContent`), thinking blocks included: a model that thinks
 * needs its thinking from the turn that made the calls.
 *
 * Kept whole whatever the stored history looks like:
 * - a call with no result after it (held for approval, a cut-off attempt)
 *   gets a result saying none was recorded, since the API refuses a
 *   `tool_use` with no `tool_result` after it;
 * - a result whose call is not in the turn before it (the history window
 *   cut that turn off) goes as text;
 * - a request that offers no tools gets every call and result as text,
 *   since the API refuses tool blocks in a request that defines no tools.
 */

type Block = Record<string, unknown>;
type WireMessage = { role: 'user' | 'assistant'; content: string | Block[] };
type InMessage = ChatRequest['messages'][number];

const NO_RESULT = 'No result was recorded for this call.';

const isSystem = (m: InMessage) => m.role === MessageRole.SYSTEM || (m.role as string) === 'system';
const isTool = (m: InMessage) => m.role === MessageRole.TOOL || (m.role as string) === 'tool';
const isAssistant = (m: InMessage) => m.role === MessageRole.ASSISTANT || (m.role as string) === 'assistant';

function asBlocks(content: string | Block[]): Block[] {
  if (Array.isArray(content)) return content;
  return content ? [{ type: 'text', text: content }] : [];
}

function hasContent(content: string | Block[]): boolean {
  return Array.isArray(content) ? content.length > 0 : !!content && content.trim().length > 0;
}

function toolUseBlock(call: ToolCall): Block {
  const input = call.parameters && typeof call.parameters === 'object' && !Array.isArray(call.parameters) ? call.parameters : {};
  return { type: 'tool_use', id: call.id, name: call.name, input };
}

/**
 * The blocks of an assistant turn that made calls: the turn as the API
 * returned it when that is on the message and holds exactly these calls,
 * else its text followed by a `tool_use` block per call.
 */
function assistantBlocks(message: InMessage, calls: ToolCall[]): Block[] {
  const stored = message.providerContent;
  if (stored?.format === 'anthropic' && Array.isArray(stored.blocks)) {
    const storedIds = stored.blocks.filter((b) => b?.type === 'tool_use').map((b) => String(b.id));
    const callIds = calls.map((c) => c.id);
    if (storedIds.length === callIds.length && storedIds.every((id, i) => id === callIds[i])) {
      return stored.blocks.map((b) => (b?.type === 'text' && !b.text ? null : b)).filter(Boolean) as Block[];
    }
  }
  const text = contentAsText(message.content as any);
  return [...(text.trim() ? [{ type: 'text', text }] : []), ...calls.map(toolUseBlock)];
}

function toolResultContent(message: InMessage): string | Block[] {
  const content = toAnthropicContent(message.content as any);
  return hasContent(content) ? content : '(empty result)';
}

function callAsText(call: ToolCall): string {
  return `[Called ${call.name} with ${JSON.stringify(call.parameters ?? {})}]`;
}

function resultAsText(message: InMessage, name?: string): string {
  return `[Result of ${name ?? 'an earlier tool call'}${message.toolCallId ? ` (${message.toolCallId})` : ''}]\n${contentAsText(message.content as any)}`;
}

/** The system prompt: every system message's text, in order. */
export function anthropicSystemPrompt(messages: ChatRequest['messages']): string | undefined {
  const parts = messages.filter(isSystem).map((m) => contentAsText(m.content as any)).filter((t) => t.length > 0);
  return parts.length ? parts.join('\n') : undefined;
}

/**
 * The non-system messages in the Messages API shape. `toolsOffered` says
 * whether the request defines tools; without them, calls and results are
 * text.
 */
export function toAnthropicMessages(messages: ChatRequest['messages'], toolsOffered: boolean): WireMessage[] {
  const list = messages.filter((m) => !isSystem(m));
  const out: WireMessage[] = [];
  const names = new Map<string, string>();
  const push = (role: WireMessage['role'], content: string | Block[]) => {
    if (hasContent(content)) out.push({ role, content });
  };

  for (let i = 0; i < list.length; i++) {
    const message = list[i];
    const calls = isAssistant(message) ? (message.toolCalls ?? []).filter((c) => c && c.id && c.name) : [];
    for (const call of calls) names.set(call.id, call.name);

    if (isAssistant(message) && calls.length > 0 && toolsOffered) {
      push('assistant', assistantBlocks(message, calls));
      // Every result that follows this turn, in one user message, results first.
      const open = new Set(calls.map((c) => c.id));
      const results: Block[] = [];
      const loose: Block[] = [];
      let j = i + 1;
      for (; j < list.length && isTool(list[j]); j++) {
        const result = list[j];
        if (result.toolCallId && open.has(result.toolCallId)) {
          open.delete(result.toolCallId);
          results.push({ type: 'tool_result', tool_use_id: result.toolCallId, content: toolResultContent(result) });
        } else {
          loose.push({ type: 'text', text: resultAsText(result, result.toolCallId ? names.get(result.toolCallId) : undefined) });
        }
      }
      for (const id of open) results.push({ type: 'tool_result', tool_use_id: id, content: NO_RESULT, is_error: true });
      push('user', [...results, ...loose]);
      i = j - 1;
      continue;
    }

    if (isAssistant(message)) {
      const text = contentAsText(message.content as any);
      const content = calls.length > 0 ? [text, ...calls.map(callAsText)].filter((t) => t.trim()).join('\n') : toAnthropicContent(message.content as any);
      push('assistant', content);
      continue;
    }

    if (isTool(message)) {
      push('user', resultAsText(message, message.toolCallId ? names.get(message.toolCallId) : undefined));
      continue;
    }

    push('user', toAnthropicContent(message.content as any));
  }

  // Turns of one role in a row are one turn to the API; merging them here
  // keeps a result message's tool_result blocks at the start of its turn.
  const merged: WireMessage[] = [];
  for (const message of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      last.content = [...asBlocks(last.content), ...asBlocks(message.content)];
    } else {
      merged.push({ ...message });
    }
  }
  return merged;
}

/** A tool call read back from a `tool_use` block. */
export function toolCallOf(block: Block): ToolCall {
  const input = block.input;
  return {
    id: String(block.id ?? ''),
    name: String(block.name ?? ''),
    parameters: input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, any>) : {},
  };
}

/** The reply's turn as the API returned it, to send back with its calls. Undefined when it made none. */
export function anthropicTurn(blocks: Block[] | undefined): ProviderContent | undefined {
  if (!Array.isArray(blocks) || !blocks.some((b) => b?.type === 'tool_use')) return undefined;
  return { format: 'anthropic', blocks };
}
