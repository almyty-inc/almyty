/**
 * A2A (Agent-to-Agent) protocol types — A2A v1.0.
 *
 * Normative source: specification/a2a.proto in https://github.com/a2aproject/A2A
 * (tag v1.0.1). From v1.0 the proto is the single normative definition and every
 * binding — gRPC, HTTP+JSON and JSON-RPC — carries the ProtoJSON encoding of it.
 * That is why the JSON-RPC wire here uses SCREAMING_SNAKE_CASE enum values
 * (`TASK_STATE_WORKING`, `ROLE_USER`), oneof-member discrimination instead of a
 * `kind` discriminator, and PascalCase method names (`SendMessage`, `GetTask`).
 *
 * Wire-shape differences from v0.2.x / v0.3.x that matter when reading this file:
 *   - Part:   v0.x `{ kind: 'text', text }`  ->  v1.0 `{ text }` (oneof member).
 *   - State:  v0.x `"working"`               ->  v1.0 `"TASK_STATE_WORKING"`.
 *   - Role:   v0.x `"user"`                  ->  v1.0 `"ROLE_USER"`.
 *   - Events: v0.x `{ kind: 'status-update' }` -> v1.0 `{ statusUpdate: {...} }`.
 * The server ACCEPTS all three Part dialects on input (see a2a-part.mapper.ts)
 * but EMITS only v1.0.
 */

export const A2A_PROTOCOL_VERSION = '1.0';

// ---------------------------------------------------------------------------
// Parts — proto `Part`, a single message with a `oneof content`.
// ProtoJSON renders a oneof as the set member's own field name, so the content
// type is determined by which of text/raw/url/data is present.
// ---------------------------------------------------------------------------

export interface Part {
  /** oneof content: inline text. */
  text?: string;
  /** oneof content: inline binary content, base64-encoded in JSON. */
  raw?: string;
  /** oneof content: a reference to file content. */
  url?: string;
  /** oneof content: structured data. */
  data?: Record<string, any>;
  /** Optional filename, available for every part type (not just files). */
  filename?: string;
  /** Media type of the content; replaces v0.x `file.mimeType`. */
  mediaType?: string;
  metadata?: Record<string, any>;
}

/** Build a v1.0 text Part. */
export function textPart(text: string): Part {
  return { text };
}

/** Build a v1.0 data Part. */
export function dataPart(data: Record<string, any>): Part {
  return { data };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = 'ROLE_UNSPECIFIED' | 'ROLE_USER' | 'ROLE_AGENT';

export interface A2AMessage {
  /** REQUIRED by the proto — clients and servers both generate one. */
  messageId: string;
  /** REQUIRED. */
  role: Role;
  /** REQUIRED. */
  parts: Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, any>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

/** Task states from which no further transition happens. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
];

export interface TaskStatus {
  state: TaskState;
  message?: A2AMessage;
  /** ISO 8601 UTC with millisecond precision. */
  timestamp?: string;
}

export interface Artifact {
  /** REQUIRED by the proto. */
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, any>;
  extensions?: string[];
}

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  /** Conversation history — Messages, not status snapshots. */
  history?: A2AMessage[];
  metadata?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// SSE events (proto `StreamResponse`)
// ---------------------------------------------------------------------------

export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  metadata?: Record<string, any>;
}

export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, any>;
}

/**
 * proto `StreamResponse` — a oneof over task / message / statusUpdate /
 * artifactUpdate. Exactly one member is set on each SSE frame.
 */
export interface StreamResponse {
  task?: Task;
  message?: A2AMessage;
  statusUpdate?: TaskStatusUpdateEvent;
  artifactUpdate?: TaskArtifactUpdateEvent;
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
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  /** v1.0 home of what v0.x called `supportsAuthenticatedExtendedCard`. */
  extendedAgentCard?: boolean;
  extensions?: Array<Record<string, any>>;
}

/**
 * proto `AgentInterface`. v1.0 folded v0.x's `url` + `preferredTransport` +
 * `additionalInterfaces` into this one repeated field, and moved the protocol
 * version onto each interface.
 */
export interface AgentInterface {
  url: string;
  /** JSONRPC | GRPC | HTTP+JSON. */
  protocolBinding: string;
  protocolVersion: string;
  tenant?: string;
}

/** proto `SecurityScheme` — a oneof, so ProtoJSON keys it by the set member. */
export interface SecurityScheme {
  apiKeySecurityScheme?: { name?: string; in?: string; description?: string };
  httpAuthSecurityScheme?: {
    scheme?: string;
    bearerFormat?: string;
    description?: string;
  };
  oauth2SecurityScheme?: { flows?: any; description?: string };
  openIdConnectSecurityScheme?: {
    openIdConnectUrl?: string;
    description?: string;
  };
  mtlsSecurityScheme?: Record<string, unknown>;
}

export interface AgentCard {
  name: string;
  /** REQUIRED — a card without one is rejected by a conforming client. */
  description: string;
  /** REQUIRED. The AGENT's own version, not the protocol version. */
  version: string;
  /** REQUIRED. Protocol version lives on each interface from v1.0 onward. */
  supportedInterfaces: AgentInterface[];
  capabilities: AgentCapabilities;
  skills: AgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  provider?: AgentProvider;
  securitySchemes?: Record<string, SecurityScheme>;
  security?: Array<Record<string, string[]>>;
  documentationUrl?: string;
  iconUrl?: string;
  /**
   * Not a v1.0 AgentCard field (v1.0 moved the endpoint into
   * supportedInterfaces[0].url). Emitted anyway as a harmless extra so that
   * v0.2.x / v0.3.x clients, which require a top-level `url`, can still reach
   * the endpoint.
   */
  url?: string;
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
