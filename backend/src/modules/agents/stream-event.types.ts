/**
 * Shared streaming event types for both the workflow pipeline engine
 * (AgentExecutionEngine) and the autonomous runtime (AgentRuntimeService).
 *
 * Pipeline events (execution.*, node.*) are emitted by the workflow engine.
 * Runtime events (llm.*, tool.*, step.*, run.*) are emitted by the
 * autonomous runtime. Both share the same StreamEvent union so consumers
 * (SSE endpoints, ACP server, A2A, web UI) can subscribe to a single
 * event shape regardless of agent mode.
 */

// ── Pipeline events (workflow engine) ──────────────────────────────────

export interface PipelineExecutionStarted {
  type: 'execution.started';
  nodeId?: string;
  nodeType?: string;
  data?: any;
  timestamp: number;
}

export interface PipelineNodeStarted {
  type: 'node.started';
  nodeId?: string;
  nodeType?: string;
  data?: any;
  timestamp: number;
}

export interface PipelineNodeOutput {
  type: 'node.output';
  nodeId?: string;
  nodeType?: string;
  data?: any;
  timestamp: number;
}

export interface PipelineNodeCompleted {
  type: 'node.completed';
  nodeId?: string;
  nodeType?: string;
  data?: any;
  timestamp: number;
}

export interface PipelineNodeSkipped {
  type: 'node.skipped';
  nodeId?: string;
  nodeType?: string;
  data?: any;
  timestamp: number;
}

export interface PipelineExecutionCompleted {
  type: 'execution.completed';
  nodeId?: string;
  nodeType?: string;
  data?: any;
  timestamp: number;
}

export interface PipelineExecutionFailed {
  type: 'execution.failed';
  nodeId?: string;
  nodeType?: string;
  data?: any;
  timestamp: number;
}

// ── Runtime events (autonomous agent) ──────────────────────────────────

export interface RuntimeLlmStarted {
  type: 'llm.started';
  data?: { step: number };
  timestamp: number;
}

export interface RuntimeLlmChunk {
  type: 'llm.chunk';
  data?: { step: number; content?: string };
  timestamp: number;
}

export interface RuntimeLlmResponse {
  type: 'llm.response';
  data?: {
    step: number;
    content?: string;
    toolCalls?: Array<{ id: string; name: string }>;
    usage?: { inputTokens: number; outputTokens: number };
    cost?: number;
  };
  timestamp: number;
}

export interface RuntimeToolStarted {
  type: 'tool.started';
  data?: { step: number; toolCallId: string; tool: string };
  timestamp: number;
}

export interface RuntimeToolResult {
  type: 'tool.result';
  data?: {
    step: number;
    toolCallId: string;
    tool: string;
    success: boolean;
    executionTime?: number;
  };
  timestamp: number;
}

export interface RuntimeStepCompleted {
  type: 'step.completed';
  data?: any;
  timestamp: number;
}

export interface RuntimeRunCompleted {
  type: 'run.completed';
  data?: any;
  timestamp: number;
}

export interface RuntimeRunFailed {
  type: 'run.failed';
  data?: any;
  timestamp: number;
}

export interface RuntimeRunCancelled {
  type: 'run.cancelled';
  data?: any;
  timestamp: number;
}

// ── Union ──────────────────────────────────────────────────────────────

/** Pipeline event types (emitted by workflow engine). */
export type PipelineStreamEvent =
  | PipelineExecutionStarted
  | PipelineNodeStarted
  | PipelineNodeOutput
  | PipelineNodeCompleted
  | PipelineNodeSkipped
  | PipelineExecutionCompleted
  | PipelineExecutionFailed;

/** Runtime event types (emitted by autonomous runtime). */
export type RuntimeStreamEvent =
  | RuntimeLlmStarted
  | RuntimeLlmChunk
  | RuntimeLlmResponse
  | RuntimeToolStarted
  | RuntimeToolResult
  | RuntimeStepCompleted
  | RuntimeRunCompleted
  | RuntimeRunFailed
  | RuntimeRunCancelled;

/**
 * Unified StreamEvent — the full union of all event shapes.
 * Drop-in replacement for the original StreamEvent interface
 * exported from agent-execution.engine.ts.
 */
export type StreamEvent = PipelineStreamEvent | RuntimeStreamEvent;

/** All possible event type string literals. */
export type StreamEventType = StreamEvent['type'];
