// Advanced Plugin Architecture Types
// Enhanced beyond mcp-context-forge capabilities

export interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  repository?: string;
  license?: string;
  isActive: boolean;
  organizationId?: string; // null for global plugins
  configuration: PluginConfiguration;
  capabilities: PluginCapabilities;
  hooks: PluginHookConfiguration[];
  dependencies?: string[]; // Other plugin IDs
  metadata: {
    installationDate: string;
    lastUpdated: string;
    usageCount: number;
    averageExecutionTime: number;
    errorRate: number;
    [key: string]: any;
  };
}

export interface PluginConfiguration {
  enabled: boolean;
  priority: number; // 1-100, higher = earlier execution
  settings: Record<string, any>;
  environment?: Record<string, string>;
  resources?: {
    maxMemory?: number;
    maxCpuTime?: number;
    maxNetworkCalls?: number;
  };
  security?: {
    allowedHosts?: string[];
    allowedPaths?: string[];
    deniedOperations?: string[];
  };
}

export interface PluginCapabilities {
  hooks: PluginHookType[];
  protocols: string[]; // ['mcp', 'utcp', 'a2a', 'http']
  dataFormats: string[]; // ['json', 'xml', 'yaml', 'protobuf']
  operations: string[]; // ['read', 'write', 'execute', 'transform']
  experimental?: Record<string, boolean>;
}

// Plugin Hook System
export enum PluginHookType {
  // Request/Response lifecycle
  PRE_REQUEST = 'pre_request',
  POST_REQUEST = 'post_request',
  PRE_RESPONSE = 'pre_response',
  POST_RESPONSE = 'post_response',
  
  // Tool execution lifecycle
  PRE_TOOL_EXECUTION = 'pre_tool_execution',
  POST_TOOL_EXECUTION = 'post_tool_execution',
  TOOL_EXECUTION_ERROR = 'tool_execution_error',
  
  // Schema processing lifecycle
  PRE_SCHEMA_PARSE = 'pre_schema_parse',
  POST_SCHEMA_PARSE = 'post_schema_parse',
  PRE_TOOL_GENERATION = 'pre_tool_generation',
  POST_TOOL_GENERATION = 'post_tool_generation',
  
  // Authentication and authorization
  PRE_AUTH = 'pre_auth',
  POST_AUTH = 'post_auth',
  AUTH_FAILED = 'auth_failed',
  
  // API communication
  PRE_API_CALL = 'pre_api_call',
  POST_API_CALL = 'post_api_call',
  API_CALL_ERROR = 'api_call_error',
  
  // Session management
  SESSION_START = 'session_start',
  SESSION_END = 'session_end',
  
  // Agent communication (A2A)
  PRE_AGENT_MESSAGE = 'pre_agent_message',
  POST_AGENT_MESSAGE = 'post_agent_message',
  
  // Data transformation
  DATA_TRANSFORM = 'data_transform',
  DATA_VALIDATE = 'data_validate',
  DATA_FILTER = 'data_filter',
  
  // Custom hooks
  CUSTOM = 'custom',
}

export interface PluginHookConfiguration {
  type: PluginHookType;
  handler: string; // Function name in plugin
  async: boolean;
  timeout?: number;
  retries?: number;
  conditions?: PluginCondition[];
}

export interface PluginCondition {
  type: 'equals' | 'contains' | 'regex' | 'custom';
  field: string; // JSONPath to field
  value: any;
  operator?: 'and' | 'or';
}

// Plugin Execution Context
export interface PluginContext {
  hookType: PluginHookType;
  organizationId: string;
  userId?: string;
  sessionId?: string;
  requestId: string;
  data: any; // The data being processed
  metadata: {
    timestamp: string;
    plugin: {
      id: string;
      name: string;
      version: string;
    };
    execution: {
      attempt: number;
      timeout: number;
      startTime: number;
      executionTime?: number;
    };
    request?: {
      method: string;
      endpoint: string;
      headers: Record<string, string>;
    };
    tool?: {
      id: string;
      name: string;
      operation?: string;
    };
    api?: {
      id: string;
      name: string;
      type: string;
    };
    correlationId?: string;
    httpStatus?: number;
    rateLimitKey?: string;
    performanceTracking?: any;
    pluginResults?: Array<{
      pluginId: string;
      executionTime: number;
      modifications: string[];
    }>;
    [key: string]: any;
  };
}

export interface PluginResult {
  success: boolean;
  data: any; // Modified/processed data
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata: {
    executionTime: number;
    modifications: string[]; // List of changes made
    warnings?: string[];
    logs?: Array<{
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      timestamp: string;
    }>;
  };
  nextAction?: 'continue' | 'stop' | 'retry' | 'skip';
}

// Built-in Plugin Types
export enum BuiltInPluginType {
  PII_FILTER = 'pii_filter',
  RATE_LIMITER = 'rate_limiter',
  CACHE_MANAGER = 'cache_manager',
  REQUEST_LOGGER = 'request_logger',
  RESPONSE_TRANSFORMER = 'response_transformer',
  ERROR_HANDLER = 'error_handler',
  SECURITY_SCANNER = 'security_scanner',
  PERFORMANCE_MONITOR = 'performance_monitor',
  DATA_VALIDATOR = 'data_validator',
  AUTHENTICATION_ENHANCER = 'authentication_enhancer',
}

// Plugin Registry
export interface PluginRegistry {
  plugins: Map<string, Plugin>;
  byHook: Map<PluginHookType, string[]>; // Plugin IDs by hook type
  byOrganization: Map<string, string[]>; // Plugin IDs by organization
  globalPlugins: string[]; // Global plugin IDs
}

// Plugin Manager Configuration
export interface PluginManagerConfig {
  maxConcurrentExecutions: number;
  defaultTimeout: number;
  enableSandbox: boolean;
  allowUnsafePlugins: boolean;
  pluginDirectory?: string;
  registryUrl?: string;
}

// Plugin Installation
export interface PluginInstallation {
  id: string;
  status: 'pending' | 'installing' | 'installed' | 'failed' | 'disabled';
  plugin: Plugin;
  logs: Array<{
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    message: string;
  }>;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

// Plugin Marketplace
export interface PluginMarketplaceEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: 'security' | 'performance' | 'data' | 'integration' | 'utility';
  tags: string[];
  downloadUrl: string;
  documentationUrl?: string;
  sourceUrl?: string;
  license: string;
  pricing?: {
    type: 'free' | 'paid' | 'subscription';
    amount?: number;
    currency?: string;
  };
  compatibility: {
    almytyVersion: string;
    protocolSupport: string[];
  };
  stats: {
    downloads: number;
    rating: number;
    reviews: number;
  };
  screenshots?: string[];
}

// Plugin Events
export interface PluginEvent {
  id: string;
  pluginId: string;
  type: 'installed' | 'activated' | 'deactivated' | 'uninstalled' | 'error' | 'warning';
  message: string;
  data?: any;
  timestamp: Date;
  organizationId?: string;
  userId?: string;
}