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

export interface PromotedSkill {
  id: string
  organizationId: string
  agentId?: string
  sourceRunId?: string
  name: string
  slug: string
  description?: string
  content: string
  frontmatter?: Record<string, any>
  inputExample?: any
  version: number
  createdBy?: string
  createdAt: string
  updatedAt: string
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

// ── External Agents (imported A2A) ──

export type ExternalAgentStatus = 'active' | 'error' | 'card_stale'

export interface ExternalAgent {
  id: string
  organizationId: string
  name: string
  description?: string
  agentCardUrl: string
  cachedCard?: any
  cardLastFetchedAt?: string
  baseRpcUrl?: string
  credentialId?: string
  status: ExternalAgentStatus
  totalRequests: number
  successfulRequests: number
  createdAt: string
  updatedAt: string
}