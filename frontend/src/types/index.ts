import type { Agent, GatewayTool, GatewayAuth, LlmSession, UsageMetric } from './usage';
// Auth Types
export interface User {
  id: string
  email: string
  name: string
  role: UserRole
  isEmailVerified: boolean
  // Notifications contract field — backend ships this alongside
  // isEmailVerified. Absent/undefined means "treat as verified"
  // (do not nag sessions created before the field existed).
  emailVerified?: boolean
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
  kind: GatewayKind
  type: GatewayType
  status: GatewayStatus
  organizationId: string
  agentId?: string
  agent?: Agent
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
  isSystem?: boolean
  createdAt: string
  updatedAt: string
  organization: Organization
  tools: GatewayTool[]
  authConfigs: GatewayAuth[]
  llmSessions: LlmSession[]
  usageMetrics: UsageMetric[]
}

export enum GatewayKind {
  TOOL = 'tool',
  AGENT = 'agent',
}

export enum GatewayType {
  MCP = 'mcp',
  A2A = 'a2a',
  UTCP = 'utcp',
  SKILLS = 'skills',
  OPENAI_CHAT = 'openai_chat',
  SLACK = 'slack',
  DISCORD = 'discord',
  TELEGRAM = 'telegram',
  WHATSAPP = 'whatsapp',
  EMAIL = 'email',
  WEBHOOK = 'webhook',
  GOOGLE_CHAT = 'google_chat',
  MICROSOFT_TEAMS = 'microsoft_teams',
  SIGNAL = 'signal',
  MATRIX = 'matrix',
  IRC = 'irc',
  CHAT_WIDGET = 'chat_widget',
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
  runnerConfig?: {
    runnerId: string
    runnerName: string
    method: string
    requiresWorkspace: boolean
  } | null
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

export * from './usage';
export * from './runtime';
export * from './notification';