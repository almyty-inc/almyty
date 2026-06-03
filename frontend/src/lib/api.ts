import axios, { AxiosResponse, AxiosError } from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

// Retry configuration
const MAX_RETRIES = 3
const RETRY_DELAY = 1000
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504]
const RETRYABLE_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH']
// Only retry methods that are safe to replay. A POST / PATCH / DELETE
// that returns a transient 500 might still have executed the
// state-changing work on the server — retrying blindly would turn a
// single user action into a double-charge / double-create / double-
// delete. Confined to HTTP methods that RFC 9110 declares idempotent.
const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options', 'put', 'delete'])
// Cap an honoured Retry-After header so a broken backend can't stall the UI.
const MAX_RETRY_AFTER_MS = 30_000

/**
 * Pure retry-decision helper — extracted so unit tests can exercise
 * it without having to unmock axios (which is globally mocked in the
 * frontend test setup for component isolation).
 *
 * Decides whether a failed request should be retried given its
 * method, error code, HTTP status, and error message. The rules:
 *
 * - The HTTP method must be idempotent (RFC 9110): GET / HEAD /
 *   OPTIONS / PUT / DELETE. POST and PATCH are NEVER retried, even
 *   on transient 5xx — the state-changing work may have partially
 *   run on the server.
 * - The error must look transient: one of the retryable Node error
 *   codes, a retryable HTTP status, or the specific "socket hang up"
 *   message.
 */
export function shouldRetryRequest(params: {
  method: string | undefined
  errorCode: string | undefined
  statusCode: number | undefined
  message: string | undefined
}): boolean {
  const method = (params.method || 'get').toLowerCase()
  if (!IDEMPOTENT_METHODS.has(method)) return false

  if (params.errorCode && RETRYABLE_ERROR_CODES.includes(params.errorCode)) return true
  if (params.statusCode && RETRYABLE_STATUS_CODES.includes(params.statusCode)) return true
  if (params.message && params.message.includes('socket hang up')) return true

  return false
}

/**
 * Pure delay-computation helper for the retry interceptor. Honours
 * Retry-After (seconds or HTTP-date) with a hard cap so a buggy or
 * hostile upstream can't freeze the UI; falls back to exponential
 * backoff when no header is present.
 */
export function computeRetryDelay(
  retryAfterHeader: string | undefined,
  attempt: number,
  now: number = Date.now(),
): number {
  if (retryAfterHeader) {
    const asNumber = Number(retryAfterHeader)
    if (!Number.isNaN(asNumber) && asNumber > 0) {
      return Math.min(asNumber * 1000, MAX_RETRY_AFTER_MS)
    }
    const whenMs = Date.parse(String(retryAfterHeader))
    if (!Number.isNaN(whenMs)) {
      return Math.min(Math.max(0, whenMs - now), MAX_RETRY_AFTER_MS)
    }
  }
  return RETRY_DELAY * Math.pow(2, attempt)
}

// Guard against multiple concurrent 401 redirects
let isRedirectingToLogin = false

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
  withCredentials: true, // Send cookies for httpOnly JWT auth
})

// Auth is carried entirely by the httpOnly cookie (withCredentials: true
// above). We do NOT read a token out of localStorage anymore — that used
// to be an XSS-vulnerable fallback, any script running in the page could
// read the token and impersonate the user. The cookie is
// httpOnly+SameSite=lax and is set by the backend on login/register/
// refresh; axios sends it automatically because withCredentials is on.
api.interceptors.request.use((config) => {
  // Send the user's selected org on every request so multi-org users
  // don't get silently scoped to whichever membership happens to be
  // first. Read the value out of the Zustand org store via its
  // synchronous accessor to avoid a circular import of the React
  // hook. The store persists currentOrganization to localStorage
  // directly under key "almyty-org-store" so this also works on the
  // first request after a hard refresh.
  // Read lazily at request time (not module-load time) so we always
  // reflect the user's latest selection.
  if (!config.headers['X-Organization-Id']) {
    const orgId = readCurrentOrgId()
    if (orgId) {
      config.headers['X-Organization-Id'] = orgId
    }
  }

  // Add retry counter
  config.headers['X-Retry-Count'] = (config.headers['X-Retry-Count'] as number || 0)

  return config
})

// Read currentOrganizationId from the persisted Zustand store. We
// cannot import the store directly here because it imports this file
// (to get the organizationsApi helper), which would be a cycle. Fall
// back to parsing localStorage directly — that's where the persist
// middleware writes it.
function readCurrentOrgId(): string | null {
  try {
    const raw = localStorage.getItem('almyty-org-store')
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: { currentOrganization?: { id?: string } } }
    return parsed?.state?.currentOrganization?.id ?? null
  } catch {
    return null
  }
}

