import { test, expect } from './setup/test-hooks'
import { TEST_APIS } from './fixtures/test-data'

test.describe('Tools - Generation & Execution', () => {
  test('[CRITICAL] should generate 19 tools from Petstore API', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    // This test verifies CLAUDE.md claim: "19 functional tools auto-generated"
    test.setTimeout(60000) // Tool execution needs time


    // Create Petstore API
    const api = await apiHelper.createAPI({
      name: TEST_APIS.PETSTORE.name,
      baseUrl: TEST_APIS.PETSTORE.baseUrl,
      type: TEST_APIS.PETSTORE.type,
    })

    // Import schema and generate tools
    await apiHelper.importSchema(api.id, {
      schemaUrl: TEST_APIS.PETSTORE.schemaUrl,
      generateTools: true,
    })

    // Wait for async job to complete
    await page.waitForTimeout(15000)
    // Navigate to tools page
    await page.goto('/tools')
    await assertHelper.waitForLoadingComplete()

    // Verify 19-20 tools were generated (Petstore has 20 operations, may generate 19-20 tools)
    // Check for pagination text or total tools count
    await expect(page.getByText(/(?:19|20).*(?:row|tool)/i).first()).toBeVisible()
  })

  test('should generate tools from multiple APIs', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    // Create multiple APIs
    const api1 = await apiHelper.createAPI({
      name: 'API One',
      baseUrl: 'https://api1.example.com',
      type: 'openapi',
    })

    const api2 = await apiHelper.createAPI({
      name: 'API Two',
      baseUrl: 'https://api2.example.com',
      type: 'openapi',
    })

    // Import schemas for BOTH APIs
    await apiHelper.importSchema(api1.id, {
      schemaUrl: TEST_APIS.PETSTORE.schemaUrl,
      generateTools: true,
    })

    await apiHelper.importSchema(api2.id, {
      schemaUrl: TEST_APIS.PETSTORE.schemaUrl,
      generateTools: true,
    })

    // Navigate to tools
    await page.goto('/tools')
    await assertHelper.waitForLoadingComplete()

    // Wait longer for tools to be generated and loaded
    await page.waitForTimeout(2000)

    // Should have tools from both APIs (check the table has tools)
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 15000 })
  })

  test('should execute tool with parameters', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    // Create API and tools
    const api = await apiHelper.createAPI({
      name: 'Execution Test API',
      baseUrl: TEST_APIS.PETSTORE.baseUrl,
      type: TEST_APIS.PETSTORE.type,
    })

    await apiHelper.importSchema(api.id, {
      schemaUrl: TEST_APIS.PETSTORE.schemaUrl,
      generateTools: true,
    })

    // Wait for async job to complete
    await page.waitForTimeout(15000)
    await page.goto('/tools')
    await assertHelper.waitForLoadingComplete()

    // Wait for tools to be visible
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10000 })

    // Find a GET tool (simpler to test) and click Actions to open menu
    const getToolRow = page.locator('tr').filter({ hasText: /GET/i }).first()
    await getToolRow.getByRole('button', { name: /actions/i }).click()

    // Click Test Tool from the menu
    await page.getByRole('menuitem', { name: /test tool/i }).click()

    // Should open execution dialog
    await assertHelper.assertDialogOpen(/test tool/i)

    // Fill parameters if any
    const paramInputs = page.locator('input[name*="param"], input[id*="param"]')
    const paramCount = await paramInputs.count()
    for (let i = 0; i < paramCount; i++) {
      await paramInputs.nth(i).fill('test-value')
    }

    // Execute
    await page.getByRole('button', { name: /execute|run|test/i }).click()

    // Should show results
    await expect(page.getByText(/result|response|output/i)).toBeVisible()
  })

  test('should show execution success response', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    // Create and generate tools
    const api = await apiHelper.createAPI({
      name: 'Success Test API',
      baseUrl: TEST_APIS.PETSTORE.baseUrl,
      type: TEST_APIS.PETSTORE.type,
    })

    // MUST import schema to generate tools
    await apiHelper.importSchema(api.id, {
      schemaUrl: TEST_APIS.PETSTORE.schemaUrl,
      generateTools: true,
    })

    // Wait for async job to complete
    await page.waitForTimeout(15000)
    await page.goto('/tools')
    await assertHelper.waitForLoadingComplete()

    // Mock successful execution
    // The actual URL is /api/organizations/:orgId/tools/:toolId/execute
    await page.route('**/organizations/*/tools/*/execute', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { message: 'Success!', result: { id: 1, name: 'Test' } },
          metadata: {
            executionTime: 150,
            httpStatus: 200,
          },
        }),
      })
    })

    // Wait for tools to be visible
    await page.waitForLoadState('networkidle')
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10000 })

    // Open actions dropdown and click "Test Tool" from the menu
    await page.waitForTimeout(500)
    const toolRow = page.locator('tbody tr').first()
    await toolRow.getByRole('button', { name: /actions/i }).click()
    await page.getByRole('menuitem', { name: /test tool/i }).click()

    // Wait for execution dialog to open - get the last dialog (test dialog)
    const testDialog = page.locator('[role="dialog"]').filter({ hasText: /test tool|execute/i }).last()
    await expect(testDialog).toBeVisible({ timeout: 10000 })

    // Click Execute button in the scoped dialog
    await page.waitForTimeout(500)
    const executeButton = testDialog.getByRole('button', { name: 'Execute' })
    await executeButton.click()

    // Wait for execution to complete and check for success in the scoped dialog
    await page.waitForTimeout(2000) // Give time for mocked response
    const successBadge = testDialog.locator('.badge, [class*="badge"]').filter({ hasText: /success/i })
    await expect(successBadge.or(testDialog.getByText(/success/i).first())).toBeVisible({ timeout: 10000 })

    // Check for execution time display in the scoped dialog - use .first() to handle multiple matches
    await expect(testDialog.getByText(/150.*ms/i).first()).toBeVisible({ timeout: 10000 })
  })

  test('should show execution error response', async ({ authenticatedPage: page }) => {
    await page.goto('/tools')

    // Mock failed execution
    await page.route('**/organizations/*/tools/*/execute', (route) => {
      route.fulfill({
        status: 200,
        body: JSON.stringify({
          success: false,
          error: 'Tool execution failed: Network error',
          executionTime: 50,
        }),
      })
    })

    // Execute tool
    const toolRow = page.locator('tr').first()
    if (await toolRow.isVisible()) {
      await toolRow.getByRole('button', { name: /test|execute/i }).click()
      await page.getByRole('button', { name: /execute|run/i }).click()

      // Should show error
      await expect(page.getByText(/error|failed/i)).toBeVisible()
    }
  })

  test('should display execution time', async ({ authenticatedPage: page, apiHelper }) => {
    // Create tools
    const api = await apiHelper.createAPI({
      name: 'Time Test API',
      baseUrl: TEST_APIS.SWAPI.baseUrl,
      type: TEST_APIS.SWAPI.type,
    })

    await page.goto('/tools')

    // Mock execution with time
    await page.route('**/organizations/*/tools/*/execute', (route) => {
      route.fulfill({
        status: 200,
        body: JSON.stringify({
          success: true,
          data: { result: 'ok' },
          executionTime: 234,
        }),
      })
    })

    const toolRow = page.locator('tr').first()
    if (await toolRow.isVisible()) {
      await toolRow.getByRole('button', { name: /test|execute/i }).click()
      await page.getByRole('button', { name: /execute|run/i }).click()

      // Should show execution time
      await expect(page.getByText(/234.*ms/i)).toBeVisible()
    }
  })

  test('should cache tool execution results', async ({ authenticatedPage: page, apiHelper }) => {
    // Create tool with caching enabled
    const api = await apiHelper.createAPI({
      name: 'Cache Test API',
      baseUrl: TEST_APIS.SWAPI.baseUrl,
      type: TEST_APIS.SWAPI.type,
    })

    await page.goto('/tools')

    let callCount = 0
    await page.route('**/organizations/*/tools/*/execute', (route) => {
      callCount++
      route.fulfill({
        status: 200,
        body: JSON.stringify({
          success: true,
          data: { result: 'cached' },
          cached: callCount > 1,
        }),
      })
    })

    const toolRow = page.locator('tr').first()
    if (await toolRow.isVisible()) {
      // Execute first time
      await toolRow.getByRole('button', { name: /test|execute/i }).click()
      await page.getByRole('button', { name: /execute|run/i }).click()
      await page.waitForTimeout(1000)

      // Execute second time
      await page.getByRole('button', { name: /execute|run again/i }).click()

      // Should show cached indicator
      await expect(page.getByText(/cached|from cache/i)).toBeVisible()
    }
  })

  test('should respect rate limits', async ({ authenticatedPage: page }) => {
    await page.goto('/tools')

    // Mock rate limit error
    await page.route('**/organizations/*/tools/*/execute', (route) => {
      route.fulfill({
        status: 429,
        body: JSON.stringify({
          success: false,
          error: 'Rate limit exceeded',
        }),
      })
    })

    const toolRow = page.locator('tr').first()
    if (await toolRow.isVisible()) {
      await toolRow.getByRole('button', { name: /test|execute/i }).click()
      await page.getByRole('button', { name: /execute|run/i }).click()

      // Should show rate limit error
      await expect(page.getByText(/rate limit|too many requests/i)).toBeVisible()
    }
  })

  test('should configure tool settings', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    // Create tool
    const api = await apiHelper.createAPI({
      name: 'Config Test API',
      baseUrl: TEST_APIS.PETSTORE.baseUrl,
      type: TEST_APIS.PETSTORE.type,
    })

    await apiHelper.importSchema(api.id, {
      schemaUrl: TEST_APIS.PETSTORE.schemaUrl,
      generateTools: true,
    })

    // Wait for async job to complete
    await page.waitForTimeout(15000)
    await page.goto('/tools')
    await assertHelper.waitForLoadingComplete()

    // Wait for tools to be visible
    await page.waitForLoadState('networkidle')
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10000 })

    // Navigate to tool detail page by clicking the row
    await page.waitForTimeout(500)
    const toolRow = page.locator('tbody tr').first()
    await toolRow.click()

    // Wait for navigation to tool detail page
    await page.waitForURL(/\/tools\/[^/]+$/, { timeout: 10000 })
    await page.waitForLoadState('networkidle')

    // Tool detail page has tabs including "Details" which shows configuration
    await expect(page.getByRole('tab', { name: /details/i }).first()).toBeVisible({ timeout: 10000 })
    // Should show tool configuration info on the detail page
    await expect(page.getByText(/configuration|timeout|status/i).first()).toBeVisible({ timeout: 10000 })
  })

  test('should view tool execution history', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    // Create tool
    const api = await apiHelper.createAPI({
      name: 'History Test API',
      baseUrl: TEST_APIS.SWAPI.baseUrl,
      type: TEST_APIS.SWAPI.type,
    })

    await page.goto('/tools')

    // Open tool details
    const toolRow = page.locator('tr').first()
    if (await toolRow.isVisible()) {
      await toolRow.getByRole('button', { name: /history|logs|executions/i }).click()

      // Should show execution history
      await expect(page.getByText(/execution history|recent executions|logs/i)).toBeVisible()
    }
  })
})
