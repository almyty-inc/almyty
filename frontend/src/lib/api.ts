import axios, { AxiosResponse, AxiosError } from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

// Retry configuration
const MAX_RETRIES = 3
const RETRY_DELAY = 1000
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504]
const RETRYABLE_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH']

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000, // 30 second timeout
})

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  // Add retry counter
  config.headers['X-Retry-Count'] = (config.headers['X-Retry-Count'] as number || 0)

  return config
})

// Handle auth errors and retries
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as any

    // Handle auth errors
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      window.location.href = '/login'
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
    api.post('/auth/register', data),
  
  login: (data: { email: string; password: string }) =>
    api.post('/auth/login', data),
  
  logout: () => api.post('/auth/logout'),
  
  getProfile: () => api.get('/auth/profile'),
  
  updateProfile: (data: Partial<{ name: string; email: string }>) =>
    api.patch('/auth/profile', data),
  
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    api.patch('/auth/change-password', data),
}

// Organizations API
export const organizationsApi = {
  getAll: () => api.get('/organizations'),
  
  getById: (id: string) => api.get(`/organizations/${id}`),
  
  create: (data: { name: string; description?: string }) =>
    api.post('/organizations', data),
  
  update: (id: string, data: Partial<{ name: string; description: string }>) =>
    api.patch(`/organizations/${id}`, data),
  
  delete: (id: string) => api.delete(`/organizations/${id}`),
  
  getMembers: (id: string) => api.get(`/organizations/${id}/members`),
  
  addMember: (id: string, data: { email: string; role: string }) =>
    api.post(`/organizations/${id}/members`, data),
  
  updateMemberRole: (id: string, userId: string, data: { role: string }) =>
    api.patch(`/organizations/${id}/members/${userId}`, data),
  
  removeMember: (id: string, userId: string) =>
    api.delete(`/organizations/${id}/members/${userId}`),

  // Teams
  getTeams: (id: string) => api.get(`/organizations/${id}/teams`),
  
  createTeam: (id: string, data: { name: string; description?: string }) =>
    api.post(`/organizations/${id}/teams`, data),
    
  updateTeam: (id: string, teamId: string, data: { name: string; description?: string }) =>
    api.put(`/organizations/${id}/teams/${teamId}`, data),
    
  addTeamMember: (orgId: string, teamId: string, data: { userId: string; role?: string }) =>
    api.post(`/organizations/${orgId}/teams/${teamId}/members`, data),

  updateTeamMemberRole: (orgId: string, teamId: string, userId: string, data: { role: string }) =>
    api.put(`/organizations/${orgId}/teams/${teamId}/members/${userId}`, data),
    
  removeTeamMember: (orgId: string, teamId: string, userId: string) =>
    api.delete(`/organizations/${orgId}/teams/${teamId}/members/${userId}`),
}

// Gateways API
export const gatewaysApi = {
  getAll: () => api.get('/gateways'),

  getById: (id: string) => api.get(`/gateways/${id}`),

  create: (data: any) => api.post('/gateways', data),

  update: (id: string, data: any) => api.patch(`/gateways/${id}`, data),

  delete: (id: string) => api.delete(`/gateways/${id}`),

  // Tool association endpoints
  getTools: (id: string) => api.get(`/gateways/${id}/tools`),

  getAvailableTools: (id: string) => api.get(`/gateways/${id}/tools/available`),

  assignTool: (gatewayId: string, toolId: string) =>
    api.post(`/gateways/${gatewayId}/tools`, { toolId }),

  removeTool: (gatewayId: string, toolId: string) =>
    api.delete(`/gateways/${gatewayId}/tools/${toolId}`),

  bulkAssignTools: (gatewayId: string, toolIds: string[]) =>
    api.post(`/gateways/${gatewayId}/tools/bulk`, { toolIds }),

  removeAllTools: (gatewayId: string) =>
    api.delete(`/gateways/${gatewayId}/tools`),

  getToolStats: (gatewayId: string) => api.get(`/gateways/${gatewayId}/tools/stats`),

  // Gateway operations
  activate: (id: string) => api.post(`/gateways/${id}/activate`),

  deactivate: (id: string) => api.post(`/gateways/${id}/deactivate`),

  testConnection: (id: string) => api.post(`/gateways/${id}/health-check`),

  getMetrics: (id: string, params?: any) => api.get(`/gateways/${id}/stats`, { params }),
}

