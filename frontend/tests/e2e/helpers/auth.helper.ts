import { Page, expect, test } from '@playwright/test'
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
   * Whether the browser holds a session: the httpOnly cookie, which the page
   * cannot read, so ask the API with the context's cookies. (This used to
   * look for a token in localStorage, where the app never keeps one.)
   */
  async isAuthenticated(): Promise<boolean> {
    const response = await this.page.request.get('/auth/profile')
    return response.ok()
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
   * Skips the running test when the target's captcha only passes people.
   *
   * Sign-up needs a captcha token. Cloudflare's and hCaptcha's published test
   * site keys hand one to anyone, a headless browser included; a real key
   * (staging, production) challenges it, so a spec that signs up there fails
   * for a reason that is not a bug. A build without a captcha is not skipped,
   * and neither is one whose captcha frame never loaded: that is the failure
   * signup-captcha.spec.ts exists to catch.
   */
  static async skipUnlessCaptchaAutoPasses(page: Page, timeout = 20_000): Promise<void> {
    // The form renders after the bundle loads; the widget is part of it.
    await page.getByRole('button', { name: 'Create account' }).waitFor()
    if (!(await page.getByTestId('captcha-widget').count())) return
    let siteKey: string | null = null
    await expect
      .poll(() => (siteKey = AuthHelper.captchaSiteKey(page)), { timeout })
      .not.toBeNull()
      .catch(() => undefined)
    test.skip(
      siteKey !== null && !AuthHelper.isAutoPassCaptchaKey(siteKey),
      `the target's captcha uses a real site key (${String(siteKey).slice(0, 8)}...), which a headless browser cannot pass; ` +
        'run sign-up specs against a build with a test key (ALMYTY_TURNSTILE_SITE_KEY=1x00000000000000000000AA)',
    )
  }

  /**
   * The site key in the captcha provider's frame URL, once it has loaded:
   * a path segment of Turnstile's (.../turnstile/f/av0/rch/<id>/<key>/auto/...),
   * the sitekey parameter of hCaptcha's.
   */
  static captchaSiteKey(page: Page): string | null {
    for (const frame of page.frames()) {
      // A frame that has not navigated yet has an empty URL, which URL.parse refuses.
      const url = URL.parse(frame.url())
      if (!url) continue
      if (url.hostname === 'challenges.cloudflare.com') {
        const key = url.pathname.split('/').find((s) => /^[0-3]x[0-9A-Za-z_-]{20,}$/.test(s))
        if (key) return key
      }
      if (/(^|\.)hcaptcha\.com$/.test(url.hostname)) {
        const key = new URLSearchParams(url.hash.slice(1)).get('sitekey') ?? url.searchParams.get('sitekey')
        if (key) return key
      }
    }
    return null
  }

  /** The providers' test site keys that pass every visitor: Turnstile 1x..., hCaptcha's 10000000-... key. */
  static isAutoPassCaptchaKey(siteKey: string): boolean {
    return /^1x0{20}[A-Z]{2}$/.test(siteKey) || siteKey === '10000000-ffff-ffff-ffff-000000000001'
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
