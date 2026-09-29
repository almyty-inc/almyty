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
  /** Active member count, sent by the list endpoint, which does not hydrate `members`. */
  memberCount?: number
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

/**
 * The `settings` json column on the Organization row
 * (backend/src/entities/organization.entity.ts OrganizationSettings).
 *
 * Every key is optional there and a freshly created organization is
 * saved with no settings at all, so nothing here may be declared
 * required: `settings.maxApis` used to be typed `number` and is
 * `undefined` on every org the dashboard has ever loaded.
 */
export interface OrganizationSettings {
  /**
   * Consulted by the engine when an llm_call node names neither a provider
   * nor a policy of its own (agent-node-executor.defaultRoutingFor). The
   * builder reads it to know whether such a node is actually incomplete or
   * merely relying on the organization default.
   */
  defaultRouting?: Record<string, any> | null
  maxGateways?: number
  maxApis?: number
  maxTools?: number
  allowedApiTypes?: string[]
  defaultRateLimit?: { ttl: number; limit: number }
  webhooks?: { enabled: boolean; endpoints: string[] }
  /** Hosts this org may reach even though they resolve to a private address. */
  egressAllowlist?: string[]
  /**
   * Members may connect accounts only they can use. Read by the backend at
   * `settings.allowUserScopedConnections` (connections.service.ts) and
   * written there by connectionsApi.setUserScopedConnections; it is not a
   * top-level column, which is where this used to be declared.
   */
  allowUserScopedConnections?: boolean
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

/**
 * A user's membership of an organization.
 *
 * Two differently-shaped payloads land in this type. `GET /auth/profile`
 * re-projects each row as `{ id, role, joinedAt, organization: {...} }` —
 * there is NO flat `organizationId` on that wire, only the nested
 * organization — while `GET /organizations/:id/members` sends the fuller
 * row. `organizationId` is therefore optional; declaring it required is
 * what let `useOrganizationRole` match on a key that is always undefined
 * for the signed-in user, so `canManage` was false even for owners.
 */
export interface OrganizationMembership {
  id: string
  userId: string
  organizationId?: string
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
  /**
   * The key check ran and passed and the provider is on: the rule that makes
   * every model it lists usable, and what "Key works" shows.
   */
  keyChecked?: boolean
  /** Set with lastError; the error is current when it is newer than lastSuccessAt. */
  lastErrorAt?: string
  lastSuccessAt?: string

  /**
   * How many tools are assigned, on the LIST response only. The list used
   * to hydrate every nested Tool -- 2,000 entities with their code and
   * parameter schemas for a page of 20 gateways -- purely so the table
   * could render `tools.length`. The list now returns a correlated COUNT
   * and no `tools` array, so the count must be read from here; the detail
   * response still carries the real `tools`.
   */
  toolCount?: number
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
  ACP = 'acp',
  UTCP = 'utcp',
  SKILLS = 'skills',
  /** One address serving shared tools over MCP, UTCP and Skills at once. */
  TOOLS = 'tools',
  OPENAI_CHAT = 'openai_chat',
  SLACK = 'slack',
  DISCORD = 'discord',
  TELEGRAM = 'telegram',
  WHATSAPP = 'whatsapp',
  WHATSAPP_CLOUD = 'whatsapp_cloud',
  SMS = 'sms',
  EMAIL = 'email',
  WEBHOOK = 'webhook',
  GOOGLE_CHAT = 'google_chat',
  MICROSOFT_TEAMS = 'microsoft_teams',
  SIGNAL = 'signal',
  MATRIX = 'matrix',
  IRC = 'irc',
  CHAT_WIDGET = 'chat_widget',
  HOSTED_CHAT = 'hosted_chat',
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

/** Who can see and use a resource: its owner only, one team, or the whole organization. */
export type ResourceVisibility = 'private' | 'team' | 'org'

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
  /** 'private' = only its owner (ownerUserId) can see or use it. */
  visibility?: ResourceVisibility
  teamId?: string | null
  ownerUserId?: string | null
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
  /** 'private' = only its owner (createdBy) can see or use it. */
  visibility?: ResourceVisibility
  teamId?: string | null
  createdBy?: string | null
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
  /**
   * Null means public -- visible to every organization. A value means the
   * template belongs to that organization and only it can see, edit or
   * retract it.
   */
  organizationId: string | null
  sourceToolId?: string | null
  createdBy?: string | null
  version: string
  installCount: number
  createdAt?: string
  updatedAt?: string
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

/**
 * Mirrors the backend enum (backend/src/entities/llm-provider.entity.ts).
 * This list had drifted to 8 of the then-24 values; keep it complete, the
 * type union in components/llm-providers/schema.ts is derived from the same
 * set and a missing value silently narrows both.
 */
export enum LlmProviderType {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  MISTRAL = 'mistral',
  XAI = 'xai',
  DEEPSEEK = 'deepseek',
  GROQ = 'groq',
  TOGETHER = 'together',
  OPENROUTER = 'openrouter',
  STRAITLY = 'straitly',
  AZURE_OPENAI = 'azure_openai',
  AWS_BEDROCK = 'aws_bedrock',
  COHERE = 'cohere',
  HUGGINGFACE = 'huggingface',
  OLLAMA = 'ollama',
  FIREWORKS = 'fireworks',
  CEREBRAS = 'cerebras',
  DEEPINFRA = 'deepinfra',
  NOVITA = 'novita',
  PERPLEXITY = 'perplexity',
  ZAI = 'zai',
  BASETEN = 'baseten',
  NEBIUS = 'nebius',
  SAMBANOVA = 'sambanova',
  MOONSHOT = 'moonshot',
  QWEN = 'qwen',
  MINIMAX = 'minimax',
  UPSTAGE = 'upstage',
  WRITER = 'writer',
  QIANFAN = 'qianfan',
  HUNYUAN = 'hunyuan',
  VOLCENGINE = 'volcengine',
  SPARK = 'spark',
  VERTEX_AI = 'vertex_ai',
  AZURE_AI_FOUNDRY = 'azure_ai_foundry',
  DIGITALOCEAN = 'digitalocean',
  RUNPOD = 'runpod',
  MODAL = 'modal',
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
export * from './models';
export * from './notification';
export * from './agent-models';