// All backend controllers return { success: true, data: <payload>, message?: string }
// This helper extracts the payload from any API response.
// Use it in React Query: queryFn: () => apiGet('/gateways')
export function extractData<T = any>(response: AxiosResponse): T {
  const body = response.data
  if (body && typeof body === 'object' && 'data' in body) {
    return body.data as T
  }
  return body as T
}

// Convenience: api call + extract in one step
export const apiGet = <T = any>(url: string, config?: any): Promise<T> =>
  api.get(url, config).then(extractData)
export const apiPost = <T = any>(url: string, data?: any, config?: any): Promise<T> =>
  api.post(url, data, config).then(extractData)
export const apiPatch = <T = any>(url: string, data?: any, config?: any): Promise<T> =>
  api.patch(url, data, config).then(extractData)
export const apiPut = <T = any>(url: string, data?: any, config?: any): Promise<T> =>
  api.put(url, data, config).then(extractData)
export const apiDel = <T = any>(url: string, config?: any): Promise<T> =>
  api.delete(url, config).then(extractData)

// Handle auth errors and retries
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as any

    // Handle auth errors — redirect to login once, not per-request.
    //
    // Critical: skip the redirect when we're ALREADY on /auth/login (or
    // any other unauthenticated page). Otherwise the bootstrap
    // checkAuth() call → 401 → window.location.href = '/auth/login'
    // → full page reload → module re-evaluates so isRedirectingToLogin
    // resets to false → checkAuth() runs again → infinite loop
    // (~5 requests/sec, observed on staging). The guard above only
    // protects within a single page load, not across the reload it
    // causes itself.
    if (error.response?.status === 401 && !isRedirectingToLogin) {
      const path = typeof window !== 'undefined' ? window.location.pathname : ''
      const isOnAuthPage = path.startsWith('/auth/') || path === '/cli-login'
      if (isOnAuthPage) {
        // Already on an unauthenticated page — surface the 401 to the
        // caller and stop. No redirect, no logout call, no reload.
        return Promise.reject(error)
      }
      isRedirectingToLogin = true
      // Legacy cleanup for users upgrading from a build that
      // wrote the token into localStorage. Remove any residue
      // regardless of whether it exists — removeItem is a no-op
      // for missing keys.
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      localStorage.removeItem('auth-storage')
      // Clear httpOnly cookie via backend (best-effort, don't block redirect)
      api.post('/auth/logout').catch(() => {})
      window.location.href = '/auth/login'
      return Promise.reject(error)
    }

    // Permission-denied feedback. Before this the UI would silently
    // swallow 403s on queries (no mutation onError handler fires for
    // a GET), leaving the user staring at a blank screen wondering
    // what they did wrong. Emit a window event the top-level layout
    // picks up and surfaces as a toast. We deliberately keep the
    // message user-facing — "You don't have permission" instead of
    // exposing the raw backend error shape.
    if (error.response?.status === 403) {
      const backendMsg = (error.response.data as any)?.message
      const detail = {
        url: config?.url as string | undefined,
        method: (config?.method as string | undefined)?.toUpperCase(),
        message: typeof backendMsg === 'string' && backendMsg.length > 0
          ? backendMsg
          : "You don't have permission to perform this action.",
      }
      // Only dispatch from a browser context — the unit tests mount
      // this module in jsdom, which has window, so this is safe.
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('almyty:api-forbidden', { detail }))
      }
    }

    // Determine if error is retryable — idempotent method + transient
    // error. Delegates to the pure helper that the unit tests exercise.
    const isRetryable = shouldRetryRequest({
      method: config?.method,
      errorCode: (error as any).code,
      statusCode: error.response?.status,
      message: error.message,
    })

    // Retry logic
    const retryCount = config?.headers?.['X-Retry-Count'] || 0
    if (config && isRetryable && retryCount < MAX_RETRIES) {
      config.headers['X-Retry-Count'] = retryCount + 1

      const retryAfterHeader =
        (error.response?.headers as any)?.['retry-after'] ??
        (error.response?.headers as any)?.['Retry-After']
      const delay = computeRetryDelay(retryAfterHeader, retryCount)
      await new Promise(resolve => setTimeout(resolve, delay))

      console.warn(`Retrying request (attempt ${retryCount + 1}/${MAX_RETRIES}):`, config.url)
      return api.request(config)
    }

    // Log error for debugging
    console.error('API Error:', {
      url: config?.url,
      status: error.response?.status,
      code: (error as any).code,
      message: error.message,
      retries: retryCount
    })

    return Promise.reject(error)
  }
)

