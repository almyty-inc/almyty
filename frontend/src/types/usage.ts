import type { Gateway, Tool, LlmProvider, User, Organization, Api, ApiAuthType } from './index';
// Usage Metrics Types
export interface UsageMetric {
  id: string
  type: MetricType
  value: number
  status: MetricStatus
  gatewayId?: string
  toolId?: string
  userId?: string
  organizationId?: string
  llmProviderId?: string
  dimensions?: Record<string, any>
  metadata?: {
    requestId?: string
    userAgent?: string
    ipAddress?: string
    endpoint?: string
    method?: string
    statusCode?: number
    errorMessage?: string
    responseSize?: number
    requestSize?: number
  }
  timestamp: string
  createdAt: string
  gateway?: Gateway
  tool?: Tool
  user?: User
  organization?: Organization
  llmProvider?: LlmProvider
}

export enum MetricType {
  REQUEST_COUNT = 'request_count',
  RESPONSE_TIME = 'response_time',
  ERROR_RATE = 'error_rate',
  THROUGHPUT = 'throughput',
  CACHE_HIT_RATE = 'cache_hit_rate',
  BANDWIDTH_USAGE = 'bandwidth_usage',
  CONCURRENT_USERS = 'concurrent_users',
  API_CALLS = 'api_calls',
  TOOL_EXECUTIONS = 'tool_executions',
}

export enum MetricStatus {
  SUCCESS = 'success',
  ERROR = 'error',
  TIMEOUT = 'timeout',
  RATE_LIMITED = 'rate_limited',
  UNAUTHORIZED = 'unauthorized',
}

// Additional utility types
export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

