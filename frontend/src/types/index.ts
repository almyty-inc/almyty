// Auth Types
export interface User {
  id: string
  email: string
  name: string
  role: UserRole
  isEmailVerified: boolean
  avatar?: string
  createdAt: string
  updatedAt: string
  organizationMemberships: OrganizationMembership[]
}

export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  USER = 'user',
}

export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest {
  email: string
  password: string
  name: string
}

export interface AuthResponse {
  user: User
  token: string
  refreshToken: string
}

// Organization Types
export interface OrganizationAgentDefaults {
  personality?: string
  rules?: string
  maxCostPerRun?: number
  maxStepsPerRun?: number
}

export interface Organization {
  id: string
  name: string
  slug?: string
  description?: string
  plan: OrganizationPlan
  settings: OrganizationSettings
  agentDefaults?: OrganizationAgentDefaults
  billingInfo?: BillingInfo
  isActive: boolean
  createdAt: string
  updatedAt: string
  members: OrganizationMembership[]
  gateways: Gateway[]
  apis: Api[]
  tools: Tool[]
}

export enum OrganizationPlan {
  FREE = 'free',
  BASIC = 'basic',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

export interface OrganizationSettings {
  maxGateways: number
  maxApis: number
  maxTools: number
  allowedDomains?: string[]
  webhookUrl?: string
}

export interface BillingInfo {
  customerId?: string
  subscriptionId?: string
  paymentMethodId?: string
  currentPeriodStart: string
  currentPeriodEnd: string
  trialEnd?: string
  cancelAtPeriodEnd: boolean
}

export interface OrganizationMembership {
  id: string
  userId: string
  organizationId: string
  role: OrganizationRole
  joinedAt: string
  email?: string
  user: User
  organization: Organization
}

export enum OrganizationRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
  VIEWER = 'viewer',
}

// Gateway Types
export interface Gateway {
  id: string
  name: string
  description?: string
  type: GatewayType
  status: GatewayStatus
  organizationId: string
  endpoint: string
  configuration: Record<string, any>
  rateLimitConfig?: RateLimitConfig
  corsConfig?: CorsConfig
  webhooks?: WebhookConfig
  requestTimeout: number
  maxRetries: number
  customHeaders?: Record<string, string>
  healthCheck?: HealthCheckConfig
  metadata?: Record<string, any>
  totalRequests: number
  successfulRequests: number
  lastRequestAt?: string
  lastHealthCheckAt?: string
  isHealthy: boolean
  createdAt: string
  updatedAt: string
  organization: Organization
  tools: GatewayTool[]
  authConfigs: GatewayAuth[]
  llmSessions: LlmSession[]
  usageMetrics: UsageMetric[]
}

export enum GatewayType {
  MCP = 'mcp',
  A2A = 'a2a',
  UTCP = 'utcp',
  SKILLS = 'skills',
}

export enum GatewayStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  MAINTENANCE = 'maintenance',
  ERROR = 'error',
}

export interface RateLimitConfig {
  enabled: boolean
  requestsPerMinute?: number
  requestsPerHour?: number
  requestsPerDay?: number
  burstLimit?: number
  windowSize?: number
}

export interface CorsConfig {
  origins: string[]
  methods: string[]
  allowedHeaders: string[]
  credentials: boolean
}

export interface WebhookConfig {
  enabled: boolean
  endpoints: Array<{
    url: string
    events: string[]
    secret?: string
  }>
}

export interface HealthCheckConfig {
  enabled: boolean
  endpoint?: string
  interval?: number
  timeout?: number
}

// API Types
export interface Api {
  id: string
  name: string
  description?: string
  type: ApiType
  baseUrl: string
  version?: string
  organizationId: string
  configuration: ApiConfiguration
  authentication?: ApiAuthentication
  rateLimitConfig?: RateLimitConfig
  schema?: ApiSchema
  schemas?: any[]
  operations?: ApiOperation[]
  metadata?: Record<string, any>
  isActive: boolean
  lastTestedAt?: string
  healthStatus: ApiHealthStatus
  createdAt: string
  updatedAt: string
  organization: Organization
  tools: Tool[]
}