// Auth API
export const authApi = {
  register: (data: { email: string; password: string; firstName: string; lastName: string; organizationName: string }) =>
    apiPost('/auth/register', data),
  
  login: (data: { email: string; password: string }) =>
    apiPost('/auth/login', data),
  
  logout: () => apiPost('/auth/logout'),
  
  getProfile: () => apiGet('/auth/profile'),
  
  updateProfile: (data: Partial<{ name: string; email: string }>) =>
    apiPatch('/auth/profile', data),
  
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    apiPatch('/auth/change-password', data),

  createApiKey: (data: { name: string; scopes?: string[]; expiresAt?: string }) =>
    apiPost('/auth/api-keys', data),
}

// Organizations API
export const organizationsApi = {
  getAll: () => apiGet('/organizations'),
  
  getById: (id: string) => apiGet(`/organizations/${id}`),
  
  create: (data: { name: string; description?: string }) =>
    apiPost('/organizations', data),
  
  update: (id: string, data: Partial<{ name: string; description: string; agentDefaults: any }>) =>
    apiPatch(`/organizations/${id}`, data),
  
  delete: (id: string) => apiDel(`/organizations/${id}`),
  
  getMembers: (id: string) => apiGet(`/organizations/${id}/members`),
  
  addMember: (id: string, data: { email: string; role: string }) =>
    apiPost(`/organizations/${id}/members`, data),
  
  updateMemberRole: (id: string, userId: string, data: { role: string }) =>
    apiPatch(`/organizations/${id}/members/${userId}`, data),
  
  removeMember: (id: string, userId: string) =>
    apiDel(`/organizations/${id}/members/${userId}`),

  // Pending invites
  getPendingInvites: (id: string) =>
    apiGet(`/organizations/${id}/invites`),

  revokePendingInvite: (id: string, inviteId: string) =>
    apiDel(`/organizations/${id}/invites/${inviteId}`),

  // Teams
  getTeams: (id: string) => apiGet(`/organizations/${id}/teams`),
  
  createTeam: (id: string, data: { name: string; description?: string }) =>
    apiPost(`/organizations/${id}/teams`, data),
    
  updateTeam: (id: string, teamId: string, data: { name: string; description?: string }) =>
    apiPut(`/organizations/${id}/teams/${teamId}`, data),

  deleteTeam: (id: string, teamId: string) =>
    apiDel(`/organizations/${id}/teams/${teamId}`),

  getTeamMembers: (id: string, teamId: string) =>
    apiGet(`/organizations/${id}/teams/${teamId}/members`),
    
  addTeamMember: (orgId: string, teamId: string, data: { userId: string; role?: string }) =>
    apiPost(`/organizations/${orgId}/teams/${teamId}/members`, data),

  updateTeamMemberRole: (orgId: string, teamId: string, userId: string, data: { role: string }) =>
    apiPut(`/organizations/${orgId}/teams/${teamId}/members/${userId}`, data),
    
  removeTeamMember: (orgId: string, teamId: string, userId: string) =>
    apiDel(`/organizations/${orgId}/teams/${teamId}/members/${userId}`),
}