// Entity-specific paginated responses matching backend shapes
export interface PaginatedTools {
  tools: Tool[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface PaginatedGateways {
  gateways: Gateway[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface PaginatedApis {
  apis: Api[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface PaginatedAgents {
  data: Agent[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface PaginatedAgentExecutions {
  data: AgentExecution[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface PaginatedLlmProviders {
  providers: LlmProvider[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface PaginatedUsers {
  users: User[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface PaginatedGatewayTools {
  gatewayTools: GatewayTool[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface PaginatedSessions {
  sessions: LlmSession[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface Dashboard {
  totalRequests: number
  totalUsers: number
  totalOrganizations: number
  totalGateways: number
  totalTools: number
  recentActivity: Activity[]
  metrics: {
    requests: { current: number; change: number }
    responseTime: { current: number; change: number }
    errorRate: { current: number; change: number }
    costs: { current: number; change: number }
  }
}

export interface Activity {
  id: string
  type: string
  description: string
  userId?: string
  organizationId?: string
  metadata?: Record<string, any>
  timestamp: string
}

// Additional entity types referenced in relationships
export interface GatewayTool {
  id: string
  gatewayId: string
  toolId: string
  isActive: boolean
  configuration?: Record<string, any>
  createdAt: string
  gateway: Gateway
  tool: Tool
}

export interface GatewayAuth {
  id: string
  gatewayId: string
  type: ApiAuthType
  configuration: Record<string, any>
  isActive: boolean
  createdAt: string
  gateway: Gateway
}

export interface LlmSession {
  id: string
  gatewayId?: string
  llmProviderId: string
  organizationId: string
  userId?: string
  configuration: Record<string, any>
  totalTokens: number
  inputTokens: number
  outputTokens: number
  totalCost: number
  toolCalls: number
  messageCount: number
  status: string
  metadata?: Record<string, any>
  startedAt: string
  endedAt?: string
  createdAt: string
  gateway?: Gateway
  llmProvider: LlmProvider
  organization: Organization
  user?: User
  messages: LlmMessage[]
}

export interface LlmMessage {
  id: string
  sessionId: string
  role: string
  content: any
  toolCalls?: any[]
  toolResults?: any[]
  tokenCount: number
  cost: number
  metadata?: Record<string, any>
  timestamp: string
  createdAt: string
  session: LlmSession
}

// Agent Orchestration
export enum AgentStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}

export interface AgentPipeline {
  nodes: PipelineNode[]
  edges: PipelineEdge[]
  viewport?: { x: number; y: number; zoom: number }
}

export interface PipelineNode {
  id: string
  type: 'input' | 'output' | 'llm_call' | 'tool_call' | 'condition' | 'transform' | 'merge' | 'parallel' | 'sub_agent'
  position: { x: number; y: number }
  data: Record<string, any>
}

export interface PipelineEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  label?: string
}

export interface Agent {
  id: string
  name: string
  description?: string
  organizationId: string
  status: AgentStatus
  version: string
  mode: 'workflow' | 'autonomous'
  pipeline: AgentPipeline
  instructions?: string
  personality?: string
  heartbeat?: {
    enabled: boolean
    intervalMinutes: number
    prompt: string
  }
  toolIds?: string[]
  modelConfig?: {
    providerId?: string
    model?: string
    temperature?: number
    maxTokens?: number
  }
  memoryConfig?: {
    enabled?: boolean
    autoSave?: boolean
    scopes?: string[]
  }
  agentConfig?: {
    canCallAgents?: boolean
    canCreateAgents?: boolean
    verify?: {
      enabled?: boolean
      checkers?: Array<{ name?: string; providerId?: string; model?: string; instructions?: string }>
      policy?: 'all_pass' | 'majority' | 'any_fail_blocks'
      spec?: string
      maxReviseLoops?: number
      triggers?: Array<'on_final_output' | 'every_n_steps' | 'on_tool_result'>
      everyNSteps?: number
    }
    constraints?: {
      enabled?: boolean
      autoLearn?: boolean
    }
  }
  isTemporary?: boolean
  collaboration?: {
    strategy: 'sequential' | 'parallel' | 'race' | 'debate'
    agents: { agentId: string; role?: string }[]
    sharedBrief?: string
    rules?: {
      maxTotalCost?: number
      maxChainDepth?: number
      outputFormat?: 'text' | 'json'
      escalation?: 'never' | 'on_failure' | 'on_low_confidence'
      conflictResolution?: 'judge' | 'majority' | 'first_wins' | 'merge'
      sharedMemoryScope?: boolean
      allowRevision?: boolean
    }
    judgeAgentId?: string
    maxRounds?: number
  }
  variables?: Record<string, any>
  settings?: {
    maxExecutionTime?: number
    maxNestingDepth?: number
    maxParallelNodes?: number
    budgetLimit?: number
    enableStreaming?: boolean
    schedule?: {
      enabled: boolean
      intervalMinutes: number
      input: Record<string, any>
    }
  }
  metadata?: Record<string, any>
  webhookUrl?: string
  totalExecutions: number
  successfulExecutions: number
  totalCost: number
  averageExecutionTime: number
  lastExecutedAt?: string
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface AgentExecution {
  id: string
  agentId: string
  organizationId: string
  userId?: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'
  input?: Record<string, any>
  output?: any
  nodeResults?: Record<string, {
    nodeId: string
    nodeType: string
    status: string
    executionTime?: number
    input?: any
    output?: any
    error?: string
    cost?: number
    tokens?: { input: number; output: number }
  }>
  executionTime: number
  totalCost: number
  totalTokens: number
  error?: string
  metadata?: Record<string, any>
  createdAt: string
  updatedAt: string
}

// Credential type returned from the API
export interface ApiCredential {
  id: string
  name: string
  type: string
  isExpired?: boolean
  lastUsedAt?: string
}

export enum CredentialType {
  API_KEY = 'api_key',
  BEARER_TOKEN = 'bearer_token',
  BASIC_AUTH = 'basic_auth',
  OAUTH2 = 'oauth2',
  JWT = 'jwt',
  CUSTOM = 'custom',
  AWS_SIGV4 = 'aws_sigv4',
  GOOGLE_SERVICE_ACCOUNT = 'google_service_account',
  MTLS = 'mtls',
}

export interface OAuth2Preset {
  name: string
  authorizationUrl: string
  tokenUrl: string
  defaultScopes: string[]
  requiresPKCE: boolean
}

// Request log entry returned from analytics API
export interface RequestLog {
  id: string
  method: string
  path: string
  statusCode: number
  responseTime: number
  protocol?: string
  ipAddress?: string
  timestamp: string
}

// Tool usage analytics entry
export interface ToolUsageEntry {
  toolId: string
  totalExecutions: number
  successRate: number
  avgExecutionTime: number
  lastUsed: string | null
}

// Gateway usage analytics entry
export interface GatewayUsageEntry {
  gatewayId: string
  totalRequests: number
  successCount: number
  errorCount: number
  successRate: number
}

// LLM usage analytics entry
export interface LlmUsageEntry {
  providerId: string
  sessionCount: number
  totalMessages: number
  totalInputTokens: number
  totalOutputTokens: number
  totalToolCalls: number
  totalCostCents: number
}

// Timeline data point
export interface TimelineEntry {
  timestamp?: string
  date?: string
  requests?: number
  count?: number
}

// Analytics overview
export interface AnalyticsOverview {
  last24h: {
    requests: number
    toolExecutions: number
    avgResponseTime: number
    errors: number
    llmSessions: number
  }
  last7d: {
    requests: number
    toolExecutions: number
    llmCostCents: number
  }
}

// Gateway tool association (for tool-detail page)
export interface GatewayToolAssociation {
  id: string
  gateway?: {
    id: string
    name: string
    endpoint?: string
    type?: string
  }
}

// Agent version snapshot
export interface AgentVersionSnapshot {
  version: string
  pipeline: AgentPipeline
  savedAt: string
  changelog: string
}

// Agent cost estimate
export interface AgentCostEstimate {
  estimatedLlmCalls: number
  estimatedToolCalls: number
  hasParallelExecution: boolean
  estimatedCostRange: {
    low: number
    high: number
  }
  nodeCount: number
  edgeCount: number
}

export interface VaultCredential {
  id: string
  name: string
  type: string
  description?: string
  isActive: boolean
  lastUsedAt?: string
  expiresAt?: string
  createdAt: string
  usedBy?: { type: string; id: string; name?: string }[]
  organizationId: string
}

export interface AccessKey {
  id: string
  keyPrefix: string
  name: string
  scopes: string[]
  gatewayId?: string
  agentId?: string
  gateway?: { id: string; name: string; type: string }
  agent?: { id: string; name: string }
  isActive: boolean
  lastUsedAt?: string
  expiresAt?: string
  createdAt: string
}

// Agent audit log entry
export interface AgentAuditEntry {
  action: string
  userId: string
  timestamp: string
  details?: Record<string, unknown>
}

