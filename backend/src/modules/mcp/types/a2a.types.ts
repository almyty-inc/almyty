// Agent-to-Agent (A2A) Protocol Types

export interface A2AAgent {
  id: string;
  name: string;
  description?: string;
  type: A2AAgentType;
  organizationId: string;
  endpoint: string;
  capabilities: A2ACapabilities;
  configuration: A2AConfiguration;
  authentication?: A2AAuthentication;
  isActive: boolean;
  lastSeen: Date;
  metadata?: {
    provider?: string;
    model?: string;
    version?: string;
    responseTime?: number;
    successRate?: number;
    totalInteractions?: number;
    [key: string]: any;
  };
}

export enum A2AAgentType {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  COHERE = 'cohere',
  CUSTOM_LLM = 'custom_llm',
  TOOL_AGENT = 'tool_agent',
  FUNCTION_AGENT = 'function_agent',
  WORKFLOW_AGENT = 'workflow_agent',
}

export interface A2ACapabilities {
  protocols: string[]; // ['http', 'websocket', 'grpc']
  messageFormats: string[]; // ['json', 'protobuf', 'custom']
  functions: {
    calling: boolean;
    streaming: boolean;
    chaining: boolean;
    parallel: boolean;
  };
  memory: {
    persistent: boolean;
    contextWindow: number;
    retrieval: boolean;
  };
  specializations?: string[]; // ['code', 'data_analysis', 'reasoning']
  experimental?: Record<string, any>;
}

export interface A2AConfiguration {
  baseUrl: string;
  timeout: number;
  retries: number;
  rateLimits?: {
    requestsPerMinute?: number;
    requestsPerHour?: number;
  };
  headers?: Record<string, string>;
  parameters?: Record<string, any>;
}

export interface A2AAuthentication {
  type: 'api_key' | 'bearer' | 'oauth2' | 'custom';
  config: {
    apiKey?: string;
    token?: string;
    clientId?: string;
    clientSecret?: string;
    scope?: string;
    custom?: Record<string, any>;
  };
  location: 'header' | 'query' | 'body';
  parameter?: string;
}

// A2A Message Protocol
export interface A2AMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  type: A2AMessageType;
  content: A2AContent;
  context?: A2AContext;
  metadata?: {
    timestamp: string;
    priority?: number;
    expiresAt?: string;
    correlationId?: string;
    [key: string]: any;
  };
}

export enum A2AMessageType {
  REQUEST = 'request',
  RESPONSE = 'response',
  NOTIFICATION = 'notification',
  FUNCTION_CALL = 'function_call',
  FUNCTION_RESULT = 'function_result',
  TOOL_INVOCATION = 'tool_invocation',
  TOOL_RESULT = 'tool_result',
  WORKFLOW_START = 'workflow_start',
  WORKFLOW_STEP = 'workflow_step',
  WORKFLOW_COMPLETE = 'workflow_complete',
}

export interface A2AContent {
  text?: string;
  data?: any;
  function?: {
    name: string;
    arguments: Record<string, any>;
  };
  tool?: {
    name: string;
    parameters: Record<string, any>;
  };
  workflow?: {
    id: string;
    step: string;
    payload: any;
  };
}

export interface A2AContext {
  conversationId?: string;
  organizationId: string;
  userId?: string;
  sessionId?: string;
  workflowId?: string;
  stepId?: string;
  parentMessageId?: string;
  tools?: string[]; // Available tool names
  resources?: string[]; // Available resource URIs
  constraints?: Record<string, any>;
  preferences?: Record<string, any>;
}

// A2A Session Management
export interface A2ASession {
  id: string;
  organizationId: string;
  participantAgents: string[];
  status: A2ASessionStatus;
  startedAt: Date;
  lastActivity: Date;
  messageCount: number;
  metadata?: {
    purpose?: string;
    workflow?: string;
    initiatedBy?: string;
    [key: string]: any;
  };
}

export enum A2ASessionStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

// A2A Tool Registration
export interface A2AToolRegistration {
  agentId: string;
  toolName: string;
  description: string;
  inputSchema: any;
  outputSchema?: any;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  authentication?: A2AAuthentication;
  examples?: Array<{
    name: string;
    input: Record<string, any>;
    expectedOutput?: any;
  }>;
}

// A2A Workflow Types
export interface A2AWorkflow {
  id: string;
  name: string;
  description?: string;
  organizationId: string;
  steps: A2AWorkflowStep[];
  triggers: A2AWorkflowTrigger[];
  isActive: boolean;
  metadata?: Record<string, any>;
}

export interface A2AWorkflowStep {
  id: string;
  name: string;
  type: 'agent_call' | 'tool_call' | 'condition' | 'parallel' | 'loop';
  agentId?: string;
  toolId?: string;
  configuration: Record<string, any>;
  dependencies?: string[]; // Step IDs that must complete first
  timeout?: number;
}

export interface A2AWorkflowTrigger {
  id: string;
  type: 'manual' | 'schedule' | 'webhook' | 'event';
  configuration: Record<string, any>;
  isActive: boolean;
}

// A2A Discovery
export interface A2ADiscoveryInfo {
  protocol: 'a2a';
  version: string;
  server: {
    name: string;
    version: string;
    description?: string;
  };
  endpoints: {
    agents: string;
    sessions: string;
    messages: string;
    workflows: string;
    discovery: string;
  };
  capabilities: {
    agentTypes: A2AAgentType[];
    messageTypes: A2AMessageType[];
    authentication: string[];
    transports: string[];
    features: string[];
  };
  experimental?: {
    almyty?: {
      universalApiTranslation: boolean;
      workflowOrchestration: boolean;
      multiProtocolBridge: boolean;
    };
  };
}

// A2A Metrics
export interface A2AMetrics {
  agentId: string;
  totalMessages: number;
  successfulMessages: number;
  failedMessages: number;
  averageResponseTime: number;
  lastActivity: Date;
  capabilities: {
    functionsUsed: string[];
    toolsUsed: string[];
    workflowsParticipated: string[];
  };
  performance: {
    uptime: number;
    errorRate: number;
    throughput: number;
  };
}

// A2A Events
export interface A2AEvent {
  id: string;
  type: 'agent_registered' | 'agent_deregistered' | 'message_sent' | 'message_received' | 'session_started' | 'session_ended' | 'workflow_triggered' | 'workflow_completed';
  agentId?: string;
  sessionId?: string;
  workflowId?: string;
  data: any;
  timestamp: Date;
  organizationId: string;
}