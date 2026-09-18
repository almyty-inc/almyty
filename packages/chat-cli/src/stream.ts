/**
 * The run stream, reduced.
 *
 * Every event a run or a pipeline emits lands here and turns into three
 * things: the assistant text so far (rendered as it arrives), lines for
 * the transcript, and a running cost/token tally. Kept pure and free of
 * ink so both the REPL and the non-interactive path drive the same
 * reducer, and so it can be tested without a terminal.
 *
 * Event shapes come from the backend: run events are
 * llm.started / llm.chunk / llm.response / tool.started / tool.result /
 * step.completed / verify.failed / run.completed / run.failed /
 * run.cancelled; workflow pipelines emit execution.started /
 * node.started / node.output / node.completed / node.skipped /
 * execution.completed / execution.failed.
 */

import type { StreamEvent } from '@almyty/client';

export type ActivityRole = 'agent' | 'tool' | 'info' | 'error';

export interface Activity {
  role: ActivityRole;
  text: string;
}

/** What a run cost, as far as the stream has said. */
export interface Usage {
  /** US dollars. The backend's cost fields are dollars, not cents. */
  cost: number;
  tokens: number;
  steps: number;
  /** Which model answered, when the server names one. */
  model?: string;
  /** Why the router picked it, when routing is in play. */
  rationale?: string;
  /** 1-based position of the answering candidate in the routing plan. */
  attempt?: number;
}

export interface StreamState {
  /** Assistant text streamed so far. Rendered live, not at the end. */
  partial: string;
  /** Spinner label: what the agent is doing right now. */
  label: string;
  /** Transcript lines produced since the last drain. */
  emit: Activity[];
  usage: Usage;
  /** Terminal output, once a completion event carries one. */
  output?: string;
  done: boolean;
  failed?: string;
  cancelled: boolean;
}

export const INITIAL_LABEL = 'Thinking';

export function initialStreamState(): StreamState {
  return {
    partial: '',
    label: INITIAL_LABEL,
    emit: [],
    usage: { cost: 0, tokens: 0, steps: 0 },
    done: false,
    cancelled: false,
  };
}

/** Anything the server hands back as an "output", as text. */
export function formatOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** A tool's duration, when the event reported one. */
function duration(ms: unknown): string {
  const n = num(ms);
  if (!n) return '';
  return n >= 1000 ? ` ${(n / 1000).toFixed(1)}s` : ` ${Math.round(n)}ms`;
}

/**
 * Fold one event into the state.
 *
 * Returns a new object every time so a React setState sees a change.
 */
export function reduceStreamEvent(prev: StreamState, event: StreamEvent): StreamState {
  const s: StreamState = { ...prev, emit: [...prev.emit], usage: { ...prev.usage } };
  const d = (event.data ?? {}) as Record<string, unknown>;

  switch (event.type) {
    case 'llm.started':
      s.label = 'Thinking';
      return s;

    case 'llm.chunk': {
      const chunk = str(d.content);
      if (chunk) s.partial += chunk;
      return s;
    }

    case 'llm.response': {
      s.usage.cost += num(d.cost);
      const usage = (d.usage ?? {}) as Record<string, unknown>;
      s.usage.tokens += num(usage.totalTokens) || num(usage.inputTokens) + num(usage.outputTokens);
      const routing = (d.routing ?? {}) as Record<string, unknown>;
      s.usage.model = str(d.model) ?? str(routing.vendorModelId) ?? str(routing.modelId) ?? s.usage.model;
      s.usage.rationale = str(routing.rationale) ?? s.usage.rationale;
      if (typeof routing.attempt === 'number') s.usage.attempt = routing.attempt;

      const content = str(d.content);
      const toolCalls = Array.isArray(d.toolCalls) ? d.toolCalls : [];

      // A provider without token streaming emits no chunks at all, so
      // the response body is the only copy of the answer.
      if (content && !s.partial) s.partial = content;

      // Text that came before a tool call is a preamble, not the
      // answer: flush it so the tool lines read underneath it, and
      // start the next step with an empty buffer.
      if (toolCalls.length) {
        if (s.partial.trim()) s.emit.push({ role: 'agent', text: s.partial.trim() });
        s.partial = '';
        s.label = 'Working';
      }
      return s;
    }

    case 'tool.started': {
      const tool = str(d.tool);
      if (tool) {
        s.emit.push({ role: 'tool', text: tool });
        s.label = `Running ${tool}`;
      }
      return s;
    }

    case 'tool.result': {
      const tool = str(d.tool) ?? 'tool';
      const ok = d.success !== false;
      s.emit.push({
        role: ok ? 'info' : 'error',
        text: `${tool} ${ok ? 'ok' : 'failed'}${duration(d.executionTime)}`,
      });
      s.label = 'Thinking';
      return s;
    }

    case 'step.completed': {
      s.usage.steps += 1;
      const status = str(d.status);
      if (status === 'waiting_input') s.label = 'Waiting for your input';
      else if (status === 'sleeping') s.label = 'Sleeping';
      else if (status === 'revising') s.label = 'Revising';
      else s.label = 'Thinking';
      return s;
    }

    case 'verify.failed':
      s.emit.push({ role: 'info', text: 'verification rejected the draft — revising' });
      s.label = 'Revising';
      return s;

    // ── Workflow pipelines ───────────────────────────────────────
    case 'execution.started':
      s.label = 'Starting';
      return s;

    case 'node.started': {
      const label = str(d.nodeType) ?? 'node';
      const id = str(d.nodeId);
      s.emit.push({ role: 'tool', text: id ? `${label} · ${id}` : label });
      s.label = `Running ${label}`;
      return s;
    }

    case 'node.completed': {
      s.usage.cost += num(d.cost);
      s.usage.tokens += num(d.tokens);
      s.usage.steps += 1;
      const error = str(d.error);
      if (error) s.emit.push({ role: 'error', text: `${str(d.nodeId) ?? 'node'} failed: ${error}` });
      return s;
    }

    case 'node.skipped':
      s.emit.push({ role: 'info', text: `${str(d.nodeId) ?? 'node'} skipped` });
      return s;

    case 'node.output':
      // Intermediate node output is noise in a chat transcript; the
      // pipeline's final output arrives on execution.completed.
      return s;

    case 'execution.completed': {
      s.usage.cost += num(d.totalCost);
      s.usage.tokens += num(d.totalTokens);
      const output = formatOutput(d.output);
      if (output) s.output = output;
      s.done = true;
      return s;
    }

    case 'execution.failed':
      s.failed = str(d.error) ?? str(d.message) ?? 'The pipeline failed';
      s.done = true;
      return s;

    // ── Autonomous runs ──────────────────────────────────────────
    case 'run.completed': {
      const output = formatOutput(d.output);
      if (output) s.output = output;
      s.done = true;
      return s;
    }

    case 'run.failed':
      s.failed = str(d.error) ?? 'The run failed';
      s.done = true;
      return s;

    case 'run.cancelled':
      s.cancelled = true;
      s.done = true;
      return s;

    default:
      return s;
  }
}

