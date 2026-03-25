import { Page } from '@playwright/test'
import { api } from '../../../src/lib/api'

export interface LLMProviderData {
  name: string
  type: 'openai' | 'anthropic' | 'azure' | 'google' | 'cohere' | 'huggingface' | 'aws_bedrock' | 'custom'
  apiKey: string
  model?: string
  description?: string
  configuration?: Record<string, any>
}

export class LLMProvidersHelper {
  private token: string | null = null
  private page: Page

  constructor(page: Page) {
    this.page = page
  }

  setToken(token: string) {
    this.token = token
  }

  async createLLMProvider(data: LLMProviderData) {
    if (!this.token) {
      throw new Error('Token not set. Call setToken() first.')
    }

    const payload = {
      name: data.name,
      description: data.description || `${data.type} provider for testing`,
      type: data.type,
      configuration: {
        apiKey: data.apiKey,
        model: data.model || this.getDefaultModel(data.type),
        maxTokens: 1000,
        temperature: 0.7,
        ...(data.configuration || {}),
      },
    }

    try {
      const apiUrl = process.env.E2E_API_URL || 'http://localhost:4000'
      const response = await fetch(`${apiUrl}/llm-providers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = await response.json()
        console.error('[LLMProvidersHelper] createLLMProvider failed:', errorData)
        throw new Error(`Failed to create LLM provider: ${response.status} ${errorData.message || ''}`)
      }

      const result = await response.json()
      console.log('[LLMProvidersHelper] createLLMProvider success:', result.data || result)
      return result.data || result
    } catch (error: any) {
      console.error('[LLMProvidersHelper] createLLMProvider error:', error.message)
      throw error
    }
  }

  async deleteLLMProvider(providerId: string) {
    if (!this.token) {
      throw new Error('Token not set. Call setToken() first.')
    }

    const apiUrl = process.env.E2E_API_URL || 'http://localhost:4000'
    const response = await fetch(`${apiUrl}/llm-providers/${providerId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to delete LLM provider: ${response.status}`)
    }

    return await response.json()
  }

  private getDefaultModel(type: string): string {
    const defaults: Record<string, string> = {
      openai: 'gpt-4',
      anthropic: 'claude-3-opus-20240229',
      azure: 'gpt-4',
      google: 'gemini-pro',
      cohere: 'command',
      huggingface: 'gpt2',
      aws_bedrock: 'anthropic.claude-v2',
      custom: 'custom-model',
    }
    return defaults[type] || 'default-model'
  }

  /**
   * Setup mock responses for LLM provider API calls
   */
  async setupMockResponses() {
    // Mock test connection endpoint
    await this.page.route('**/api/llm-providers/*/test', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            success: true,
            status: 'connected',
            latency: 150,
            model: 'gpt-4',
            message: 'Connection successful',
          },
        }),
      })
    })

    // Mock models endpoint
    await this.page.route('**/api/llm-providers/*/models', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
          },
        }),
      })
    })

    // Mock usage statistics endpoint
    await this.page.route('**/api/llm-providers/*/usage', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            totalRequests: 1250,
            totalTokens: 45000,
            totalCost: 12.50,
            lastUsed: new Date().toISOString(),
          },
        }),
      })
    })

    console.log('[LLMProvidersHelper] Mock responses setup complete')
  }

  /**
   * Setup mock for provider creation errors (for negative testing)
   */
  async setupErrorMock() {
    await this.page.route('**/api/llm-providers/*/test', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'Invalid API key or connection failed',
        }),
      })
    })
  }
}
