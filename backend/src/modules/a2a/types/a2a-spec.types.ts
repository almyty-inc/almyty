/**
 * A2A (Agent-to-Agent) protocol types — pinned to spec version 0.2.0.
 *
 * Reference: https://google.github.io/A2A/
 */

export const A2A_PROTOCOL_VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

export interface TextPart {
  type: 'text';
  text: string;
}

export interface FilePart {
  type: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string; // base64-encoded
    uri?: string;
  };
}

export interface DataPart {
  type: 'data';
  data: Record<string, any>;
}

export type Part = TextPart | FilePart | DataPart;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: Part[];
  messageId?: string;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED';

export interface TaskState {
  state: TaskStatus;
  message?: A2AMessage;
  timestamp?: string;
}

export interface Artifact {
  name?: string;
  description?: string;
  parts: Part[];
  index?: number;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, any>;
}

export interface Task {
  id: string;
  contextId?: string;
  status: TaskState;
  artifacts?: Artifact[];
  history?: TaskState[];
  metadata?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// SSE events
// ---------------------------------------------------------------------------

export interface TaskStatusUpdateEvent {
  type: 'status';
  taskId: string;
  contextId?: string;
  status: TaskState;
  final: boolean;
}

export interface TaskArtifactUpdateEvent {
  type: 'artifact';
  taskId: string;
  contextId?: string;
  artifact: Artifact;
}

// ---------------------------------------------------------------------------
// Agent Card / Discovery
// ---------------------------------------------------------------------------

export interface AgentProvider {
  organization: string;
  url?: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface SecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  description?: string;
  // apiKey
  name?: string;
  in?: 'header' | 'query' | 'cookie';
  // http
  scheme?: string;
  bearerFormat?: string;
  // oauth2
  flows?: Record<string, any>;
  // openIdConnect
  openIdConnectUrl?: string;
}

export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  provider?: AgentProvider;
  version: string;
  skills: AgentSkill[];
  securitySchemes?: Record<string, SecurityScheme>;
  security?: Array<Record<string, string[]>>;
  capabilities?: AgentCapabilities;
  supportedInterfaces?: Array<{ protocolBinding: string; url: string }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id: string | number;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: JsonRpcError;
  id: string | number | null;
}

// ---------------------------------------------------------------------------
// A2A error codes
// ---------------------------------------------------------------------------

export const A2A_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATIONS_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
} as const;