// Gateways API
export const gatewaysApi = {
  getAll: (params?: { kind?: string; agentId?: string }) => {
    const qs = params ? '?' + new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null) as [string, string][]
    ).toString() : ''
    return apiGet(`/gateways${qs}`)
  },

  getById: (id: string) => apiGet(`/gateways/${id}`),

  create: (data: any) => apiPost('/gateways', data),

  update: (id: string, data: any) => apiPatch(`/gateways/${id}`, data),

  delete: (id: string) => apiDel(`/gateways/${id}`),

  // Tool association endpoints
  getTools: (id: string) => apiGet(`/gateways/${id}/tools`),

  getAvailableTools: (id: string) => apiGet(`/gateways/${id}/tools/available`),

  assignTool: (gatewayId: string, toolId: string) =>
    apiPost(`/gateways/${gatewayId}/tools`, { toolId }),

  removeTool: (gatewayId: string, toolId: string) =>
    apiDel(`/gateways/${gatewayId}/tools/${toolId}`),

  bulkAssignTools: (gatewayId: string, toolIds: string[]) =>
    apiPost(`/gateways/${gatewayId}/tools/bulk`, { toolIds }),

  removeAllTools: (gatewayId: string) =>
    apiDel(`/gateways/${gatewayId}/tools`),

  updateToolConfig: (gatewayId: string, gatewayToolId: string, data: any) =>
    apiPatch(`/gateways/${gatewayId}/tools/${gatewayToolId}`, data),

  getToolStats: (gatewayId: string) => apiGet(`/gateways/${gatewayId}/tools/stats`),

  // Gateway operations
  activate: (id: string) => apiPost(`/gateways/${id}/activate`),

  deactivate: (id: string) => apiPost(`/gateways/${id}/deactivate`),

  testConnection: (id: string) => apiPost(`/gateways/${id}/health-check`),

  testChannelConnection: (id: string) => apiPost(`/gateways/${id}/test-connection`),

  getMetrics: (id: string, params?: any) => apiGet(`/gateways/${id}/stats`, { params }),

  // Auth configuration
  getAuthConfigs: (gatewayId: string) => apiGet(`/gateways/${gatewayId}/auth`),
  createAuthConfig: (gatewayId: string, data: any) => apiPost(`/gateways/${gatewayId}/auth`, data),
  deleteAuthConfig: (gatewayId: string, authId: string) => apiDel(`/gateways/${gatewayId}/auth/${authId}`),

  // API key management
  generateApiKey: (gatewayId: string, data: { name: string; scopes?: string[]; expiresAt?: string }) =>
    apiPost(`/gateways/${gatewayId}/auth/api-keys`, data),
  listApiKeys: (gatewayId: string) => apiGet(`/gateways/${gatewayId}/auth/api-keys`),
  revokeApiKey: (gatewayId: string, keyId: string) => apiDel(`/gateways/${gatewayId}/auth/api-keys/${keyId}`),

  // Export formats
  getSkills: (id: string) => apiGet(`/gateways/${id}/skills`),
  getCliBundle: (id: string, format: 'bash' | 'node' = 'bash') => apiGet(`/gateways/${id}/cli-bundle`, { params: { format } }),
  getSdk: (id: string) => apiGet(`/gateways/${id}/sdk`),

  // Channel events log (per-gateway observability surface)
  listEvents: (gatewayId: string, limit?: number) =>
    apiGet(`/gateways/${gatewayId}/events${limit ? `?limit=${limit}` : ''}`),
}

// External Agents API
export const externalAgentsApi = {
  preview: (url: string) => apiPost('/external-agents/preview', { url }),
  getAll: () => apiGet('/external-agents'),
  getById: (id: string) => apiGet(`/external-agents/${id}`),
  create: (data: any) => apiPost('/external-agents', data),
  update: (id: string, data: any) => apiPatch(`/external-agents/${id}`, data),
  delete: (id: string) => apiDel(`/external-agents/${id}`),
  refresh: (id: string) => apiPost(`/external-agents/${id}/refresh`),
}

// APIs API
export const apisApi = {
  getAll: () => apiGet('/apis'),
  
  getById: (id: string) => apiGet(`/apis/${id}`),
  
  create: (data: any) => apiPost('/apis', data),
  
  update: (id: string, data: any) => apiPut(`/apis/${id}`, data),
  
  delete: (id: string) => apiDel(`/apis/${id}`),
  
  importSchema: (id: string, data: {
    schemaContent?: string;
    schemaUrl?: string;
    description?: string;
    generateTools?: boolean;
  }, file?: File) => {
    if (file) {
      const formData = new FormData()
      formData.append('schema', file)
      if (data.description) formData.append('description', data.description)
      if (data.generateTools !== undefined) formData.append('generateTools', data.generateTools.toString())
      return apiPost(`/apis/${id}/import-schema`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
    } else {
      return apiPost(`/apis/${id}/import-schema`, data)
    }
  },

  getImportStatus: (id: string, jobId: string) => apiGet(`/apis/${id}/import-status/${jobId}`),

  async pollImportStatus(id: string, jobId: string, maxAttempts = 120, intervalMs = 2000): Promise<any> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const statusData = await apisApi.getImportStatus(id, jobId)
      const status = statusData?.status

      if (status === 'completed') {
        return statusData
      } else if (status === 'failed') {
        throw new Error(statusData?.error || 'Import failed')
      }

      // Still processing, wait and retry
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }

    throw new Error('Import timeout - job did not complete in time')
  },
  
  generateTools: (id: string) => apiPost(`/apis/${id}/generate-tools`),
  
  testConnection: (id: string) => apiPost(`/apis/${id}/test-connection`),
  
  getOperations: (id: string) => apiGet(`/apis/${id}/operations`),
  
  getResources: (id: string) => apiGet(`/apis/${id}/resources`),
  
  getSchemas: (id: string) => apiGet(`/apis/${id}/schemas`),

  getParsedSchema: (id: string, schemaId: string) =>
    apiGet(`/apis/${id}/schemas/${schemaId}/parsed`),

  updateStatus: (id: string, status: string) => apiPut(`/apis/${id}/status`, { status }),

  createHttpApi: (data: any) => apiPost('/apis/http', data),

  createSdkApi: (data: any) => apiPost('/apis/sdk', data),
  getSdkMaps: (apiId: string) => apiGet(`/apis/${apiId}/sdk-maps`),
  addDependency: (apiId: string, packageName: string, version: string) => apiPost(`/apis/${apiId}/dependencies`, { packageName, version }),

  // Credential management
  getCredentials: (apiId: string) => apiGet(`/apis/${apiId}/credentials`),
  createCredential: (apiId: string, data: any) => apiPost(`/apis/${apiId}/credentials`, data),
  updateCredential: (apiId: string, credentialId: string, data: any) => apiPut(`/apis/${apiId}/credentials/${credentialId}`, data),
  deleteCredential: (apiId: string, credentialId: string) => apiDel(`/apis/${apiId}/credentials/${credentialId}`),
  testCredential: (apiId: string, credentialId: string) => apiPost(`/apis/${apiId}/credentials/${credentialId}/test`),
}

