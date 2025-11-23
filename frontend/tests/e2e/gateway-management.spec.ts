import { test, expect } from './setup/test-hooks'

test.describe('Gateway Management', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/gateways')
  })

  test('should load gateways page successfully', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Should show page title (use exact match to avoid matching "Total Gateways", etc.)
    await expect(page.getByRole('heading', { name: 'Gateways', exact: true })).toBeVisible()

    // Should show description with scoping information
    await expect(page.getByText(/scoping.*achieved.*selective.*tool/i)).toBeVisible()
  })

  test('should display gateway information correctly', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Create test API and generate tools
    const api1 = await apiHelper.createAPI({
      name: 'Test API 1',
      baseUrl: 'https://api.example.com/test1',
      type: 'openapi',
    })

    const api2 = await apiHelper.createAPI({
      name: 'Test API 2',
      baseUrl: 'https://api.example.com/test2',
      type: 'openapi',
    })

    // Create MCP gateway with no tools (0 of 2)
    const mcpGateway = await apiHelper.createGateway({
      name: 'Test MCP Gateway',
      type: 'mcp',
      endpoint: '/test-mcp',
      description: 'Test MCP gateway',
    })

    // Create A2A gateway
    const a2aGateway = await apiHelper.createGateway({
      name: 'Test A2A Gateway',
      type: 'a2a',
      endpoint: '/test-a2a',
      description: 'Test A2A gateway',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()

    // Check both gateways appear (persistence working!)
    await expect(page.getByRole('heading', { name: 'Test MCP Gateway' })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('heading', { name: 'Test A2A Gateway' })).toBeVisible({ timeout: 10000 })
  })

  test('should show correct statistics cards', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Create 2 gateways
    await apiHelper.createGateway({
      name: 'Gateway 1',
      type: 'mcp',
      endpoint: '/gw1',
    })

    await apiHelper.createGateway({
      name: 'Gateway 2',
      type: 'a2a',
      endpoint: '/gw2',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()

    // Should show stats
    await expect(page.getByText(/Total Gateways/i)).toBeVisible()
    await expect(page.getByText(/Active Gateways/i)).toBeVisible()
    await expect(page.getByText(/Total Tools/i)).toBeVisible()
  })

  test('should open create gateway dialog', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Click create gateway button
    await page.getByRole('button', { name: /Create Gateway/i }).click()

    // Dialog should open
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText(/Create New Gateway/i)).toBeVisible()
  })

  test('should show only 3 gateway types (no SCOPED_TOOL)', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Open create dialog
    await page.getByRole('button', { name: /Create Gateway/i }).click()

    // Click gateway type selector
    await page.getByLabel(/gateway type|type/i).click()

    // Should show exactly 3 types
    await expect(page.getByRole('option', { name: /MCP.*Model Context Protocol/i })).toBeVisible()
    await expect(page.getByRole('option', { name: /A2A.*Agent.*Agent/i })).toBeVisible()
    await expect(page.getByRole('option', { name: /UTCP.*Universal.*Tool/i })).toBeVisible()

    // Should NOT show SCOPED_TOOL type
    await expect(page.getByRole('option', { name: /SCOPED_TOOL/i })).not.toBeVisible()
  })

  test('should create new gateway', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Open create dialog
    await page.getByRole('button', { name: /Create Gateway/i }).click()

    // Fill form
    await page.getByLabel(/Gateway Name/i).fill('New Test Gateway')
    await page.getByLabel(/gateway type|type/i).click()
    await page.getByRole('option', { name: /MCP/i }).click()
    await page.getByLabel(/Endpoint/i).fill('/new-gateway')

    // Submit
    await page.getByRole('button', { name: /Create Gateway/i }).click()

    // Should show success notification
    await expect(page.getByText(/Gateway created successfully/i).first()).toBeVisible()

    // Gateway should appear in list
    await expect(page.getByText('New Test Gateway')).toBeVisible()
  })

  test('should open gateway details', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Create a gateway
    const gateway = await apiHelper.createGateway({
      name: 'Details Test Gateway',
      type: 'mcp',
      endpoint: '/details-test',
      description: 'Gateway for testing details view',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()

    // Click gateway row to open details
    await page.getByText('Details Test Gateway').click()

    // Should show gateway details
    await expect(page.getByRole('heading', { name: 'Details Test Gateway' })).toBeVisible()
    await expect(page.getByText('Gateway for testing details view').first()).toBeVisible()
  })

  test('should show scoping interface in tools tab', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Create API first
    const api = await apiHelper.createAPI({
      name: 'Scoping Test API',
      baseUrl: 'https://api.example.com/scoping',
      type: 'openapi',
    })

    // Create gateway
    const gateway = await apiHelper.createGateway({
      name: 'Scoping Test Gateway',
      type: 'mcp',
      endpoint: '/scoping-test',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()

    // Open gateway details
    await page.getByText('Scoping Test Gateway').click()

    // Navigate to tools tab if exists
    const toolsTab = page.getByRole('tab', { name: /tools|scoping/i })
    if (await toolsTab.isVisible()) {
      await toolsTab.click()
    }

    // Should show scoping interface
    await expect(page.getByRole('button', { name: /assign all tools/i })).toBeVisible({ timeout: 10000 })
  })

  test('should show proper gateway type indicators', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Create gateways of each type
    await apiHelper.createGateway({
      name: 'MCP Gateway',
      type: 'mcp',
      endpoint: '/mcp-test',
    })

    await apiHelper.createGateway({
      name: 'A2A Gateway',
      type: 'a2a',
      endpoint: '/a2a-test',
    })

    await apiHelper.createGateway({
      name: 'UTCP Gateway',
      type: 'utcp',
      endpoint: '/utcp-test',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()

    // Check each gateway appears with correct type
    await expect(page.getByText('MCP Gateway')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(/Type:.*mcp/i)).toBeVisible({ timeout: 10000 })

    await expect(page.getByText('A2A Gateway')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(/Type:.*a2a/i)).toBeVisible()

    await expect(page.getByText('UTCP Gateway')).toBeVisible()
    await expect(page.getByText(/Type:.*utcp/i)).toBeVisible()
  })
})
