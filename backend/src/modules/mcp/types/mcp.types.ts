// MCP Protocol Types based on JSON-RPC 2.0 specification

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

// MCP Protocol Capabilities
export interface McpCapabilities {
  experimental?: Record<string, any>;
  logging?: {};
  completions?: {};
  prompts?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
  };
}

// MCP Initialization
export interface McpClientInfo {
  name: string;
  version: string;
}

export interface McpInitializeRequest {
  protocolVersion: string;
  capabilities: McpCapabilities;
  clientInfo: McpClientInfo;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
}

// MCP Tool Types
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any; // JSON Schema
}

export interface McpToolsListRequest {
  cursor?: string;
}

export interface McpToolsListResult {
  tools: McpTool[];
  nextCursor?: string;
}

export interface McpCallToolRequest {
  name: string;
  arguments?: Record<string, any>;
}

export interface McpCallToolResult {
  content: McpContent[];
  isError?: boolean;
}

// MCP Content Types
export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface McpResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    text?: string;
    blob?: string;
    mimeType?: string;
  };
}

export type McpContent = McpTextContent | McpImageContent | McpResourceContent;

// MCP Resource Types
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourcesListRequest {
  cursor?: string;
}

export interface McpResourcesListResult {
  resources: McpResource[];
  nextCursor?: string;
}

export interface McpReadResourceRequest {
  uri: string;
}

export interface McpReadResourceResult {
  contents: McpContent[];
}

// MCP Prompt Types
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpPromptsListRequest {
  cursor?: string;
}

export interface McpPromptsListResult {
  prompts: McpPrompt[];
  nextCursor?: string;
}

export interface McpGetPromptRequest {
  name: string;
  arguments?: Record<string, any>;
}

export interface McpGetPromptResult {
  description?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: McpContent;
  }>;
}

// MCP Notification Types
export type McpNotificationMethod = 
  | 'notifications/initialized'
  | 'notifications/cancelled'
  | 'notifications/message'
  | 'notifications/tools/list_changed'
  | 'notifications/resources/list_changed'
  | 'notifications/prompts/list_changed';

export interface McpNotification {
  method: McpNotificationMethod;
  params?: any;
}

// MCP Progress Types
export interface McpProgress {
  progressToken: string | number;
  progress: number;
  total?: number;
}

// MCP Completion Types
export interface McpCompletionRequest {
  ref: {
    type: 'ref/resource' | 'ref/prompt';
    uri: string;
  };
  argument: {
    name: string;
    value: string;
  };
}

export interface McpCompletionResult {
  completion: {
    values: string[];
    total?: number;
    hasMore?: boolean;
  };
}

// MCP Log Types
export interface McpLogEntry {
  level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
  data: any;
  logger?: string;
}

// Error Codes (JSON-RPC 2.0)
export enum JsonRpcErrorCode {
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
  // MCP-specific error codes
  INVALID_OPERATION = -32000,
  RESOURCE_NOT_FOUND = -32001,
  TOOL_NOT_FOUND = -32002,
  UNAUTHORIZED = -32003,
}

// Transport Types
export type McpTransport = 'http' | 'sse' | 'websocket' | 'stdio';

export interface McpSession {
  id: string;
  clientInfo: McpClientInfo;
  capabilities: McpCapabilities;
  transport: McpTransport;
  isInitialized: boolean;
  createdAt: Date;
  lastActivity: Date;
  organizationId: string;
  userId?: string;
}