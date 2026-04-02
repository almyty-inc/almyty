import axios, { AxiosResponse, AxiosError } from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

// Retry configuration
const MAX_RETRIES = 3
const RETRY_DELAY = 1000
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504]
const RETRYABLE_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH']

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

// Add auth token to requests (fallback for programmatic/transition use).
// Primary auth is via httpOnly cookie sent automatically with withCredentials: true.
// The Bearer header is only added if a token exists in localStorage (legacy/API client compat).
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  // Add retry counter
  config.headers['X-Retry-Count'] = (config.headers['X-Retry-Count'] as number || 0)

  return config
})

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

    // Handle auth errors — redirect to login once, not per-request
    if (error.response?.status === 401 && !isRedirectingToLogin) {
      isRedirectingToLogin = true
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      // Also clear persisted Zustand auth store
      localStorage.removeItem('auth-storage')
      // Clear httpOnly cookie via backend (best-effort, don't block redirect)
      api.post('/auth/logout').catch(() => {})
      window.location.href = '/auth/login'
      return Promise.reject(error)
    }

    // Determine if error is retryable
    const isRetryable =
      RETRYABLE_ERROR_CODES.includes((error as any).code) ||
      (error.response?.status && RETRYABLE_STATUS_CODES.includes(error.response.status)) ||
      error.message?.includes('socket hang up')

    // Retry logic
    const retryCount = config?.headers?.['X-Retry-Count'] || 0
    if (config && isRetryable && retryCount < MAX_RETRIES) {
      config.headers['X-Retry-Count'] = retryCount + 1

      // Exponential backoff
      const delay = RETRY_DELAY * Math.pow(2, retryCount)
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

  // Teams
  getTeams: (id: string) => apiGet(`/organizations/${id}/teams`),
  
  createTeam: (id: string, data: { name: string; description?: string }) =>
    apiPost(`/organizations/${id}/teams`, data),
    
  updateTeam: (id: string, teamId: string, data: { name: string; description?: string }) =>
    apiPut(`/organizations/${id}/teams/${teamId}`, data),
    
  addTeamMember: (orgId: string, teamId: string, data: { userId: string; role?: string }) =>
    apiPost(`/organizations/${orgId}/teams/${teamId}/members`, data),

  updateTeamMemberRole: (orgId: string, teamId: string, userId: string, data: { role: string }) =>
    apiPut(`/organizations/${orgId}/teams/${teamId}/members/${userId}`, data),
    
  removeTeamMember: (orgId: string, teamId: string, userId: string) =>
    apiDel(`/organizations/${orgId}/teams/${teamId}/members/${userId}`),
}

// Gateways API
export const gatewaysApi = {
  getAll: () => apiGet('/gateways'),

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
    if (organizationId) {
      return apiPut(`/organizations/${organizationId}/tools/${id}`, data)
    }
    // Fallback: get org from store
    const orgId = JSON.parse(localStorage.getItem('auth-storage') || '{}')?.state?.user?.organizationMemberships?.[0]?.organization?.id
    return apiPut(`/organizations/${orgId}/tools/${id}`, data)
  },

  delete: (id: string, organizationId?: string) => {
    if (organizationId) {
      return apiDel(`/organizations/${organizationId}/tools/${id}`)
    }
    const orgId = JSON.parse(localStorage.getItem('auth-storage') || '{}')?.state?.user?.organizationMemberships?.[0]?.organization?.id
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

// Memories API
export const memoriesApi = {
  getAll: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return apiGet(`/memories${qs}`)
  },
  getById: (id: string) => apiGet(`/memories/${id}`),
  create: (data: any) => apiPost('/memories', data),
  update: (id: string, data: any) => apiPatch(`/memories/${id}`, data),
  delete: (id: string) => apiDel(`/memories/${id}`),
  search: (query: string, options?: { agentId?: string; limit?: number; scope?: string; type?: string }) =>
    apiPost('/memories/search', { query, ...options }),
  getTags: () => apiGet('/memories/tags'),
  bulkCreate: (items: any[]) => apiPost('/memories/bulk', { items }),
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

export type ApiResponse<T = any> = AxiosResponse<T>