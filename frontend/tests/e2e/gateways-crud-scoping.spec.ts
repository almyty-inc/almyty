import { test, expect } from './setup/test-hooks'
import { TEST_GATEWAY_CONFIGS, TEST_SCOPING_SCENARIOS } from './fixtures/test-data'

test.describe('Gateways - CRUD & Scoping', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/gateways')
  })

  test('should display gateways page', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.assertPageTitle(/gateways/i)
    await expect(page.getByRole('button', { name: /create gateway/i })).toBeVisible()

    // Should show scoping information
    await expect(page.getByText(/scoping.*achieved.*selective.*tool/i)).toBeVisible()
  })

  test('should show only 3 gateway types (no SCOPED_TOOL type)', async ({ authenticatedPage: page, assertHelper }) => {
    // Open create gateway dialog
    await page.getByRole('button', { name: /create gateway/i }).click()
    await assertHelper.assertDialogOpen()

    // Click gateway type selector
    await page.getByLabel(/gateway type|type/i).click()

    // Should show exactly 3 types
    await expect(page.getByRole('option', { name: /MCP.*Model Context Protocol/i })).toBeVisible()
    await expect(page.getByRole('option', { name: /A2A.*Agent.*Agent/i })).toBeVisible()
    await expect(page.getByRole('option', { name: /UTCP.*Universal Tool Call/i })).toBeVisible()

    // Should NOT show SCOPED_TOOL type
    await expect(page.getByText('Scoped Tool Gateway')).not.toBeVisible()
  })

  test('should create MCP gateway', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('button', { name: /create gateway/i }).click()

    await page.getByLabel('Gateway Name').fill(TEST_GATEWAY_CONFIGS.PUBLIC_MCP.name)
    await page.getByLabel('Endpoint Path').fill(TEST_GATEWAY_CONFIGS.PUBLIC_MCP.endpointPath)
    await page.getByLabel('Description').fill(TEST_GATEWAY_CONFIGS.PUBLIC_MCP.description)

    // Select MCP type
    await page.getByLabel(/gateway type|type/i).click()
    await page.getByRole('option', { name: /MCP/i }).click()

    await page.getByRole('button', { name: /create|save/i }).click()

    // Should show success
    await assertHelper.assertDialogClosed()
    await assertHelper.assertToastMessage(/created|success/i)

    // Should appear in list
    await expect(page.getByText(TEST_GATEWAY_CONFIGS.PUBLIC_MCP.name)).toBeVisible()
  })

  test('should create A2A gateway', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('button', { name: /create gateway/i }).click()

    await page.getByLabel('Gateway Name').fill(TEST_GATEWAY_CONFIGS.ADMIN_A2A.name)
    await page.getByLabel('Endpoint Path').fill(TEST_GATEWAY_CONFIGS.ADMIN_A2A.endpointPath)

    // Select A2A type
    await page.getByLabel(/gateway type|type/i).click()
    await page.getByRole('option', { name: /A2A/i }).click()

    await page.getByRole('button', { name: /create|save/i }).click()

    await assertHelper.assertDialogClosed()
    await expect(page.getByText(TEST_GATEWAY_CONFIGS.ADMIN_A2A.name)).toBeVisible()
  })

  test('should create UTCP gateway', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('button', { name: /create gateway/i }).click()

    await page.getByLabel('Gateway Name').fill(TEST_GATEWAY_CONFIGS.TEST_UTCP.name)
    await page.getByLabel('Endpoint Path').fill(TEST_GATEWAY_CONFIGS.TEST_UTCP.endpointPath)

    // Select UTCP type
    await page.getByLabel(/gateway type|type/i).click()
    await page.getByRole('option', { name: /UTCP/i }).click()

    await page.getByRole('button', { name: /create|save/i }).click()

    await assertHelper.assertDialogClosed()
    await expect(page.getByText(TEST_GATEWAY_CONFIGS.TEST_UTCP.name)).toBeVisible()
  })

  test('[CRITICAL] should show scoping interface with 0/N tools initially', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    // Use timestamp to ensure unique names/endpoints
    const timestamp = Date.now()

    // Create tools first
    const api = await apiHelper.createAPI({
      name: `Scoping Test API ${timestamp}`,
      baseUrl: 'https://scoping.example.com',
      type: 'openapi',
    })

    // Create gateway
    const gateway = await apiHelper.createGateway({
      name: `Scoping Test Gateway ${timestamp}`,
      type: 'mcp',
      endpointPath: `/scoping-test-${timestamp}`,
    })

    // Navigate to gateways page (forces fresh query, avoids stale cache)
    await page.goto('/gateways')
    await assertHelper.waitForLoadingComplete()

    // Open gateway details (clicking heading opens the dialog directly)
    await page.getByRole('heading', { name: `Scoping Test Gateway ${timestamp}` }).click({ timeout: 10000 })

    // Go to Tools tab in the opened dialog
    await page.waitForTimeout(1000)
    await page.getByRole('tab', { name: /tools/i }).click({ timeout: 10000 })

    // Wait for tab content to load
    await page.waitForTimeout(2000)

    // Should show scoping interface
    await expect(page.getByRole('heading', { name: /tool scoping/i })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(/control which tools/i)).toBeVisible({ timeout: 10000 })

    // Should show "0 of 0 assigned" initially
    await expect(page.getByText(/of 0 assigned/i)).toBeVisible({ timeout: 10000 })
  })

  // Tool generation tests - run sequentially to avoid backend overload
  test.describe.serial('Tool Scoping Tests (Sequential)', () => {
    test.setTimeout(90000) // Increased timeout for tool generation (90s)

    test('[CRITICAL] should assign single tool and show "1/N Scoped"', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    const timestamp = Date.now()

    // Create API and tools
    const api = await apiHelper.createAPI({
      name: `Single Tool Test API ${timestamp}`,
      baseUrl: 'https://single.example.com',
      type: 'openapi',
    })

    // Import schema to generate tools
    await apiHelper.importSchema(api.id, {
      schemaUrl: 'https://petstore.swagger.io/v2/swagger.json',
      generateTools: true,
    })

    // Wait for tools to be generated (60s timeout for sequential execution)
    await apiHelper.waitForTools(1, 60000)

    // Create gateway
    const gateway = await apiHelper.createGateway({
      name: `Single Tool Gateway ${timestamp}`,
      type: 'mcp',
      endpointPath: `/single-tool-${timestamp}`,
    })

    // Navigate to gateways page (forces fresh query, avoids stale cache)
    await page.goto('/gateways')
    await assertHelper.waitForLoadingComplete()

    // Open gateway and go to tools tab (clicking heading opens dialog directly)
    await page.getByRole('heading', { name: `Single Tool Gateway ${timestamp}` }).click()
    await page.getByRole('tab', { name: /tools/i }).click()

    // Wait for tools to load
    await expect(page.getByText(/0 of \d+ assigned/i)).toBeVisible()

    // Capture console logs
    const consoleLogs: string[] = []
    page.on('console', msg => {
      const text = msg.text()
      if (text.includes('[ASSIGN]')) {
        consoleLogs.push(text)
        console.log('[TEST CONSOLE]', text)
      }
    })

    // Assign one tool (click the first "Assign" button)
    await page.getByRole('button', { name: /^assign$/i }).first().click()

    // Wait a moment for the click to be processed
    await page.waitForTimeout(2000)

    // Wait for the assignment to complete and UI to update
    await expect(page.getByText(/1 of \d+ assigned/i)).toBeVisible({ timeout: 15000 })

    // Should show "1/N Scoped" text
    await expect(page.getByText(/1\/\d+.*scoped/i)).toBeVisible()
  })

  test('[CRITICAL] should assign all tools and show "N/N Full Access"', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    const timestamp = Date.now()

    // Create tools
    const api = await apiHelper.createAPI({
      name: `Full Access API ${timestamp}`,
      baseUrl: 'https://full.example.com',
      type: 'openapi',
    })

    await apiHelper.importSchema(api.id, {
      schemaUrl: 'https://petstore.swagger.io/v2/swagger.json',
      generateTools: true,
    })

    // Wait for tools to be generated (60s timeout for sequential execution)
    await apiHelper.waitForTools(1, 60000)

    // Create gateway
    const gateway = await apiHelper.createGateway({
      name: `Full Access Gateway ${timestamp}`,
      type: 'mcp',
      endpointPath: `/full-access-${timestamp}`,
    })

    // Navigate to gateways page (forces fresh query, avoids stale cache)
    await page.goto('/gateways')
    await assertHelper.waitForLoadingComplete()

    // Open gateway and go to tools tab (clicking heading opens dialog directly)
    await page.getByRole('heading', { name: `Full Access Gateway ${timestamp}` }).click()
    await page.getByRole('tab', { name: /tools/i }).click()

    // Click "Assign All Tools"
    await page.getByRole('button', { name: /assign all tools/i }).click()

    // Should show "N/N Full Access"
    await expect(page.getByText(/\d+\/\d+/)).toBeVisible()
    await assertHelper.assertBadge(/full access/i)
  })

  test('[CRITICAL] should remove all tools and return to "0/N No Access"', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    const timestamp = Date.now()

    // Setup gateway with tools assigned
    const api = await apiHelper.createAPI({
      name: `Remove Tools API ${timestamp}`,
      baseUrl: 'https://remove.example.com',
      type: 'openapi',
    })

    await apiHelper.importSchema(api.id, {
      schemaUrl: 'https://petstore.swagger.io/v2/swagger.json',
      generateTools: true,
    })

    // Wait for tools to be generated (60s timeout for sequential execution)
    await apiHelper.waitForTools(1, 60000)

    const gateway = await apiHelper.createGateway({
      name: `Remove Tools Gateway ${timestamp}`,
      type: 'mcp',
      endpointPath: `/remove-tools-${timestamp}`,
    })

    // Assign all tools via API
    const tools = await apiHelper.getTools()
    if (tools.data && tools.data.length > 0) {
      await apiHelper.assignToolToGateway(gateway.id, tools.data[0].id)
    }

    // Navigate to gateways page (forces fresh query, avoids stale cache)
    await page.goto('/gateways')
    await assertHelper.waitForLoadingComplete()

    // Open gateway and go to tools tab (clicking heading opens dialog directly)
    await page.getByRole('heading', { name: `Remove Tools Gateway ${timestamp}` }).click()
    await page.getByRole('tab', { name: /tools/i }).click()

    // Should show tools assigned
    await expect(page.getByText(/\d+\/\d+/)).toBeVisible()

    // Click "Remove All Tools"
    await page.getByRole('button', { name: /remove all tools/i }).click()

    // Should confirm
    await page.getByRole('button', { name: /confirm|remove/i }).click()

    // Should show "0/N No Access"
    await expect(page.getByText(/0\/\d+/)).toBeVisible()
    await assertHelper.assertBadge(/no access/i)
    })
  })

  test('should show scoping presets', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    const timestamp = Date.now()

    const gateway = await apiHelper.createGateway({
      name: `Presets Gateway ${timestamp}`,
      type: 'mcp',
      endpointPath: `/presets-${timestamp}`,
    })

    // Navigate to gateways page (forces fresh query, avoids stale cache)
    await page.goto('/gateways')
    await assertHelper.waitForLoadingComplete()

    // Open gateway and go to tools tab (clicking heading opens dialog directly)
    await page.getByRole('heading', { name: `Presets Gateway ${timestamp}` }).click()
    await page.getByRole('tab', { name: /tools/i }).click()

    // Should show scoping presets
    await expect(page.getByText(/common scoping presets/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /read.*only/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /admin.*tools/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /public.*api/i })).toBeVisible()
  })

  test('should show scoping explanation', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    const timestamp = Date.now()

    const gateway = await apiHelper.createGateway({
      name: `Explanation Gateway ${timestamp}`,
      type: 'mcp',
      endpointPath: `/explanation-${timestamp}`,
    })

    // Navigate to gateways page (forces fresh query, avoids stale cache)
    await page.goto('/gateways')
    await assertHelper.waitForLoadingComplete()

    // Open gateway and go to tools tab (clicking heading opens dialog directly)
    await page.getByRole('heading', { name: `Explanation Gateway ${timestamp}` }).click()
    await page.getByRole('tab', { name: /tools/i }).click()

    // Should show scoping explanation
    await expect(page.getByText(/how scoping works/i)).toBeVisible()
    await expect(page.getByText(/no tools.*blocks all requests/i)).toBeVisible()
    await expect(page.getByText(/scoped gateway.*only assigned/i)).toBeVisible()
    await expect(page.getByText(/full access.*all.*tools/i)).toBeVisible()
  })

  test('should display gateway type badges', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    const timestamp = Date.now()

    // Create different gateway types
    await apiHelper.createGateway({
      name: `MCP Badge Gateway ${timestamp}`,
      type: 'mcp',
      endpointPath: `/mcp-badge-${timestamp}`,
    })

    await apiHelper.createGateway({
      name: `A2A Badge Gateway ${timestamp}`,
      type: 'a2a',
      endpointPath: `/a2a-badge-${timestamp}`,
    })

    // Navigate to gateways page (forces fresh query, avoids stale cache)
    await page.goto('/gateways')
    await assertHelper.waitForLoadingComplete()

    // Should show type badges with different colors
    await assertHelper.assertBadge(/MCP/i)
    await assertHelper.assertBadge(/A2A/i)
  })

  test('should display scoping status in main list', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    const timestamp = Date.now()

    // Create gateway with no tools
    await apiHelper.createGateway({
      name: `No Tools Gateway ${timestamp}`,
      type: 'mcp',
      endpointPath: `/no-tools-${timestamp}`,
    })

    // Navigate to gateways page (forces fresh query, avoids stale cache)
    await page.goto('/gateways')
    await assertHelper.waitForLoadingComplete()

    // Should show scoping status near the gateway heading
    await expect(page.getByRole('heading', { name: `No Tools Gateway ${timestamp}` })).toBeVisible()
    await expect(page.getByText(/0.*of.*\d+|0\/\d+/i).first()).toBeVisible()
  })

  test('should delete gateway with confirmation', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    const timestamp = Date.now()

    const gateway = await apiHelper.createGateway({
      name: `To Delete Gateway ${timestamp}`,
      type: 'mcp',
      endpointPath: `/to-delete-${timestamp}`,
    })

    // Navigate to gateways page (forces fresh query, avoids stale cache)
    await page.goto('/gateways')
    await assertHelper.waitForLoadingComplete()

    // Find the gateway heading
    const heading = page.getByRole('heading', { name: `To Delete Gateway ${timestamp}` })
    await expect(heading).toBeVisible()

    // Find the parent container and click the delete button (by aria-label)
    const card = heading.locator('xpath=ancestor::div[contains(@class, "")]').first()
    await card.getByRole('button', { name: /delete gateway/i }).click()

    // Confirm deletion in AlertDialog (uses role="alertdialog", not "dialog")
    const alertDialog = page.getByRole('alertdialog')
    await expect(alertDialog).toBeVisible()
    await expect(alertDialog.getByRole('heading', { name: /delete.*gateway/i })).toBeVisible()
    await alertDialog.getByRole('button', { name: /delete/i }).click()

    // Wait for dialog to close and gateway to be removed
    await expect(alertDialog).not.toBeVisible()
    await expect(page.getByRole('heading', { name: `To Delete Gateway ${timestamp}` })).not.toBeVisible()
  })

  test('should copy gateway endpoint', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    const timestamp = Date.now()

    // Grant clipboard permissions
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

    const gateway = await apiHelper.createGateway({
      name: `Copy Endpoint Gateway ${timestamp}`,
      type: 'mcp',
      endpointPath: `/copy-endpoint-${timestamp}`,
    })

    // Navigate to gateways page (forces fresh query, avoids stale cache)
    await page.goto('/gateways')
    await assertHelper.waitForLoadingComplete()

    // Find the gateway heading
    const heading = page.getByRole('heading', { name: `Copy Endpoint Gateway ${timestamp}` })
    await expect(heading).toBeVisible()

    // Find the parent container and click the copy endpoint button (by aria-label)
    const card = heading.locator('xpath=ancestor::div[contains(@class, "")]').first()
    await card.getByRole('button', { name: /copy endpoint/i }).click()

    // Should show success toast (be specific to avoid matching multiple elements)
    await expect(page.getByText('Copied!').first()).toBeVisible()
    await expect(page.getByText(/Gateway endpoint copied to clipboard/i).first()).toBeVisible()
  })
})
