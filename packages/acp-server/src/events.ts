/**
 * Event mapper: converts almyty StreamEvent / run events into ACP
 * SessionUpdate notifications.
 *
 * ACP SessionUpdate variants: agent_message_chunk, tool_call,
 * tool_call_update, plan, agent_thought_chunk, user_message_chunk.
 */

import type { StreamEvent, PipelineNode } from './proxy.js';

// ── ACP SessionUpdate types ──────────────────────────────────────

export interface SessionUpdate {
  sessionId: string;
  update: SessionUpdatePayload;
}

export type SessionUpdatePayload =
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCall
  | ToolCallUpdate
  | Plan;

export interface AgentMessageChunk {
  type: 'agent_message_chunk';
  /** Incremental text content. */
  text: string;
  /** MIME type (default text/plain). */
  mimeType?: string;
}

export interface AgentThoughtChunk {
  type: 'agent_thought_chunk';
  text: string;
}

export interface ToolCall {
  type: 'tool_call';
  /** Unique ID for this tool invocation (for pairing with updates). */
  toolCallId: string;
  /** Human-readable title (tool name or node label). */
  title: string;
  /** Tool call kind: read, edit, execute, fetch, think, other. */
  kind: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
  /** Current status. */
  status: 'running' | 'completed' | 'error' | 'cancelled';
  /** Raw input parameters (stringified JSON). */
  rawInput?: string;
}

export interface ToolCallUpdate {
  type: 'tool_call_update';
  /** Matches the toolCallId from the original ToolCall. */
  toolCallId: string;
  /** Updated status. */
  status: 'running' | 'completed' | 'error' | 'cancelled';
  /** Output content (on completion). */
  content?: string;
  /** Error message (on failure). */
  error?: string;
}

export interface PlanEntry {
  title: string;
  priority: 'high' | 'medium' | 'low';
  status: 'todo' | 'in_progress' | 'done' | 'error';
}

export interface Plan {
  type: 'plan';
  entries: PlanEntry[];
}

// ── Mapping functions ────────────────────────────────────────────

/**
 * Infer a tool call kind from the node type or tool name.
 */
function inferKind(nodeType?: string, toolName?: string): ToolCall['kind'] {
  if (nodeType === 'llm_call' || nodeType === 'sub_agent') return 'think';
  if (nodeType === 'transform') return 'edit';
  if (nodeType === 'condition') return 'other';
  if (toolName) {
    const lower = toolName.toLowerCase();
    if (lower.includes('read') || lower.includes('get') || lower.includes('list') || lower.includes('fetch')) return 'read';
    if (lower.includes('create') || lower.includes('update') || lower.includes('write') || lower.includes('set')) return 'edit';
    if (lower.includes('delete') || lower.includes('remove')) return 'delete';
    if (lower.includes('search') || lower.includes('find') || lower.includes('query')) return 'search';
    if (lower.includes('execute') || lower.includes('run') || lower.includes('invoke')) return 'execute';
  }
  return 'other';
}

/**
 * Convert a single almyty StreamEvent into zero or more ACP SessionUpdate
 * payloads. Most events map 1:1, but some (like node.completed with output)
 * may produce both a tool_call_update and an agent_message_chunk. An
 * autonomous run's events carry their fields under `data` (runEventData).
 */