// Tools API
export const toolsApi = {
  getAll: (organizationId?: string, params?: { limit?: number; page?: number }) => {
    const queryParams = params ? { params } : { params: { limit: 100 } }
    if (organizationId) {
      return apiGet(`/organizations/${organizationId}/tools`, queryParams)
    }
    return apiGet('/tools', queryParams)
  },
  
  getById: (id: string, organizationId: string) => apiGet(`/organizations/${organizationId}/tools/${id}`),
  
  create: (data: any, organizationId?: string) => {
    if (organizationId) {
      return apiPost(`/organizations/${organizationId}/tools`, data)
    }
    return apiPost('/tools', data)
  },
  
  update: (id: string, data: any, organizationId?: string) => {
    const orgId = organizationId || readCurrentOrgId()
    if (!orgId) {
      return Promise.reject(new Error('No organization context. Pick an org before updating tools.'))
    }
    return apiPut(`/organizations/${orgId}/tools/${id}`, data)
  },

  delete: (id: string, organizationId?: string) => {
    const orgId = organizationId || readCurrentOrgId()
    if (!orgId) {
      return Promise.reject(new Error('No organization context. Pick an org before deleting tools.'))
    }
    return apiDel(`/organizations/${orgId}/tools/${id}`)
  },
  
  activate: (id: string, organizationId: string) => apiPost(`/organizations/${organizationId}/tools/${id}/activate`),
  deactivate: (id: string, organizationId: string) => apiPost(`/organizations/${organizationId}/tools/${id}/deactivate`),

  execute: (id: string, data: any, organizationId: string) => apiPost(`/organizations/${organizationId}/tools/${id}/execute`, data),
  
  getUsage: (id: string, params?: any) => apiGet(`/tools/${id}/usage`, { params }),

  getSchema: (id: string) => apiGet(`/tools/${id}/schema`),

  // Export formats
  getSkill: (id: string, organizationId: string) => apiGet(`/organizations/${organizationId}/tools/${id}/skill`),
  getCli: (id: string, organizationId: string, format: 'bash' | 'node' = 'bash') => apiGet(`/organizations/${organizationId}/tools/${id}/cli`, { params: { format } }),
  getSdk: (id: string, organizationId: string) => apiGet(`/organizations/${organizationId}/tools/${id}/sdk`),
}

// LLM Providers API
export const llmProvidersApi = {
  getAll: () => apiGet('/llm-providers'),
  
  getById: (id: string) => apiGet(`/llm-providers/${id}`),
  
  create: (data: any) => apiPost('/llm-providers', data),
  
  update: (id: string, data: any) => apiPatch(`/llm-providers/${id}`, data),
  
  delete: (id: string) => apiDel(`/llm-providers/${id}`),
  
  test: (id: string) => apiPost(`/llm-providers/${id}/test`),
  
  chat: (id: string, data: any) => apiPost(`/llm-providers/${id}/chat`, data),
  
  getSessions: (id: string) => apiGet(`/llm-providers/${id}/sessions`),

  getUsage: (id: string, params?: any) => apiGet(`/llm-providers/${id}/usage`, { params }),

  getModels: (id: string) => apiGet(`/llm-providers/${id}/models`),

  getModelsByType: (type: string, apiKey: string) => apiPost('/llm-providers/models/by-type', { type, apiKey }),
}

