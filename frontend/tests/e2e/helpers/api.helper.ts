import axios, { AxiosInstance } from 'axios'

/**
 * API Helper for direct backend calls in E2E tests
 * Used for test data setup and assertions
 */
export class APIHelper {
  private client: AxiosInstance
  private token?: string
  private organizationId?: string

  constructor(baseURL: string = 'http://localhost:4000') {
    this.client = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
      },
      validateStatus: () => true, // Don't throw on any status
    })

    // Unwrap {success, data} backend response envelope
    this.client.interceptors.response.use((response) => {
      if (response.data && typeof response.data === 'object' && 'success' in response.data && 'data' in response.data) {
        response.data = response.data.data
      }
      return response
    })

    // Add retry logic for network errors
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const config = error.config as any
        const retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH']
        const retryableStatus = [408, 429, 500, 502, 503, 504]

        const isRetryable =
          retryableErrors.includes(error.code) ||
          (error.response?.status && retryableStatus.includes(error.response.status)) ||
          error.message?.includes('socket hang up')

        const retryCount = config._retryCount || 0
        const maxRetries = 3

        if (config && isRetryable && retryCount < maxRetries) {
          config._retryCount = retryCount + 1

          // Exponential backoff
          const delay = 1000 * Math.pow(2, retryCount)
          await new Promise(resolve => setTimeout(resolve, delay))

          return this.client.request(config)
        }

        return Promise.reject(error)
      }
    )
  }

  /**
   * Set authentication token
   */
  setToken(token: string) {
    this.token = token
    this.client.defaults.headers.common['Authorization'] = `Bearer ${token}`
  }

  /**
   * Clear authentication token
   */
  clearToken() {
    this.token = undefined
    delete this.client.defaults.headers.common['Authorization']
  }

  // ==================== Auth Endpoints ====================

  async register(data: {
    email: string
    password: string
    firstName: string
    lastName: string
    organizationName: string
  }) {
    const response = await this.client.post('/auth/register', data)
    if (response.status === 201 && response.data.accessToken) {
      this.setToken(response.data.accessToken)
      // Extract organizationId from JWT token
      const tokenPayload = JSON.parse(Buffer.from(response.data.accessToken.split('.')[1], 'base64').toString())
      if (tokenPayload.organizations?.[0]?.id) {
        this.organizationId = tokenPayload.organizations[0].id
      }
    }
    return response.data
  }

  async login(email: string, password: string) {
    const response = await this.client.post('/auth/login', { email, password })
    if (response.status === 200 && response.data.accessToken) {
      this.setToken(response.data.accessToken)
      // Extract organizationId from JWT token
      const tokenPayload = JSON.parse(Buffer.from(response.data.accessToken.split('.')[1], 'base64').toString())
      if (tokenPayload.organizations?.[0]?.id) {
        this.organizationId = tokenPayload.organizations[0].id
      }
    }
    return response.data
  }

  async getProfile() {
    const response = await this.client.get('/auth/profile')
    // Extract organizationId from profile
    if (response.data.organizationId) {
      this.organizationId = response.data.organizationId
    } else if (response.data.organizationMemberships?.[0]?.organization?.id) {
      this.organizationId = response.data.organizationMemberships[0].organization.id
    }
    return response.data
  }

  // ==================== APIs Endpoints ====================

  async createAPI(data: {
    name: string
    baseUrl: string
    type: 'openapi' | 'graphql' | 'soap' | 'protobuf'
    description?: string
    authentication?: {
      type: string
      config: Record<string, any>
    }
  }) {
    const response = await this.client.post('/apis', data)
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`API creation failed with status ${response.status}: ${JSON.stringify(response.data)}`)
    }
    return response.data
  }

  async importSchema(apiId: string, data: {
    schemaUrl?: string
    schemaContent?: string
    generateTools?: boolean
  }) {
    const response = await this.client.post(`/apis/${apiId}/import-schema`, data)
    console.log(`[APIHelper] importSchema response status: ${response.status}`)
    console.log(`[APIHelper] importSchema response data:`, JSON.stringify(response.data, null, 2))
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`Schema import failed with status ${response.status}: ${JSON.stringify(response.data)}`)
    }

    // If response contains jobId, poll for completion
    if (response.data.jobId) {
      console.log(`[APIHelper] Polling for job completion: ${response.data.jobId}`)
      return await this.pollImportStatus(apiId, response.data.jobId)
    }

    return response.data
  }

  async pollImportStatus(apiId: string, jobId: string, maxAttempts = 120, intervalMs = 2000): Promise<any> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const response = await this.client.get(`/apis/${apiId}/import-status/${jobId}`)
      const status = response.data?.status

      console.log(`[APIHelper] Poll attempt ${attempt + 1}: status=${status}, progress=${response.data?.progress}`)

      if (status === 'completed') {
        console.log(`[APIHelper] Import completed successfully`)
        return response.data.result
      } else if (status === 'failed') {
        throw new Error(response.data?.error || 'Import failed')
      }

      // Still processing, wait and retry
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }

    throw new Error('Import timeout - job did not complete in time')
  }

  async getAPIs(organizationId?: string) {
    const response = await this.client.get('/apis', {
      params: { organizationId },
    })
    return response.data
  }

  async getAPI(id: string) {
    const response = await this.client.get(`/apis/${id}`)
    return response.data
  }

  async deleteAPI(id: string) {
    const response = await this.client.delete(`/apis/${id}`)
    return response.status === 204
  }

  // ==================== Tools Endpoints ====================

  async generateTools(apiId: string) {
    const response = await this.client.post(`/apis/${apiId}/generate-tools`)
    return response.data
  }

  async getTools(organizationId?: string) {
    // Use the organization-scoped endpoint if organizationId is provided,
    // or fall back to the stored organizationId from login/register.
    // NOTE: There is NO /tools endpoint - always use organization-scoped endpoint.
    const orgId = organizationId || this.organizationId
    if (!orgId) {
      console.warn('[APIHelper] getTools: no organizationId available, cannot fetch tools')
      return { data: [] }
    }
    const endpoint = `/organizations/${orgId}/tools`
    console.log(`[APIHelper] getTools: calling ${endpoint}`)
    const response = await this.client.get(endpoint)
    console.log(`[APIHelper] getTools: status=${response.status}, data=`, JSON.stringify(response.data, null, 2))
    // After interceptor unwraps {success, data}, response.data is { tools: [...], total: N }
    // We extract the tools array and return it as { data: [...] } for backward compatibility
    const rawData = response.data
    const toolsArray = rawData?.tools || rawData?.data?.tools || rawData?.data || []
    return { data: Array.isArray(toolsArray) ? toolsArray : [] }
  }

  async waitForTools(minCount: number = 1, timeout: number = 30000) {
    const startTime = Date.now()
    while (Date.now() - startTime < timeout) {
      const response = await this.getTools(this.organizationId)
      // getTools() returns { data: [...] } where data is the normalized tools array
      const toolsList = response.data || []
      const toolCount = Array.isArray(toolsList) ? toolsList.length : 0
      console.log(`[APIHelper] waitForTools: organizationId=${this.organizationId}, got ${toolCount} tools (need ${minCount})`)
      if (toolCount >= minCount) {
        return response
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error(`Timeout waiting for ${minCount} tools (waited ${timeout}ms)`)
  }

  async getTool(id: string) {
    const response = await this.client.get(`/tools/${id}`)
    return response.data
  }

  async executeTool(id: string, parameters: Record<string, any>) {
    const response = await this.client.post(`/tools/${id}/execute`, { parameters })
    return response.data
  }

  async deleteTool(id: string) {
    const response = await this.client.delete(`/tools/${id}`)
    return response.status === 204
  }

  // ==================== Gateways Endpoints ====================

  async createGateway(data: {
    name: string
    type: 'mcp' | 'a2a' | 'utcp'
    endpoint?: string
    endpointPath?: string
    description?: string
    configuration?: Record<string, any>
  }) {
    // Use endpointPath if provided, otherwise use endpoint, with fallback
    let endpoint = data.endpointPath || data.endpoint || `/${data.name.toLowerCase().replace(/\s+/g, '-')}`

    // Ensure endpoint starts with /
    if (!endpoint.startsWith('/')) {
      endpoint = '/' + endpoint
    }

    // Provide valid default configurations based on gateway type
    let defaultConfig: Record<string, any> = {}
    if (!data.configuration) {
      switch (data.type) {
        case 'mcp':
          defaultConfig = { transport: 'http' }
          break
        case 'a2a':
          defaultConfig = { agentCapabilities: {} }
          break
        case 'utcp':
          defaultConfig = { protocol: 'http' }
          break
      }
    }

    // Destructure to exclude endpointPath from the request
    const { endpointPath: _, ...cleanData } = data

    const response = await this.client.post('/gateways', {
      ...cleanData,
      endpoint,
      configuration: data.configuration || defaultConfig,
    })
    // After interceptor unwraps {success, data}, response.data is the gateway object
    return response.data
  }

  async getGateways(organizationId?: string) {
    const response = await this.client.get('/gateways')
    return response.data
  }

  async getGateway(id: string) {
    const response = await this.client.get(`/gateways/${id}`)
    return response.data
  }

  async assignToolToGateway(gatewayId: string, toolId: string) {
    const response = await this.client.post(`/gateways/${gatewayId}/tools`, {
      toolId,
    })
    return response.data
  }

  async removeToolFromGateway(gatewayId: string, toolId: string) {
    const response = await this.client.delete(`/gateways/${gatewayId}/tools/${toolId}`)
    return response.status === 204
  }

  async assignAllTools(gatewayId: string, toolIds: string[]) {
    const promises = toolIds.map(toolId => this.assignToolToGateway(gatewayId, toolId))
    return Promise.all(promises)
  }

  async removeAllTools(gatewayId: string) {
    const response = await this.client.delete(`/gateways/${gatewayId}/tools`)
    return response.status === 204
  }

  async testGateway(id: string) {
    const response = await this.client.post(`/gateways/${id}/test`)
    return response.data
  }

  async deleteGateway(id: string) {
    const response = await this.client.delete(`/gateways/${id}`)
    return response.status === 204
  }

  // ==================== Organizations Endpoints ====================

  async getOrganizations() {
    const response = await this.client.get('/organizations')
    return response.data
  }

  async getOrganization(id: string) {
    const response = await this.client.get(`/organizations/${id}`)
    return response.data
  }

  async updateOrganization(id: string, data: { name?: string; description?: string }) {
    const response = await this.client.patch(`/organizations/${id}`, data)
    return response.data
  }

  // ==================== LLM Providers Endpoints ====================

  async createLLMProvider(data: {
    name: string
    type: 'openai' | 'anthropic' | 'azure-openai'
    apiKey: string
    organizationId?: string
    config?: Record<string, any>
    active?: boolean
  }) {
    const response = await this.client.post('/llm-providers', data)
    return response.data
  }

  async getLLMProviders(organizationId?: string) {
    const response = await this.client.get('/llm-providers', {
      params: { organizationId },
    })
    return response.data
  }

  async getLLMProvider(id: string) {
    const response = await this.client.get(`/llm-providers/${id}`)
    return response.data
  }

  async updateLLMProvider(id: string, data: {
    name?: string
    apiKey?: string
    config?: Record<string, any>
    active?: boolean
  }) {
    const response = await this.client.patch(`/llm-providers/${id}`, data)
    return response.data
  }

  async deleteLLMProvider(id: string) {
    const response = await this.client.delete(`/llm-providers/${id}`)
    return response.status === 204
  }

  async testLLMProviderConnection(id: string) {
    const response = await this.client.post(`/llm-providers/${id}/test-connection`)
    return response.data
  }

  // ==================== Cleanup Helpers ====================

  /**
   * Delete all test data for cleanup
   */
  async cleanupTestData(organizationId: string) {
    // After interceptor unwraps {success, data}, list endpoints return
    // objects like { gateways: [...], total } or { apis: [...], total }

    // Delete all gateways
    const gatewaysResult = await this.getGateways(organizationId)
    const gatewaysList = gatewaysResult?.gateways || gatewaysResult?.data || []
    for (const gateway of gatewaysList) {
      await this.deleteGateway(gateway.id)
    }

    // Delete all tools (getTools already normalizes to { data: [...] })
    const tools = await this.getTools(organizationId)
    if (tools.data) {
      for (const tool of tools.data) {
        await this.deleteTool(tool.id)
      }
    }

    // Delete all APIs
    const apisResult = await this.getAPIs(organizationId)
    const apisList = apisResult?.apis || apisResult?.data || []
    for (const api of apisList) {
      await this.deleteAPI(api.id)
    }

    // Delete all LLM providers
    const providersResult = await this.getLLMProviders(organizationId)
    const providersList = providersResult?.providers || providersResult?.data || []
    for (const provider of providersList) {
      await this.deleteLLMProvider(provider.id)
    }
  }
}