/**
 * The assistant text a finished stream should show.
 *
 * The streamed tokens are preferred over the completion event's output:
 * they are what the user already watched arrive, and re-rendering a
 * re-serialised copy of the same answer makes it flicker.
 */
export function finalText(state: StreamState, fallbackOutput?: unknown): string {
  const streamed = state.partial.trim();
  if (streamed) return streamed;
  if (state.output) return state.output;
  return formatOutput(fallbackOutput);
}

/** Take the pending transcript lines, leaving the state without them. */
export function drain(state: StreamState): { activities: Activity[]; state: StreamState } {
  if (!state.emit.length) return { activities: [], state };
  return { activities: state.emit, state: { ...state, emit: [] } };
}

/** Add two tallies, for a session total across turns. */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    cost: a.cost + b.cost,
    tokens: a.tokens + b.tokens,
    steps: a.steps + b.steps,
    model: b.model ?? a.model,
    rationale: b.rationale ?? a.rationale,
    attempt: b.attempt ?? a.attempt,
  };
}

/** Dollars, at a precision that does not round a real cost to zero. */
export function formatCost(dollars: number): string {
  if (!dollars) return '$0';
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/**
 * One line of attribution: what answered, what it cost.
 *
 * This is the product's whole argument — many models, routed, with the
 * bill attached — so a chat session says it out loud rather than
 * leaving it in an audit log.
 */
export function formatUsage(usage: Usage): string {
  const parts: string[] = [];
  if (usage.model) {
    parts.push(usage.attempt && usage.attempt > 1 ? `${usage.model} (attempt ${usage.attempt})` : usage.model);
  }
  if (usage.tokens) parts.push(`${formatTokens(usage.tokens)} tok`);
  if (usage.cost) parts.push(formatCost(usage.cost));
  if (usage.steps) parts.push(`${usage.steps} step${usage.steps === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Model attribution off a finished run's steps.
 *
 * The llm.response event does not carry the answering model, so a run
 * that streamed to completion has to be asked afterwards. Only the
 * tool-calling step records `routing` today, so a single-step answer
 * has no attribution to find and this returns null rather than
 * guessing.
 */
export function routingFromSteps(steps: unknown): Pick<Usage, 'model' | 'rationale' | 'attempt'> | null {
  if (!Array.isArray(steps)) return null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const routing = (steps[i] as any)?.output?.routing;
    if (routing && typeof routing === 'object') {
      return {
        model: str(routing.vendorModelId) ?? str(routing.modelId),
        rationale: str(routing.rationale),
        attempt: typeof routing.attempt === 'number' ? routing.attempt : undefined,
      };
    }
  }
  return null;
}