export enum ApiType {
  OPENAPI = 'openapi',
  GRAPHQL = 'graphql',
  SOAP = 'soap',
  GRPC = 'grpc',
  HTTP = 'http',
  SDK = 'sdk',
  OTHER = 'other',
}

export interface ApiConfiguration {
  timeout?: number
  retries?: number
  headers?: Record<string, string>
  customConfig?: Record<string, any>
}

export interface ApiAuthentication {
  type: ApiAuthType
  config: Record<string, any>
}

export enum ApiAuthType {
  NONE = 'none',
  API_KEY = 'api_key',
  BEARER_TOKEN = 'bearer_token',
  BASIC_AUTH = 'basic_auth',
  OAUTH2 = 'oauth2',
  CUSTOM = 'custom',
}

export interface ApiSchema {
  format: SchemaFormat
  version?: string
  content: any
  operations: ApiOperation[]
}

export enum SchemaFormat {
  OPENAPI = 'openapi',
  GRAPHQL_SDL = 'graphql_sdl',
  WSDL = 'wsdl',
  PROTOBUF = 'protobuf',
  JSON_SCHEMA = 'json_schema',
}

export interface ApiOperation {
  id: string
  name: string
  method?: string
  path?: string
  endpoint?: string
  description?: string
  parameters: any[]
  responses: any[]
  metadata?: Record<string, any>
}

export enum ApiHealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
  UNKNOWN = 'unknown',
}

// Tool Types
export interface Tool {
  id: string
  name: string
  description?: string
  type: ToolType
  category: ToolCategory
  organizationId: string
  apiId?: string
  configuration: ToolConfiguration
  schema: ToolSchema
  metadata?: Record<string, any>
  isActive: boolean
  version: string
  usageCount: number
  lastUsedAt?: string
  createdAt: string
  updatedAt: string
  organization: Organization
  api?: Api
  gatewayTools: GatewayTool[]
  usageMetrics: UsageMetric[]
  httpConfig?: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    headers?: Record<string, string>
    queryParams?: Record<string, string>
    bodyEncoding?: 'json' | 'form-urlencoded' | 'multipart' | 'raw'
    bodyTemplate?: string
    responseMapping?: {
      dataPath?: string
      errorPath?: string
      successCondition?: string
    }
    pagination?: {
      type: 'cursor' | 'offset' | 'link-header'
      cursorPath?: string
      cursorParam?: string
      offsetParam?: string
      limitParam?: string
      defaultLimit?: number
      resultsPath?: string
      maxPages?: number
    }
  } | null
  dependencies?: Record<string, string> | null
  npmRegistry?: any | null
  sdkConfig?: any | null
}

export interface ToolTemplate {
  id: string
  name: string
  description: string
  provider: string
  providerIcon?: string
  category: string
  tags: string[]
  executionMethod: string
  httpConfig?: any
  parameters: Record<string, any>
  configuration: Record<string, any>
  examples: Array<{ name: string; input: any; expectedOutput?: any }>
  apiConfig?: { name: string; baseUrl: string; headers?: Record<string, string>; authRequirements?: { type: string; scopes?: string[]; setupInstructions?: string } }
  isBuiltIn: boolean
  version: string
  installCount: number
}

export enum ToolType {
  API_OPERATION = 'api_operation',
  CUSTOM_FUNCTION = 'custom_function',
  WEBHOOK = 'webhook',
  DATABASE_QUERY = 'database_query',
  FILE_OPERATION = 'file_operation',
}

export enum ToolCategory {
  DATA_RETRIEVAL = 'data_retrieval',
  DATA_MANIPULATION = 'data_manipulation',
  COMMUNICATION = 'communication',
  COMPUTATION = 'computation',
  AUTOMATION = 'automation',
  INTEGRATION = 'integration',
  UTILITY = 'utility',
}