// Analytics / Monitoring API
export const analyticsApi = {
  getDashboard: () => apiGet('/monitoring/enterprise/dashboard'),
  getLiveStats: () => apiGet('/monitoring/stats/live'),
  getMetrics: () => apiGet('/monitoring/metrics'),
  getMetricsHistory: (hours = 1) => apiGet(`/monitoring/metrics/history?hours=${hours}`),
  getAlerts: () => apiGet('/monitoring/alerts'),
  getHealth: () => apiGet('/monitoring/health'),
  // Real analytics endpoints
  getOverview: () => apiGet('/analytics/overview'),
  getRequestLogs: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiGet(`/analytics/requests${qs}`)
  },
  getToolUsage: (timeframe = '7d') => apiGet(`/analytics/tool-usage?timeframe=${timeframe}`),
  getGatewayUsage: (timeframe = '7d') => apiGet(`/analytics/gateway-usage?timeframe=${timeframe}`),
  getLlmUsage: (timeframe = '7d') => apiGet(`/analytics/llm-usage?timeframe=${timeframe}`),
  getTimeline: (timeframe = '24h', granularity = 'hour') =>
    apiGet(`/analytics/timeline?timeframe=${timeframe}&granularity=${granularity}`),
  getAuditSummary: () => apiGet('/analytics/audit-summary'),
  getAgentRunsSummary: () => apiGet('/analytics/agent-runs'),
  exportData: (format: string, type: string, from?: string, to?: string) => {
    const params = new URLSearchParams({ format, type })
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    return apiGet(`/analytics/export?${params.toString()}`, { responseType: 'blob' as any })
  },
}

// Agents API
export const agentsApi = {
  getAll: () => apiGet('/agents'),
  getById: (id: string) => apiGet(`/agents/${id}`),
  create: (data: any, organizationId?: string) => apiPost('/agents', data),
  update: (id: string, data: any) => apiPatch(`/agents/${id}`, data),
  delete: (id: string) => apiDel(`/agents/${id}`),
  activate: (id: string) => apiPost(`/agents/${id}/activate`),
  deactivate: (id: string) => apiPost(`/agents/${id}/deactivate`),
  duplicate: (id: string) => apiPost(`/agents/${id}/duplicate`),
  invoke: (id: string, input: any, options?: any) => apiPost(`/agents/${id}/invoke`, { input, options }),
  stream: (id: string, input: any) => apiPost(`/agents/${id}/stream`, { input }, { responseType: 'stream' }),
  getExecutions: (id: string, params?: any) => apiGet(`/agents/${id}/executions`, { params }),
  getExecution: (id: string, execId: string) => apiGet(`/agents/${id}/executions/${execId}`),
  // Templates
  getTemplates: () => apiGet('/agents/templates'),
  // Versioning
  getVersions: (id: string) => apiGet(`/agents/${id}/versions`),
  saveVersion: (id: string, changelog?: string) => apiPost(`/agents/${id}/versions`, { changelog }),
  rollback: (id: string, versionIndex: number) => apiPost(`/agents/${id}/versions/${versionIndex}/rollback`),
  // Import / Export
  exportAgent: (id: string) => apiGet(`/agents/${id}/export`),
  importAgent: (data: any) => apiPost('/agents/import', data),
  // Cost estimation
  getCostEstimate: (id: string) => apiGet(`/agents/${id}/cost-estimate`),
  // Audit log
  getAuditLog: (id: string) => apiGet(`/agents/${id}/audit-log`),
  // Scheduling
  schedule: (id: string, intervalMinutes: number, input?: any) =>
    apiPost(`/agents/${id}/schedule`, { intervalMinutes, input }),
  unschedule: (id: string) => apiDel(`/agents/${id}/schedule`),
  // Runs (autonomous mode)
  startRun: (id: string, input: any, options?: any) => apiPost(`/agents/${id}/runs`, { input, ...options }),
  listRuns: (id: string, params?: any) => apiGet(`/agents/${id}/runs`, { params }),
  getRun: (id: string, runId: string) => apiGet(`/agents/${id}/runs/${runId}`),
  cancelRun: (id: string, runId: string) => apiPost(`/agents/${id}/runs/${runId}/cancel`),
  sendRunInput: (id: string, runId: string, input: string) => apiPost(`/agents/${id}/runs/${runId}/input`, { input }),
  // Interfaces
  getInterfaces: (id: string) => apiGet(`/interfaces?agentId=${id}`),
}