export function mapStreamEvent(event: StreamEvent): SessionUpdatePayload[] {
  const updates: SessionUpdatePayload[] = [];
  const data = runEventData(event);

  switch (event.event) {
    // ── Node lifecycle events (workflow agents) ──────────────────

    case 'node.started': {
      const nodeId = String(data.nodeId ?? data.id ?? '');
      const nodeType = String(data.nodeType ?? data.type ?? '');
      const label = String(data.label ?? data.name ?? nodeType);
      updates.push({
        type: 'tool_call',
        toolCallId: nodeId,
        title: label,
        kind: inferKind(nodeType, String(data.toolName ?? '')),
        status: 'running',
        rawInput: data.input ? JSON.stringify(data.input) : undefined,
      });
      break;
    }

    case 'node.output': {
      const nodeId = String(data.nodeId ?? data.id ?? '');
      const output = data.output ?? data.result;
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

      // If this is an LLM node, surface as agent message chunk
      if (data.nodeType === 'llm_call' || data.type === 'llm_call') {
        updates.push({
          type: 'agent_message_chunk',
          text: outputStr,
        });
      }

      updates.push({
        type: 'tool_call_update',
        toolCallId: nodeId,
        status: 'completed',
        content: outputStr,
      });
      break;
    }

    case 'node.completed': {
      const nodeId = String(data.nodeId ?? data.id ?? '');
      const output = data.output ?? data.result;
      updates.push({
        type: 'tool_call_update',
        toolCallId: nodeId,
        status: 'completed',
        content: output != null ? (typeof output === 'string' ? output : JSON.stringify(output)) : undefined,
      });
      break;
    }

    case 'node.error': {
      const nodeId = String(data.nodeId ?? data.id ?? '');
      updates.push({
        type: 'tool_call_update',
        toolCallId: nodeId,
        status: 'error',
        error: String(data.error ?? data.message ?? 'Unknown error'),
      });
      break;
    }

    // ── Text streaming events ────────────────────────────────────

    case 'text':
    case 'message':
    case 'chunk':
    case 'token': {
      const text = String(data.text ?? data.content ?? data.chunk ?? data.token ?? '');
      if (text) {
        updates.push({
          type: 'agent_message_chunk',
          text,
        });
      }
      break;
    }

    case 'thought':
    case 'thinking': {
      const text = String(data.text ?? data.content ?? '');
      if (text) {
        updates.push({
          type: 'agent_thought_chunk',
          text,
        });
      }
      break;
    }

    // ── Tool call events (autonomous agents) ─────────────────────

    case 'tool_call':
    case 'tool.started': {
      const toolCallId = String(data.toolCallId ?? data.id ?? data.callId ?? '');
      const toolName = String(data.toolName ?? data.name ?? data.tool ?? '');
      updates.push({
        type: 'tool_call',
        toolCallId,
        title: toolName,
        kind: inferKind(undefined, toolName),
        status: 'running',
        rawInput: data.arguments ? JSON.stringify(data.arguments) : (data.input ? JSON.stringify(data.input) : undefined),
      });
      break;
    }

    case 'tool_result':
    case 'tool.completed': {
      const toolCallId = String(data.toolCallId ?? data.id ?? data.callId ?? '');
      const result = data.result ?? data.output;
      updates.push({
        type: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: result != null ? (typeof result === 'string' ? result : JSON.stringify(result)) : undefined,
      });
      break;
    }

    // An autonomous run's tool call ended: `success` says how, and a
    // failure carries its `error`.
    case 'tool.result': {
      const toolCallId = String(data.toolCallId ?? data.id ?? data.callId ?? '');
      const failed = data.success === false || !!data.error;
      const result = data.result ?? data.output;
      updates.push(
        failed
          ? { type: 'tool_call_update', toolCallId, status: 'error', error: String(data.error ?? 'Tool execution failed') }
          : {
              type: 'tool_call_update',
              toolCallId,
              status: 'completed',
              content: result != null ? (typeof result === 'string' ? result : JSON.stringify(result)) : undefined,
            },
      );
      break;
    }

    case 'tool.error': {
      const toolCallId = String(data.toolCallId ?? data.id ?? data.callId ?? '');
      updates.push({
        type: 'tool_call_update',
        toolCallId,
        status: 'error',
        error: String(data.error ?? data.message ?? 'Tool execution failed'),
      });
      break;
    }

    // ── Execution lifecycle ──────────────────────────────────────

    case 'execution.started':
    case 'execution.completed':
    case 'execution.error':
    case 'run.completed':
    case 'run.error':
    case 'run.failed':
    case 'done':
      // Terminal events — the caller handles these to finalize the
      // PromptResponse. We optionally surface errors as message chunks.
      if (data.error) {
        updates.push({
          type: 'agent_message_chunk',
          text: `Error: ${String(data.error)}`,
        });
      }
      if (data.output && event.event === 'execution.completed') {
        const text = typeof data.output === 'string' ? data.output : JSON.stringify(data.output);
        updates.push({
          type: 'agent_message_chunk',
          text,
        });
      }
      break;

    default:
      // Unknown event types are silently ignored.
      break;
  }

  return updates;
}

/**
 * An event's own fields. The run stream of an autonomous run sends each
 * runtime event whole, `{ type, data, timestamp, pos }`, so what the event
 * says is under `data`; an event without that envelope (a workflow's
 * stream) is read as it is.
 */
export function runEventData(event: StreamEvent): Record<string, any> {
  const raw = (event.data ?? {}) as Record<string, any>;
  const enveloped = raw.type === event.event && raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data);
  return enveloped ? raw.data : raw;
}

/** A run's output as text: a string, or the `text` of an output object. */
export function runOutputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output || undefined;
  if (output && typeof output === 'object' && typeof (output as any).text === 'string') return (output as any).text || undefined;
  return undefined;
}

/**
 * An autonomous run's model output as it is written, sorted into the
 * answer (`agent_message_chunk`) and the working (`agent_thought_chunk`).
 *
 * Every step of an autonomous run streams its model output as `llm.chunk`,
 * the steps that go on to call tools as much as the one that answers. The
 * run says which is which: `llm.started` with `answer: true` is a call that
 * writes the answer, `answer: false` one that works; a step announced
 * neither way is held until the provider says what it is (`llm.step_kind`:
 * `text` or `tool`), and a step whose provider never says goes out whole
 * when its `llm.response` lands with no tool calls. The same rules the
 * hosted chat applies to what a visitor sees (answer-stream.filter.ts on
 * the server), except that here the working is shown too, as thought.
 *
 * `map` answers null for any event that is not model output, which the
 * caller hands to mapStreamEvent; `answer()` is the answer text sent so far.
 */
