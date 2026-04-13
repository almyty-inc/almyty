/**
 * ACP (Agent Communication Protocol) types.
 *
 * ACP is a northbound/client-facing protocol for agent communication,
 * sibling to A2A. It uses JSON-RPC 2.0 for transport and supports
 * session-based prompt/response interactions.
 */

export const ACP_PROTOCOL_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Parts (shared shape with A2A for interop)
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

export interface AcpMessage {
  role: 'user' | 'agent';
  parts: Part[];
  messageId?: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionStatus =
  | 'created'
  | 'active'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface SessionState {
  status: SessionStatus;
  message?: AcpMessage;
  timestamp?: string;
}

export interface SessionUpdate {
  sessionId: string;
  status: SessionState;
  artifacts?: Artifact[];
  metadata?: Record<string, any>;
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

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface AcpProvider {
  organization: string;
  url?: string;
}

export interface AcpAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AcpCapabilities {
  streaming?: boolean;
  sessions?: boolean;
  pushNotifications?: boolean;
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

export interface AcpDiscoveryDocument {
  name: string;
  description?: string;
  url: string;
  provider?: AcpProvider;
  version: string;
  skills: AcpAgentSkill[];
  securitySchemes?: Record<string, SecurityScheme>;
  security?: Array<Record<string, string[]>>;
  capabilities?: AcpCapabilities;
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
// ACP error codes (JSON-RPC standard + protocol-specific)
// ---------------------------------------------------------------------------

export const ACP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SESSION_NOT_FOUND: -32001,
  SESSION_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATIONS_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
} as const;