export interface ToolConfiguration {
  timeout?: number
  retries?: number
  caching?: {
    enabled: boolean
    ttl?: number
  }
  validation?: {
    enabled: boolean
    strict?: boolean
  }
  customConfig?: Record<string, any>
}

export interface ToolSchema {
  input: any
  output: any
  errors?: any[]
}

// LLM Provider Types
export interface LlmProvider {
  id: string
  name: string
  type: LlmProviderType
  organizationId: string
  configuration: LlmProviderConfiguration
  isActive: boolean
  capabilities: LlmCapability[]
  rateLimits?: RateLimitConfig
  costConfig: LlmCostConfig
  metadata?: Record<string, any>
  lastUsedAt?: string
  createdAt: string
  updatedAt: string
  organization: Organization
  sessions: LlmSession[]
  usageMetrics: UsageMetric[]
}

export enum LlmProviderType {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  COHERE = 'cohere',
  HUGGINGFACE = 'huggingface',
  AZURE_OPENAI = 'azure_openai',
  AWS_BEDROCK = 'aws_bedrock',
  CUSTOM = 'custom',
}

export interface LlmProviderConfiguration {
  apiKey?: string
  baseUrl?: string
  model?: string
  temperature?: number
  maxTokens?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  timeout?: number
  customConfig?: Record<string, any>
}

export enum LlmCapability {
  TEXT_COMPLETION = 'text_completion',
  CHAT_COMPLETION = 'chat_completion',
  FUNCTION_CALLING = 'function_calling',
  CODE_GENERATION = 'code_generation',
  IMAGE_ANALYSIS = 'image_analysis',
  EMBEDDINGS = 'embeddings',
  FINE_TUNING = 'fine_tuning',
}

export interface LlmCostConfig {
  inputTokenCost: number
  outputTokenCost: number
  currency: string
  billingUnit: string
}

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

// ── Agent Runtime (Autonomous Mode) ──

export type AgentRunMode = 'workflow' | 'autonomous'

export type AgentRunStatus = 'pending' | 'running' | 'waiting_input' | 'sleeping' | 'completed' | 'failed' | 'cancelled' | 'timeout'

export interface AgentRunStep {
  type: string
  input?: any
  output?: any
  cost?: number
  tokens?: { input: number; output: number }
  duration?: number
  timestamp: string
  error?: string
}

export interface AgentRun {
  id: string
  agentId: string
  organizationId: string
  userId?: string
  mode: AgentRunMode
  status: AgentRunStatus
  thread: Array<{ role: string; content: any; toolCalls?: any[]; toolCallId?: string; timestamp?: string }>
  workingMemory: Record<string, any>
  steps: AgentRunStep[]
  currentStep: number
  maxSteps: number
  input?: Record<string, any>
  output?: any
  error?: string
  totalCost: number
  totalTokens: number
  executionTime: number
  metadata?: Record<string, any>
  limits?: {
    maxSteps?: number
    maxDurationMs?: number
    maxCostCents?: number
    maxTokens?: number
    maxToolCalls?: number
  }
  parentRunId?: string
  createdAt: string
  updatedAt: string
}

export interface PaginatedAgentRuns {
  data: AgentRun[]
  total: number
  page: number
  limit: number
  totalPages: number
}

// ── Memory System ──

export type MemoryType = 'fact' | 'preference' | 'context' | 'episode' | 'instruction'
export type MemoryScope = 'agent' | 'shared' | 'global'

export interface Memory {
  id: string
  organizationId: string
  type: MemoryType
  content: string
  embedding?: number[]
  source?: { type: string; id?: string; name?: string }
  scope: MemoryScope
  agentIds: string[]
  tags: string[]
  metadata?: Record<string, any>
  isActive: boolean
  accessCount: number
  lastAccessedAt?: string
  createdBy?: string
  createdAt: string
  updatedAt: string
  similarity?: number
}

export interface PaginatedMemories {
  data: Memory[]
  total: number
  page: number
  limit: number
  totalPages: number
}

// ── File Store ──