export function autonomousTextStream(): {
  map(event: StreamEvent): SessionUpdatePayload[] | null;
  answer(): string;
} {
  type Step = { kind: 'text' | 'tool' | null; held: string[]; sent: string };
  const steps = new Map<number, Step>();
  let answer = '';
  const stateOf = (step: number): Step => {
    let state = steps.get(step);
    if (!state) {
      state = { kind: null, held: [], sent: '' };
      steps.set(step, state);
    }
    return state;
  };
  const say = (state: Step | null, text: string): SessionUpdatePayload => {
    if (state) state.sent += text;
    answer += text;
    return { type: 'agent_message_chunk', text };
  };
  const think = (text: string): SessionUpdatePayload => ({ type: 'agent_thought_chunk', text });

  return {
    answer: () => answer,
    map(event) {
      const data = runEventData(event);
      const step = typeof data.step === 'number' ? data.step : null;
      switch (event.event) {
        case 'llm.started': {
          if (step === null) return [];
          steps.delete(step);
          if (data.answer === true) steps.set(step, { kind: 'text', held: [], sent: '' });
          else if (data.answer === false) steps.set(step, { kind: 'tool', held: [], sent: '' });
          return [];
        }
        case 'llm.chunk': {
          const content = data.content;
          if (step === null || typeof content !== 'string' || !content) return [];
          const state = stateOf(step);
          if (state.kind === 'text') return [say(state, content)];
          if (state.kind === 'tool') return [think(content)];
          state.held.push(content);
          return [];
        }
        case 'llm.step_kind': {
          if (step === null) return [];
          const state = stateOf(step);
          if (state.kind) return [];
          const held = state.held.join('');
          state.held = [];
          if (data.kind === 'tool') {
            state.kind = 'tool';
            return held ? [think(held)] : [];
          }
          if (data.kind === 'text') {
            state.kind = 'text';
            return held ? [say(state, held)] : [];
          }
          return [];
        }
        case 'llm.response': {
          const state = step === null ? undefined : steps.get(step);
          if (step !== null) steps.delete(step);
          const calledTools = Array.isArray(data.toolCalls) && data.toolCalls.length > 0;
          const held = state?.held.join('') ?? '';
          // Working, unless the run says this draft now stands as the answer.
          if (calledTools || (state?.kind === 'tool' && data.answer !== true)) return held ? [think(held)] : [];
          const content = data.content;
          if (typeof content !== 'string' || !content) return [];
          const sent = state?.sent ?? '';
          // What streamed is the start of the answer: the rest, if any.
          if (content.startsWith(sent)) {
            const rest = content.slice(sent.length);
            return rest ? [say(null, rest)] : [];
          }
          // The stream and the response disagree. What was sent cannot be
          // taken back here; the turn's final text (the run's output) is
          // what the prompt answers with.
          return [];
        }
        default:
          return null;
      }
    },
  };
}

/**
 * Build an ACP Plan from almyty pipeline nodes. Maps node types to
 * priorities and initializes all entries as "todo".
 */
export function buildPlanFromPipeline(nodes: PipelineNode[]): Plan {
  const entries: PlanEntry[] = nodes
    .filter((n) => n.type !== 'input' && n.type !== 'output')
    .map((node) => ({
      title: node.label || `${node.type} (${node.id})`,
      priority: inferPriority(node.type),
      status: 'todo' as const,
    }));

  return { type: 'plan', entries };
}

/**
 * Map node type to plan entry priority.
 */
function inferPriority(nodeType: string): PlanEntry['priority'] {
  switch (nodeType) {
    case 'llm_call':
    case 'tool_call':
    case 'sub_agent':
      return 'high';
    case 'condition':
    case 'loop':
    case 'parallel':
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * Check if a StreamEvent indicates the execution has finished.
 */
export function isTerminalEvent(event: StreamEvent): boolean {
  return [
    'execution.completed',
    'execution.error',
    'run.completed',
    'run.error',
    'run.failed',
    'run.cancelled',
    'done',
  ].includes(event.event);
}

/**
 * Extract final output text from a terminal StreamEvent.
 */
export function extractFinalOutput(event: StreamEvent): string | undefined {
  const data = event.data;
  if (data.output) {
    return typeof data.output === 'string' ? data.output : JSON.stringify(data.output);
  }
  if (data.result) {
    return typeof data.result === 'string' ? data.result : JSON.stringify(data.result);
  }
  if (data.error) {
    return `Error: ${String(data.error)}`;
  }
  return undefined;
}
