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
export interface Organization {
  id: string
  name: string
  description?: string
  plan: OrganizationPlan
  settings: OrganizationSettings
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