export interface AgentFile {
  id: string
  organizationId: string
  agentId?: string
  runId?: string
  name: string
  mimeType: string
  size: number
  storageKey: string
  storageUrl?: string
  extractedText?: string
  memoryId?: string
  uploadedBy?: string
  metadata?: Record<string, any>
  createdAt: string
  downloadUrl?: string
}

export interface PaginatedFiles {
  data: AgentFile[]
  total: number
  page: number
  limit: number
  totalPages: number
}

// ── Interfaces (Deployment Channels) ──

export type InterfaceType = 'chat_widget' | 'slack' | 'whatsapp' | 'discord' | 'email' | 'telegram' | 'webhook' | 'google_chat' | 'microsoft_teams' | 'signal' | 'matrix' | 'irc'
export type InterfaceStatus = 'active' | 'inactive' | 'error'

export interface AgentInterface {
  id: string
  agentId: string
  organizationId: string
  type: InterfaceType
  name: string
  status: InterfaceStatus
  configuration: Record<string, any>
  metadata?: Record<string, any>
  totalMessages: number
  lastMessageAt?: string
  createdAt: string
  updatedAt: string
}

// ── Comprehensive Audit Log ──

export type AuditAction =
  | 'create' | 'update' | 'delete'
  | 'activate' | 'deactivate' | 'execute' | 'invoke'
  | 'schedule' | 'unschedule' | 'duplicate' | 'import' | 'export' | 'rollback'
  | 'run_start' | 'run_complete' | 'run_fail' | 'run_cancel' | 'run_input'
  | 'tool_execute' | 'tool_activate' | 'tool_deactivate'
  | 'gateway_activate' | 'gateway_deactivate' | 'tool_assign' | 'tool_remove'
  | 'memory_store' | 'memory_recall' | 'memory_update' | 'memory_delete'
  | 'file_upload' | 'file_download' | 'file_delete'
  | 'interface_deploy' | 'interface_message'
  | 'login' | 'api_key_create' | 'api_key_revoke'
  | 'credential_create' | 'credential_update' | 'credential_delete' | 'credential_use'

export type AuditResource =
  | 'agent' | 'agent_run' | 'tool' | 'gateway' | 'api'
  | 'memory' | 'file' | 'interface' | 'credential'
  | 'api_key' | 'user' | 'organization' | 'llm_provider' | 'llm_session'

export interface AuditLogEntry {
  id: string
  organizationId: string
  userId?: string
  userEmail?: string
  action: AuditAction
  resourceType: AuditResource
  resourceId: string
  resourceName?: string
  details?: Record<string, any>
  changes?: { field: string; from: any; to: any }[]
  ipAddress?: string
  userAgent?: string
  status?: string
  duration?: number
  cost?: number
  metadata?: Record<string, any>
  createdAt: string
}

export interface PaginatedAuditLogs {
  data: AuditLogEntry[]
  total: number
  page: number
  limit: number
  totalPages: number
}

// ── SDK Map Types ──

export interface SdkMap {
  packageName: string
  version: string
  exports: SdkExport[]
}

export interface SdkExport {
  name: string
  kind: 'class' | 'function' | 'const' | 'namespace'
  description?: string
  constructorParams?: SdkParam[]
  methods?: SdkMethod[]
  properties?: SdkProperty[]
  params?: SdkParam[]
}

export interface SdkMethod {
  name: string
  description?: string
  params: SdkParam[]
  returnType?: SdkType
  isAsync: boolean
}

export interface SdkProperty {
  name: string
  description?: string
  type: SdkType
  methods?: SdkMethod[]
  properties?: SdkProperty[]
}

export interface SdkParam {
  name: string
  type: SdkType
  required: boolean
  description?: string
}

export interface SdkType {
  kind: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'union' | 'enum' | 'class_ref' | 'function' | 'any' | 'void' | 'buffer'
  properties?: SdkParam[]
  itemType?: SdkType
  enumValues?: string[]
  className?: string
  rawType?: string
}