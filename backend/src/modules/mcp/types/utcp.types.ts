// Universal Tool Calling Protocol (UTCP) Types
// Based on https://www.utcp.io specifications

export interface UtcpManual {
  version: string;
  info: {
    title: string;
    description?: string;
    version: string;
    contact?: {
      name?: string;
      email?: string;
      url?: string;
    };
    license?: {
      name: string;
      url?: string;
    };
  };
  tools: UtcpTool[];
  callTemplates: UtcpCallTemplate[];
  authentication?: UtcpAuthenticationScheme[];
  metadata?: Record<string, any>;
}

export interface UtcpTool {
  id: string;
  name: string;
  description: string;
  version: string;
  inputSchema: any; // JSON Schema
  outputSchema?: any; // JSON Schema
  tags?: string[];
  examples?: UtcpToolExample[];
  deprecationNotice?: string;
  metadata?: {
    sourceApi?: {
      name: string;
      type: string;
      endpoint: string;
      operation: string;
    };
    performance?: {
      averageResponseTime?: number;
      successRate?: number;
    };
    [key: string]: any;
  };
}

export interface UtcpToolExample {
  name: string;
  description?: string;
  input: Record<string, any>;
  expectedOutput?: any;
  notes?: string;
}

export interface UtcpCallTemplate {
  id: string;
  name: string;
  description?: string;
  protocol: 'http' | 'websocket' | 'cli' | 'grpc' | 'custom';
  endpoint: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
    retries?: number;
  };
  authentication?: {
    scheme: string;
    location: 'header' | 'query' | 'body';
    parameter?: string;
    value?: string;
    template?: string;
  };
  requestMapping: {
    parameters: Record<string, UtcpParameterMapping>;
    body?: UtcpBodyMapping;
  };
  responseMapping: {
    successCodes: number[];
    dataPath?: string;
    errorPath?: string;
    transform?: string; // JSONPath or transformation script
  };
  rateLimit?: {
    requestsPerSecond?: number;
    requestsPerMinute?: number;
    requestsPerHour?: number;
  };
  metadata?: Record<string, any>;
}

export interface UtcpParameterMapping {
  type: 'path' | 'query' | 'header' | 'body';
  name: string;
  required?: boolean;
  default?: any;
  transform?: string;
  validation?: any; // JSON Schema fragment
}

export interface UtcpBodyMapping {
  contentType: string;
  template?: string;
  schema?: any;
}

export interface UtcpAuthenticationScheme {
  id: string;
  name: string;
  type: 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2' | 'custom';
  description?: string;
  configuration: {
    location?: 'header' | 'query' | 'body';
    parameter?: string;
    scheme?: string;
    flows?: Record<string, any>; // For OAuth2
    custom?: Record<string, any>; // For custom schemes
  };
  examples?: Array<{
    name: string;
    description?: string;
    value: string;
  }>;
}

// UTCP Client Configuration
export interface UtcpClient {
  version: string;
  name: string;
  capabilities: {
    protocols: string[];
    authentication: string[];
    formats: string[];
    experimental?: Record<string, any>;
  };
  preferences?: {
    timeout: number;
    retries: number;
    caching: boolean;
    compression: boolean;
  };
}

// UTCP Execution Context
export interface UtcpExecutionContext {
  toolId: string;
  callTemplateId: string;
  parameters: Record<string, any>;
  authentication?: {
    scheme: string;
    credentials: Record<string, any>;
  };
  options?: {
    timeout?: number;
    retries?: number;
    skipCache?: boolean;
  };
  metadata?: Record<string, any>;
}

// UTCP Response Format
export interface UtcpExecutionResult {
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata: {
    executionTime: number;
    toolId: string;
    callTemplateId: string;
    requestId: string;
    timestamp: string;
    cached?: boolean;
    retryCount?: number;
    httpStatus?: number;
  };
}

// UTCP Discovery
export interface UtcpDiscoveryInfo {
  protocol: 'utcp';
  version: string;
  server: {
    name: string;
    version: string;
    description?: string;
    contact?: {
      name?: string;
      email?: string;
      url?: string;
    };
  };
  endpoints: {
    manual: string; // GET endpoint for the tool manual
    execute: string; // POST endpoint for tool execution (optional - for proxy mode)
    health: string; // Health check endpoint
  };
  capabilities: {
    directCalling: boolean;
    proxyMode: boolean;
    authentication: string[];
    protocols: string[];
    formats: string[];
  };
  experimental?: {
    apifai?: {
      universalApiTranslation: boolean;
      supportedApiFormats: string[];
      autoGeneration: boolean;
    };
  };
}