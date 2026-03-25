import { test, expect } from './setup/test-hooks'

test.describe('Analytics Dashboard', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/analytics')
  })

  test('should display analytics page', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.assertPageTitle(/analytics/i)
    // Subtitle is always visible
    await expect(page.getByText(/Real-time usage data across all protocols/i)).toBeVisible()
  })

  test('should show overview stat cards or empty state', async ({ authenticatedPage: page }) => {
    // Overview tab is shown by default — either stat cards or empty state
    const hasStatCards = await page.getByText(/Requests \(24h\)/i).first().isVisible().catch(() => false)
    if (hasStatCards) {
      // Verify a subset of stat card labels
      await expect(page.getByText(/Requests \(24h\)/i).first()).toBeVisible()
      await expect(page.getByText(/Tool Executions \(24h\)/i).first()).toBeVisible()
    } else {
      // Empty state when no analytics data exists
      await expect(page.getByText(/No analytics data yet/i)).toBeVisible()
    }
  })

  test('should render requests over time chart or empty state', async ({ authenticatedPage: page }) => {
    // Overview tab is visible by default
    await expect(page.getByText(/Overview/i).first()).toBeVisible()
    // The chart card "Requests (7 days)" is rendered below stat cards/empty state on the overview tab
    // When the overview API returns data or null, the chart card is always present
    const hasChart = await page.getByText(/Requests \(7 days\)/i).first().isVisible({ timeout: 10000 }).catch(() => false)
    const hasEmpty = await page.getByText(/No analytics data yet/i).isVisible().catch(() => false)
    expect(hasChart || hasEmpty).toBe(true)
  })

  test('should display all tab labels', async ({ authenticatedPage: page }) => {
    // All 6 tabs should be visible
    await expect(page.getByText('Overview').first()).toBeVisible()
    await expect(page.getByText('Request Log').first()).toBeVisible()
    await expect(page.getByText('Tools', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Gateways', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('LLM', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Agents', { exact: true }).first()).toBeVisible()
  })

  test('should navigate to Request Log tab and show filters', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByText('Request Log').click()
    await assertHelper.waitForLoadingComplete()

    // Filter buttons should be visible
    await expect(page.getByRole('button', { name: 'All' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Success' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Error' })).toBeVisible()

    // Either a table with the correct headers or empty state
    const hasData = await page.locator('table').isVisible().catch(() => false)
    if (hasData) {
      await expect(page.getByText('Time').first()).toBeVisible()
      await expect(page.getByText('Method').first()).toBeVisible()
      await expect(page.getByText('Path').first()).toBeVisible()
      await expect(page.getByText('Status').first()).toBeVisible()
      await expect(page.getByText('Duration').first()).toBeVisible()
      await expect(page.getByText('Protocol').first()).toBeVisible()
      await expect(page.getByText('IP').first()).toBeVisible()
    } else {
      await expect(page.getByText(/No request logs yet/i)).toBeVisible()
    }
  })

  test('should navigate to Tools tab and show timeframe selector', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByText('Tools', { exact: true }).click()
    await assertHelper.waitForLoadingComplete()

    // Timeframe buttons should be visible (rendered by TimeframeSelector)
    await expect(page.getByRole('button', { name: '7d' })).toBeVisible()

    // Either tool usage table or empty state
    const hasData = await page.locator('table').isVisible().catch(() => false)
    if (hasData) {
      await expect(page.getByText('Tool').first()).toBeVisible()
    } else {
      await expect(page.getByText(/No tool usage data/i)).toBeVisible()
    }
  })

  test('should navigate to Gateways tab and show gateway usage', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByText('Gateways', { exact: true }).click()
    await assertHelper.waitForLoadingComplete()

    // Timeframe buttons should be visible
    await expect(page.getByRole('button', { name: '7d' })).toBeVisible()

    // Either gateway usage table or empty state
    const hasData = await page.locator('table').isVisible().catch(() => false)
    if (hasData) {
      await expect(page.getByText('Gateway').first()).toBeVisible()
      await expect(page.getByText('Protocol').first()).toBeVisible()
      await expect(page.getByText('Requests').first()).toBeVisible()
      await expect(page.getByText(/^Success$/).first()).toBeVisible()
      await expect(page.getByText(/^Errors$/).first()).toBeVisible()
      await expect(page.getByText('Success Rate').first()).toBeVisible()
    } else {
      await expect(page.getByText(/No gateway usage data/i)).toBeVisible()
    }
  })

  test('should navigate to LLM tab and show LLM usage', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByText('LLM', { exact: true }).click()
    await assertHelper.waitForLoadingComplete()

    // Timeframe buttons should be visible
    await expect(page.getByRole('button', { name: '7d' })).toBeVisible()

    // Either LLM usage table or empty state
    const hasData = await page.locator('table').isVisible().catch(() => false)
    if (hasData) {
      await expect(page.getByText('Provider').first()).toBeVisible()
      await expect(page.getByText('Sessions').first()).toBeVisible()
      await expect(page.getByText('Messages').first()).toBeVisible()
      await expect(page.getByText('Input Tokens').first()).toBeVisible()
      await expect(page.getByText('Output Tokens').first()).toBeVisible()
      await expect(page.getByText('Tool Calls').first()).toBeVisible()
      await expect(page.getByText('Cost').first()).toBeVisible()
    } else {
      await expect(page.getByText(/No LLM usage data/i)).toBeVisible()
    }
  })

  test('should navigate to Agents tab and show agent data or empty state', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByText('Agents', { exact: true }).click()
    await assertHelper.waitForLoadingComplete()

    // Either agent stats or empty state
    const hasData = await page.getByText(/Executions \(24h\)/i).first().isVisible().catch(() => false)
    if (hasData) {
      await expect(page.getByText(/Executions \(24h\)/i).first()).toBeVisible()
      await expect(page.getByText('Top Agents by Usage').first()).toBeVisible()
    } else {
      await expect(page.getByText(/No agent data yet/i)).toBeVisible()
    }
  })

  test('should switch timeframe on Tools tab', async ({ authenticatedPage: page, assertHelper }) => {
    // Navigate to the Tools tab which has the TimeframeSelector
    await page.getByText('Tools', { exact: true }).click()
    await assertHelper.waitForLoadingComplete()

    // Click 30d timeframe button
    const timeframeButton = page.getByRole('button', { name: '30d' })
    await expect(timeframeButton).toBeVisible()
    await timeframeButton.click()
    await assertHelper.waitForLoadingComplete()

    // Click 1h timeframe button
    const oneHourButton = page.getByRole('button', { name: '1h' })
    await expect(oneHourButton).toBeVisible()
    await oneHourButton.click()
    await assertHelper.waitForLoadingComplete()

    // Buttons should still be visible after clicking
    await expect(oneHourButton).toBeVisible()
  })

  test('should show export CSV button', async ({ authenticatedPage: page }) => {
    const exportCsvButton = page.getByRole('button', { name: /export csv/i })
    await expect(exportCsvButton).toBeVisible()
    await expect(exportCsvButton).toBeEnabled()
  })

  test('should show export JSON button', async ({ authenticatedPage: page }) => {
    const exportJsonButton = page.getByRole('button', { name: /export json/i })
    await expect(exportJsonButton).toBeVisible()
    await expect(exportJsonButton).toBeEnabled()
  })

  test('should filter request log by status', async ({ authenticatedPage: page, assertHelper }) => {
    // Navigate to Request Log tab
    await page.getByText('Request Log').click()
    await assertHelper.waitForLoadingComplete()

    // Click Success filter
    await page.getByRole('button', { name: 'Success' }).click()
    await assertHelper.waitForLoadingComplete()

    // Click Error filter
    await page.getByRole('button', { name: 'Error' }).click()
    await assertHelper.waitForLoadingComplete()

    // Click All filter to reset
    await page.getByRole('button', { name: 'All' }).click()
    await assertHelper.waitForLoadingComplete()
  })

  test('should handle empty analytics data gracefully', async ({ authenticatedPage: page, assertHelper }) => {
    // Mock empty responses for all analytics endpoints to return falsy data
    await page.route('**/analytics/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(null),
      })
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()

    // Should show empty state or render gracefully without errors
    const hasEmptyState = await page.getByText(/No analytics data yet/i).isVisible().catch(() => false)
    const hasOverviewTab = await page.getByText(/Overview/i).first().isVisible().catch(() => false)
    expect(hasEmptyState || hasOverviewTab).toBe(true)
  })

  test('should display real-time subtitle', async ({ authenticatedPage: page }) => {
    // The subtitle "Real-time usage data across all protocols" is always present
    await expect(page.getByText(/Real-time usage data across all protocols/i)).toBeVisible()
  })
})
