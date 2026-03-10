import { Page, expect } from '@playwright/test'

/**
 * Custom assertions helper for E2E tests
 * Provides reusable assertion patterns
 */
export class AssertionsHelper {
  constructor(private page: Page) {}

  /**
   * Assert user is on login page
   */
  async assertOnLoginPage() {
    await expect(this.page).toHaveURL(/\/auth\/login/)
    await expect(this.page.getByRole('heading', { name: /sign in/i })).toBeVisible()
  }

  /**
   * Assert user is on dashboard
   */
  async assertOnDashboard() {
    await expect(this.page).toHaveURL(/\/dashboard/)
    await expect(this.page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
  }

  /**
   * Assert toast notification appears with message
   */
  async assertToastMessage(message: string | RegExp) {
    // Look for toast specifically (li element with role="status"), not screen reader announcements
    const toast = this.page.locator('li[role="status"]').filter({ hasText: message })
    await expect(toast).toBeVisible({ timeout: 5000 })
  }

  /**
   * Assert error message appears
   */
  async assertErrorMessage(message: string | RegExp) {
    const error = this.page.getByText(message)
    await expect(error).toBeVisible()
  }

  /**
   * Assert loading state
   */
  async assertLoading() {
    await expect(this.page.getByText(/loading/i)).toBeVisible()
  }

  /**
   * Wait for loading to complete
   */
  async waitForLoadingComplete() {
    await this.page.waitForLoadState('networkidle')
    // Also wait for any loading spinners to disappear
    await expect(this.page.getByText(/loading/i)).toBeHidden({ timeout: 10000 }).catch(() => {})
  }

  /**
   * Assert table has N rows
   */
  async assertTableRowCount(count: number) {
    const rows = this.page.locator('table tbody tr')
    await expect(rows).toHaveCount(count)
  }

  /**
   * Assert table contains text
   */
  async assertTableContainsText(text: string | RegExp) {
    const table = this.page.locator('table')
    await expect(table).toContainText(text)
  }

  /**
   * Assert stat card shows value
   */
  async assertStatCard(title: string | RegExp, value: string | RegExp) {
    const card = this.page.locator('.card, [class*="card"]').filter({ hasText: title })
    await expect(card).toContainText(value)
  }

  /**
   * Assert badge with text is visible
   * Supports shadcn/ui Badge component (uses CVA classes, not literal "badge" class)
   */
  async assertBadge(text: string | RegExp) {
    // shadcn/ui Badge renders as a div/span with inline-flex and rounded-full classes
    // Try common badge selectors first, then fall back to any inline-flex rounded element
    const badge = this.page.locator(
      '.badge, [class*="badge"], div[class*="rounded-full"], span[class*="rounded-full"]'
    ).filter({ hasText: text })
    await expect(badge.first()).toBeVisible()
  }

  /**
   * Assert dialog is open
   */
  async assertDialogOpen(title?: string | RegExp) {
    const dialog = this.page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    if (title) {
      // Look specifically for heading with title to avoid matching buttons
      await expect(dialog.getByRole('heading', { name: title })).toBeVisible()
    }
  }

  /**
   * Assert dialog is closed
   */
  async assertDialogClosed() {
    const dialog = this.page.getByRole('dialog')
    // Wait for dialog to close (including animation time)
    await expect(dialog).not.toBeVisible({ timeout: 2000 })
  }

  /**
   * Assert dialog is open and ready for interaction
   */
  async assertDialogOpenAndInteractive(titlePattern?: RegExp) {
    const dialog = this.page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 10000 })
    await this.page.waitForTimeout(500) // Let dialog animations complete
    if (titlePattern) {
      await expect(dialog.getByRole('heading', { name: titlePattern })).toBeVisible()
    }
  }

  /**
   * Assert element is disabled
   */
  async assertDisabled(selector: string | RegExp) {
    const element = typeof selector === 'string'
      ? this.page.locator(selector)
      : this.page.getByRole('button', { name: selector })
    await expect(element).toBeDisabled()
  }

  /**
   * Assert element is enabled
   */
  async assertEnabled(selector: string | RegExp) {
    const element = typeof selector === 'string'
      ? this.page.locator(selector)
      : this.page.getByRole('button', { name: selector })
    await expect(element).toBeEnabled()
  }

  /**
   * Assert page title
   */
  async assertPageTitle(title: string | RegExp) {
    await expect(this.page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
  }

  /**
   * Assert navigation item is active
   */
  async assertNavActive(name: string | RegExp) {
    const navItem = this.page.getByRole('link', { name })
    // Check for aria-current or active class
    const hasAriaCurrent = await navItem.getAttribute('aria-current').then(val => val === 'page').catch(() => false)
    const className = await navItem.getAttribute('class').catch(() => '')
    const hasActiveClass = /active|bg-/.test(className || '')

    expect(hasAriaCurrent || hasActiveClass).toBe(true)
  }

  /**
   * Assert API response status (for debugging)
   */
  async waitForAPIResponse(urlPattern: string | RegExp, status: number = 200): Promise<any> {
    const response = await this.page.waitForResponse(
      resp => (typeof urlPattern === 'string' ? resp.url().includes(urlPattern) : urlPattern.test(resp.url())) && resp.status() === status
    )
    return response.json().catch(() => null)
  }

  /**
   * Assert chart is visible with data
   */
  async assertChartWithData() {
    const chart = this.page.locator('svg.recharts-surface')
    await expect(chart).toBeVisible()
  }

  /**
   * Assert empty state is shown
   */
  async assertEmptyState(message?: string | RegExp) {
    const emptyState = this.page.locator('[class*="empty"]')
    await expect(emptyState).toBeVisible()
    if (message) {
      await expect(emptyState).toContainText(message)
    }
  }

  /**
   * Assert gateway scoping badge
   */
  async assertGatewayScopingBadge(gatewayName: string, badgeText: 'No Access' | 'Scoped' | 'Full Access') {
    const row = this.page.locator('tr').filter({ hasText: gatewayName })
    const badge = row.locator('.badge, [class*="badge"]').filter({ hasText: badgeText })
    await expect(badge).toBeVisible()
  }

  /**
   * Assert tool count display (e.g., "5/10")
   */
  async assertToolCount(gatewayName: string, assigned: number, total: number) {
    const row = this.page.locator('tr').filter({ hasText: gatewayName })
    await expect(row).toContainText(`${assigned}/${total}`)
      .or(expect(row).toContainText(`${assigned} of ${total}`))
  }
}