// Runs API (standalone access)
export const runsApi = {
  getRun: (runId: string) => apiGet(`/agents/runs/${runId}`),
}


// Runners API (cluster 5)
export const runnersApi = {
  getAll: () => apiGet('/runners'),
  getById: (id: string) => apiGet(`/runners/${id}`),
  unregister: (id: string) => apiDel(`/runners/${id}`),
}

// Workspaces API (cluster 5)
export const workspacesApi = {
  getAll: () => apiGet('/workspaces'),
  getById: (id: string) => apiGet(`/workspaces/${id}`),
  release: (id: string) => apiDel(`/workspaces/${id}`),
}
// Canonical Memory API (v1)
//
// Talks to /memory/canonical/* — the canonical-schema-v1 backend.
// Items are scoped via { scope_type, scope_id }; the UI defaults
// scope_type=workspace and scope_id=current organization id when
// the caller doesn't override.
export type MemoryScopeType = 'user' | 'workspace' | 'project' | 'collab'
export type MemoryMode = 'memory' | 'document'
export type MemoryTier = 'short' | 'project' | 'long' | 'shared'

export interface MemoryScopeRef {
  scope_type: MemoryScopeType
  scope_id: string
}

export const memoriesApi = {
  list: (body: {
    scope: MemoryScopeRef
    mode?: MemoryMode
    tier?: MemoryTier
    tags?: string[]
    include_superseded?: boolean
    include_deleted?: boolean
    limit?: number
    cursor?: string | null
  }) => apiPost('/memory/canonical/list', body),
  search: (body: {
    scope: MemoryScopeRef
    query: string
    mode?: MemoryMode
    tier?: MemoryTier
    tags?: string[]
    top_k?: number
    fts_only?: boolean
  }) => apiPost('/memory/canonical/search', body),
  getById: (id: string) => apiGet(`/memory/canonical/${id}`),
  put: (body: {
    mode: MemoryMode
    scope: MemoryScopeRef
    content: string
    tier?: MemoryTier
    ttl_seconds?: number
    tags?: string[]
    metadata?: Record<string, unknown>
    file_refs?: string[]
    source_uri?: string
    source_version?: number
    confidence?: number
    provenance: {
      agent_id: string | null
      session_id: string | null
      collab_id: string | null
      model: string | null
      provider: string | null
      tool_chain: string[]
      created_by: 'user' | 'agent' | 'consolidation' | 'transfer' | 'sync' | 'import'
      source_backend: string | null
    }
  }) => apiPost('/memory/canonical', body),
  remove: (id: string, mode: 'soft' | 'hard' = 'soft') =>
    apiDel(`/memory/canonical/${id}?mode=${mode}`),
  supersede: (id: string, body: any) =>
    apiPost(`/memory/canonical/${id}/supersede`, body),
  // Backend roster + transfer (router-level operations)
  listBackends: () => apiGet('/memory/canonical/backends'),
  backendsHealth: () => apiGet('/memory/canonical/backends/health'),
  // Workspace config (per-scope routing + softcap behavior + credentials wiring)
  getConfig: (scope_type: MemoryScopeType, scope_id: string) =>
    apiGet(`/memory/canonical/config?scope_type=${encodeURIComponent(scope_type)}&scope_id=${encodeURIComponent(scope_id)}`),
  updateConfig: (body: {
    scope_type: MemoryScopeType
    scope_id: string
    embedding_model?: string
    embedding_dim?: number
    embedding_provider?: string
    softcap_behavior?: 'reject' | 'warn_log' | 'silent'
    overrides?: Record<string, unknown>
  }) => apiPost('/memory/canonical/config', body),
  transfer: (body: {
    scope_type: MemoryScopeType
    scope_id: string
    source: string
    target: string
    mode?: MemoryMode
    dry_run?: boolean
  }) => apiPost('/memory/canonical/transfer', body),
  // Audit: soft-cap warnings list
  listSoftcapWarnings: (scope_type: MemoryScopeType, scope_id: string, limit = 50) =>
    apiGet(`/memory/canonical/warnings/softcap?scope_type=${encodeURIComponent(scope_type)}&scope_id=${encodeURIComponent(scope_id)}&limit=${limit}`),
  // Consolidation: trigger now (returns ConsolidationResult).
  consolidate: (body: { scope_type: MemoryScopeType; scope_id: string; force?: boolean }) =>
    apiPost('/memory/canonical/consolidate', body),
}

