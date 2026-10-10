import { Page, expect } from '@playwright/test'
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
    this.apiHelper = new APIHelper(process.env.E2E_API_URL || 'http://localhost:4000')
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
   * Register a new user via API (faster). Registration answers with a
   * cookie and no token, so the helper signs in through the non-browser
   * login (/auth/token) to learn the user's id and organization.
   */
  async registerViaAPI(user: Omit<TestUser, 'token' | 'id' | 'organizationId'>): Promise<TestUser> {
    await this.apiHelper.register(user)
    const tokens = await this.apiHelper.login(user.email, user.password)
    if (!tokens?.accessToken) {
      throw new Error(`Registration failed: ${JSON.stringify(tokens)}`)
    }

    const tokenPayload = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64').toString())

    return {
      ...user,
      token: tokens.accessToken,
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
   * Login via API (faster). The browser's session is the httpOnly cookie
   * from /auth/login, set on this page's context; the API helper holds a
   * separate bearer token from /auth/token for its own calls.
   */
  async loginViaAPI(email: string, password: string): Promise<string> {
    const apiUrl = process.env.E2E_API_URL || 'http://localhost:4000'
    await this.page.request.post(`${apiUrl}/auth/login`, { data: { email, password } })
    const tokens = await this.apiHelper.login(email, password)

    // Fetch full user profile to match real auth flow
    // This gets complete organization data, not just JWT payload
    const user = await this.apiHelper.getProfile()

    await this.setAuthState(user)
    return tokens.accessToken
  }

  /**
   * Seed the display state the app persists (never a token: the session
   * is the httpOnly cookie).
   */
  async setAuthState(user: any) {
    const seed = (u: any) => {
      localStorage.setItem('user', JSON.stringify(u))
      localStorage.setItem('auth-storage', JSON.stringify({
        state: { user: u, isAuthenticated: true },
        version: 0,
      }))
    }
    // Set via addInitScript for new page navigations
    await this.page.addInitScript(seed, user)

    // ALSO set directly if page is already navigated (persists through reloads!)
    const url = this.page.url()
    if (url && url !== 'about:blank' && !url.startsWith('data:')) {
      await this.page.evaluate(seed, user)
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
   * On a build with a captcha site key, wait until the provider's iframe has
   * loaded and handed the form a token; the form refuses to submit before
   * then. Returns false, at once, on a build without one.
   *
   * Turnstile mounts its iframe in a closed shadow root, so this looks for
   * the frame and the hidden response field rather than inside the widget.
   */
  static async waitForCaptcha(page: Page, timeout = 20_000): Promise<boolean> {
    if (!(await page.getByTestId('captcha-widget').count())) return false
    await expect
      .poll(() => page.frames().some((f) => /challenges\.cloudflare\.com|hcaptcha\.com/.test(f.url())), { timeout })
      .toBe(true)
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (document.querySelector('[name="cf-turnstile-response"], [name="h-captcha-response"]') as HTMLInputElement | null)
                ?.value ?? '',
          ),
        { timeout },
      )
      .not.toBe('')
    return true
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
