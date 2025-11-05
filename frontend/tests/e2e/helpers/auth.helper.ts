import { Page } from '@playwright/test'
import { APIHelper } from './api.helper'

export interface TestUser {
  email: string
  password: string
  firstName: string
  lastName: string
  organizationName: string
  token?: string
  id?: string
  organizationId?: string
}

/**
 * Authentication helper for E2E tests
 * Provides utilities for login, logout, and user management
 */
export class AuthHelper {
  private apiHelper: APIHelper

  constructor(private page: Page) {
    this.apiHelper = new APIHelper()
  }

  /**
   * Register a new user via UI
   */
  async registerViaUI(user: Omit<TestUser, 'token' | 'id' | 'organizationId'>) {
    await this.page.goto('/auth/register')
    await this.page.getByLabel('First Name').fill(user.firstName)
    await this.page.getByLabel('Last Name').fill(user.lastName)
    await this.page.getByLabel('Email').fill(user.email)
    await this.page.getByLabel('Password', { exact: true }).fill(user.password)
    await this.page.getByLabel('Confirm Password').fill(user.password)
    await this.page.getByLabel('Organization Name').fill(user.organizationName)
    await this.page.getByRole('button', { name: 'Register' }).click()
  }

  /**
   * Register a new user via API (faster)
   */
  async registerViaAPI(user: Omit<TestUser, 'token' | 'id' | 'organizationId'>): Promise<TestUser> {
    const response = await this.apiHelper.register(user)

    // Check if response contains accessToken
    if (!response || !response.accessToken) {
      throw new Error(`Registration failed: ${JSON.stringify(response)}`)
    }

    // Decode JWT to get user info (backend doesn't return user object directly)
    const tokenPayload = JSON.parse(Buffer.from(response.accessToken.split('.')[1], 'base64').toString())

    return {
      ...user,
      token: response.accessToken,
      id: tokenPayload.sub,
      organizationId: tokenPayload.organizations[0]?.id,
    }
  }

  /**
   * Login via UI
   */
  async loginViaUI(email: string, password: string) {
    await this.page.goto('/auth/login')
    await this.page.getByLabel('Email').fill(email)
    await this.page.getByLabel('Password').fill(password)
    await this.page.getByRole('button', { name: 'Sign In' }).click()
  }

  /**
   * Login via API and set token in localStorage (faster)
   */
  async loginViaAPI(email: string, password: string): Promise<string> {
    const response = await this.apiHelper.login(email, password)

    // Fetch full user profile to match real auth flow
    // This gets complete organization data, not just JWT payload
    const profileResponse = await this.apiHelper.getProfile()
    const user = profileResponse

    await this.setAuthState(response.accessToken, user)
    return response.accessToken
  }

  /**
   * Set authentication state in localStorage
   */
  async setAuthState(token: string, user: any) {
    // Set via addInitScript for new page navigations
    await this.page.addInitScript(({ token, user }) => {
      localStorage.setItem('token', token)
      localStorage.setItem('user', JSON.stringify(user))
      localStorage.setItem('auth-storage', JSON.stringify({
        state: {
          user,
          token,
          isAuthenticated: true,
        },
        version: 0,
      }))
    }, { token, user })

    // ALSO set directly if page is already navigated (persists through reloads!)
    const url = this.page.url()
    if (url && url !== 'about:blank' && !url.startsWith('data:')) {
      await this.page.evaluate(({ token, user }) => {
        localStorage.setItem('token', token)
        localStorage.setItem('user', JSON.stringify(user))
        localStorage.setItem('auth-storage', JSON.stringify({
          state: {
            user,
            token,
            isAuthenticated: true,
          },
          version: 0,
        }))
      }, { token, user })
    }
  }

  /**
   * Logout via UI
   */
  async logoutViaUI() {
    await this.page.getByRole('button', { name: 'User Menu' }).click()
    await this.page.getByText('Logout').click()
  }

  /**
   * Clear authentication state
   */
  async clearAuthState() {
    await this.page.evaluate(() => {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      localStorage.removeItem('auth-storage')
    })
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const token = localStorage.getItem('token')
      return !!token
    })
  }

  /**
   * Generate unique test user data
   */
  static generateTestUser(suffix?: string): Omit<TestUser, 'token' | 'id' | 'organizationId'> {
    const timestamp = Date.now()
    const random = Math.random().toString(36).substring(7)
    const uniqueId = suffix ? `${suffix}-${timestamp}-${random}` : `${timestamp}-${random}`

    return {
      email: `test-${uniqueId}@example.com`,
      password: 'Test@123456',
      firstName: 'Test',
      lastName: 'User',
      organizationName: `Test Org ${uniqueId}`,
    }
  }
}