// Files API
export const filesApi = {
  getAll: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiGet(`/files${qs}`)
  },
  getById: (id: string) => apiGet(`/files/${id}`),
  upload: (file: File, agentId?: string, runId?: string) => {
    const formData = new FormData()
    formData.append('file', file)
    const params = new URLSearchParams()
    if (agentId) params.set('agentId', agentId)
    if (runId) params.set('runId', runId)
    const qs = params.toString() ? `?${params.toString()}` : ''
    return apiPost(`/files/upload${qs}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },
  download: (id: string) => api.get(`/files/${id}/download`, { responseType: 'blob' }),
  delete: (id: string) => apiDel(`/files/${id}`),
}

// Interfaces API
export const interfacesApi = {
  getAll: (agentId?: string) => {
    const qs = agentId ? `?agentId=${agentId}` : ''
    return apiGet(`/interfaces${qs}`)
  },
  getById: (id: string) => apiGet(`/interfaces/${id}`),
  create: (data: any) => apiPost('/interfaces', data),
  update: (id: string, data: any) => apiPatch(`/interfaces/${id}`, data),
  delete: (id: string) => apiDel(`/interfaces/${id}`),
  activate: (id: string) => apiPost(`/interfaces/${id}/activate`),
  deactivate: (id: string) => apiPost(`/interfaces/${id}/deactivate`),
}

// Audit Logs API
export const auditLogsApi = {
  getAll: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    // Return full response with data + pagination (not just data array)
    return api.get(`/audit-logs${qs}`).then(r => r.data)
  },
  getResourceHistory: (resourceType: string, resourceId: string, limit?: number) =>
    apiGet(`/audit-logs/resource?resourceType=${resourceType}&resourceId=${resourceId}${limit ? `&limit=${limit}` : ''}`),
}

// Credentials Vault API
export const credentialsApi = {
  getAll: () => apiGet('/credentials'),
  getById: (id: string) => apiGet(`/credentials/${id}`),
  create: (data: any) => apiPost('/credentials', data),
  update: (id: string, data: any) => apiPatch(`/credentials/${id}`, data),
  delete: (id: string) => apiDel(`/credentials/${id}`),
  test: (id: string) => apiPost(`/credentials/${id}/test`, {}),
  getUsage: (id: string) => apiGet(`/credentials/${id}/usage`),
}

// Access Keys API
export const accessKeysApi = {
  getAll: () => apiGet('/access-keys'),
  create: (data: any) => apiPost('/access-keys', data),
  revoke: (id: string) => apiDel(`/access-keys/${id}`),
}

// Users API (admin)
export const usersApi = {
  getAll: () => apiGet('/users'),
  
  getById: (id: string) => apiGet(`/users/${id}`),
  
  update: (id: string, data: any) => apiPatch(`/users/${id}`, data),
  
  delete: (id: string) => apiDel(`/users/${id}`),
  
  getActivity: (id: string, params?: any) => apiGet(`/users/${id}/activity`, { params }),
}

// Versions API (entity version history via typeorm-versions)
export const versionsApi = {
  getVersions: (entityType: string, entityId: string) => apiGet(`/versions/${entityType}/${entityId}`),
  getVersion: (versionId: string) => apiGet(`/versions/detail/${versionId}`),
}

// Tool Hub API
export const toolHubApi = {
  getTemplates: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiGet(`/tool-hub/templates${qs}`)
  },
  getTemplate: (id: string) => apiGet(`/tool-hub/templates/${id}`),
  getProviders: () => apiGet('/tool-hub/providers'),
  getCategories: () => apiGet('/tool-hub/categories'),
  installTemplate: (id: string, data?: any) => apiPost(`/tool-hub/templates/${id}/install`, data || {}),
  installProvider: (provider: string, data?: any) => apiPost(`/tool-hub/providers/${provider}/install`, data || {}),
}

export const approvalsApi = {
  list: () => apiGet('/approvals'),
  getById: (id: string) => apiGet(`/approvals/${id}`),
  approve: (id: string, decisionReason?: string) =>
    apiPost(`/approvals/${id}/approve`, { decisionReason }),
  reject: (id: string, decisionReason?: string) =>
    apiPost(`/approvals/${id}/reject`, { decisionReason }),
}

export const teamsApi = {
  list: (organizationId: string) =>
    apiGet(`/organizations/${organizationId}/teams`),
}

export type ApiResponse<T = any> = AxiosResponse<T>