// APIs API
export const apisApi = {
  getAll: () => api.get('/apis'),
  
  getById: (id: string) => api.get(`/apis/${id}`),
  
  create: (data: any) => api.post('/apis', data),
  
  update: (id: string, data: any) => api.put(`/apis/${id}`, data),
  
  delete: (id: string) => api.delete(`/apis/${id}`),
  
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
      return api.post(`/apis/${id}/import-schema`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
    } else {
      return api.post(`/apis/${id}/import-schema`, data)
    }
  },

  getImportStatus: (id: string, jobId: string) => api.get(`/apis/${id}/import-status/${jobId}`),

  async pollImportStatus(id: string, jobId: string, maxAttempts = 120, intervalMs = 2000): Promise<any> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await apisApi.getImportStatus(id, jobId)
      const status = response.data?.status

      if (status === 'completed') {
        return response.data
      } else if (status === 'failed') {
        throw new Error(response.data?.error || 'Import failed')
      }

      // Still processing, wait and retry
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }

    throw new Error('Import timeout - job did not complete in time')
  },
  
  generateTools: (id: string) => api.post(`/apis/${id}/generate-tools`),
  
  testConnection: (id: string) => api.post(`/apis/${id}/test-connection`),
  
  getOperations: (id: string) => api.get(`/apis/${id}/operations`),
  
  getResources: (id: string) => api.get(`/apis/${id}/resources`),
  
  getSchemas: (id: string) => api.get(`/apis/${id}/schemas`),
  
  updateStatus: (id: string, status: string) => api.put(`/apis/${id}/status`, { status }),
}

// Tools API
export const toolsApi = {
  getAll: (organizationId?: string) => {
    if (organizationId) {
      return api.get(`/organizations/${organizationId}/tools`)
    }
    return api.get('/tools')
  },
  
  getById: (id: string, organizationId: string) => api.get(`/organizations/${organizationId}/tools/${id}`),
  
  create: (data: any, organizationId?: string) => {
    if (organizationId) {
      return api.post(`/organizations/${organizationId}/tools`, data)
    }
    return api.post('/tools', data)
  },
  
  update: (id: string, data: any) => api.patch(`/tools/${id}`, data),
  
  delete: (id: string) => api.delete(`/tools/${id}`),
  
  execute: (id: string, data: any, organizationId: string) => api.post(`/organizations/${organizationId}/tools/${id}/execute`, data),
  
  getUsage: (id: string, params?: any) => api.get(`/tools/${id}/usage`, { params }),
  
  getSchema: (id: string) => api.get(`/tools/${id}/schema`),
}

// LLM Providers API
export const llmProvidersApi = {
  getAll: () => api.get('/llm-providers'),
  
  getById: (id: string) => api.get(`/llm-providers/${id}`),
  
  create: (data: any) => api.post('/llm-providers', data),
  
  update: (id: string, data: any) => api.patch(`/llm-providers/${id}`, data),
  
  delete: (id: string) => api.delete(`/llm-providers/${id}`),
  
  test: (id: string) => api.post(`/llm-providers/${id}/test`),
  
  chat: (id: string, data: any) => api.post(`/llm-providers/${id}/chat`, data),
  
  getSessions: (id: string) => api.get(`/llm-providers/${id}/sessions`),
  
  getUsage: (id: string, params?: any) => api.get(`/llm-providers/${id}/usage`, { params }),
}

// Analytics API
export const analyticsApi = {
  getDashboard: () => api.get('/monitoring/enterprise/dashboard'),
  
  getUsageMetrics: (params?: any) => api.get('/analytics/usage', { params }),
  
  getCostAnalysis: (params?: any) => api.get('/analytics/costs', { params }),
  
  getPerformanceMetrics: (params?: any) => api.get('/analytics/performance', { params }),
  
  getErrorAnalysis: (params?: any) => api.get('/analytics/errors', { params }),
  
  export: (type: string, params?: any) => 
    api.get(`/analytics/export/${type}`, { params, responseType: 'blob' }),
}

// Users API (admin)
export const usersApi = {
  getAll: () => api.get('/users'),
  
  getById: (id: string) => api.get(`/users/${id}`),
  
  update: (id: string, data: any) => api.patch(`/users/${id}`, data),
  
  delete: (id: string) => api.delete(`/users/${id}`),
  
  getActivity: (id: string, params?: any) => api.get(`/users/${id}/activity`, { params }),
}

export type ApiResponse<T = any> = AxiosResponse<T>