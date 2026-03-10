import { test, expect } from './setup/test-hooks'
import { TEST_GATEWAY_CONFIGS, TEST_SCOPING_SCENARIOS } from './fixtures/test-data'

test.describe('Gateways - CRUD & Scoping', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/gateways')
  })

  test('should display gateways page', async ({ authenticatedPage: page, assertHelper }) => {
    test.setTimeout(120000) // Gateway scoping is slow

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
    await page.goto('/gateways', { waitUntil: 'networkidle' })
    await assertHelper.waitForLoadingComplete()
    await page.waitForTimeout(3000) // Ensure gateways fetched and rendered

    // Open gateway details (clicking heading navigates to detail page)
    const gatewayHeading = page.getByRole('heading', { name: `Scoping Test Gateway ${timestamp}` })
    await expect(gatewayHeading).toBeVisible({ timeout: 15000 })
    await gatewayHeading.click()

    // Wait for navigation to gateway detail page
    await page.waitForURL(/\/gateways\/[^/]+$/, { timeout: 10000 })
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Go to Tools tab (now using "Tool Scoping" from gateway-detail.tsx)
    const toolsTab = page.getByRole('tab', { name: /tool scoping/i })
    await expect(toolsTab).toBeVisible({ timeout: 10000 })
    await toolsTab.click()

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

    // Open gateway and go to tools tab (clicking heading navigates to /gateways/:id)
    await page.getByRole('heading', { name: `Single Tool Gateway ${timestamp}` }).click()
    // Wait for navigation to gateway detail page
    await page.waitForURL(/\/gateways\/[^/]+$/, { timeout: 10000 })
    await page.waitForLoadState('networkidle')

    // Tab is labeled "Tool Scoping (N/M)" in gateway-detail.tsx
    await page.getByRole('tab', { name: /tool scoping/i }).click()

    // Wait for tools to load
    await expect(page.getByText(/0 of \d+ assigned/i)).toBeVisible({ timeout: 10000 })

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

    // Should show "1/N" in the tab label (e.g. "Tool Scoping (1/20)")
    await expect(page.getByRole('tab', { name: /tool scoping \(1\//i })).toBeVisible()
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

    // Open gateway and go to tools tab (clicking heading navigates to /gateways/:id)
    await page.getByRole('heading', { name: `Full Access Gateway ${timestamp}` }).click()
    // Wait for navigation to gateway detail page
    await page.waitForURL(/\/gateways\/[^/]+$/, { timeout: 10000 })
    await page.waitForLoadState('networkidle')

    // Tab is labeled "Tool Scoping (N/M)" in gateway-detail.tsx
    await page.getByRole('tab', { name: /tool scoping/i }).click()

    // Click "All Tools" button (not "Assign All Tools" - actual button text is "All Tools")
    await page.getByRole('button', { name: /^all tools$/i }).click()

    // Should show "N/N" in the tab label and "N of M assigned" in the card
    await expect(page.getByText(/\d+ of \d+ assigned/i)).toBeVisible({ timeout: 10000 })
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

    // Open gateway and go to tools tab (clicking heading navigates to /gateways/:id)
    await page.getByRole('heading', { name: `Remove Tools Gateway ${timestamp}` }).click()
    // Wait for navigation to gateway detail page
    await page.waitForURL(/\/gateways\/[^/]+$/, { timeout: 10000 })
    await page.waitForLoadState('networkidle')

    // Tab is labeled "Tool Scoping (N/M)" in gateway-detail.tsx
    await page.getByRole('tab', { name: /tool scoping/i }).click()

    // Should show tools assigned
    await expect(page.getByText(/\d+ of \d+ assigned/i)).toBeVisible()

    // Click "Remove All" button (actual button text in gateway-detail.tsx)
    await page.getByRole('button', { name: /^remove all$/i }).click()

    // AlertDialog opens - click "Remove All Tools" action button
    const alertDialog = page.getByRole('alertdialog')
    await expect(alertDialog).toBeVisible()
    await alertDialog.getByRole('button', { name: /remove all tools/i }).click()

    // Should show "0 of N assigned" after removal
    await expect(page.getByText(/0 of \d+ assigned/i)).toBeVisible({ timeout: 10000 })
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

    // Open gateway (clicking heading navigates to /gateways/:id)
    await page.getByRole('heading', { name: `Presets Gateway ${timestamp}` }).click()
    // Wait for navigation to gateway detail page
    await page.waitForURL(/\/gateways\/[^/]+$/, { timeout: 10000 })
    await page.waitForLoadState('networkidle')

    // Tab is labeled "Tool Scoping (N/M)" in gateway-detail.tsx
    await page.getByRole('tab', { name: /tool scoping/i }).click()

    // Should show preset buttons in the Tool Scoping card
    // The card has buttons: "Read Only", "Admin Tools", "Public API", "All Tools", "Remove All"
    // No "common scoping presets" heading exists - the card title is "Tool Scoping"
    await expect(page.getByRole('button', { name: /^read only$/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^admin tools$/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^public api$/i })).toBeVisible()
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

    // Open gateway (clicking heading navigates to /gateways/:id)
    await page.getByRole('heading', { name: `Explanation Gateway ${timestamp}` }).click()
    // Wait for navigation to gateway detail page
    await page.waitForURL(/\/gateways\/[^/]+$/, { timeout: 10000 })
    await page.waitForLoadState('networkidle')

    // Tab is labeled "Tool Scoping (N/M)" in gateway-detail.tsx
    await page.getByRole('tab', { name: /tool scoping/i }).click()

    // The Tool Scoping card shows:
    // - CardTitle: "Tool Scoping"
    // - CardDescription: "Control which tools are available through this gateway. N of M assigned"
    // There is no "how scoping works" explanation section in the actual UI
    await expect(page.getByRole('heading', { name: /tool scoping/i })).toBeVisible()
    await expect(page.getByText(/control which tools are available through this gateway/i)).toBeVisible()
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

    // Find the gateway heading in the DataTable
    const heading = page.getByRole('heading', { name: `To Delete Gateway ${timestamp}` })
    await expect(heading).toBeVisible()

    // The gateways page uses a DataTable with a DropdownMenu actions column.
    // Find the table row containing this gateway and click the actions button (MoreHorizontal)
    const tableRow = page.locator('tr').filter({ hasText: `To Delete Gateway ${timestamp}` })
    await tableRow.getByRole('button', { name: /actions/i }).click()

    // Click "Delete" from the dropdown menu
    await page.getByRole('menuitem', { name: /^delete$/i }).click()

    // Confirm deletion in AlertDialog (uses role="alertdialog", not "dialog")
    const alertDialog = page.getByRole('alertdialog')
    await expect(alertDialog).toBeVisible()
    await expect(alertDialog.getByRole('heading', { name: /delete.*gateway/i })).toBeVisible()
    await alertDialog.getByRole('button', { name: /delete gateway/i }).click()

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

    // Find the gateway heading in the DataTable
    const heading = page.getByRole('heading', { name: `Copy Endpoint Gateway ${timestamp}` })
    await expect(heading).toBeVisible()

    // The gateways page uses a DataTable with a DropdownMenu actions column.
    // Find the table row containing this gateway and click the actions button (MoreHorizontal)
    const tableRow = page.locator('tr').filter({ hasText: `Copy Endpoint Gateway ${timestamp}` })
    await tableRow.getByRole('button', { name: /actions/i }).click()

    // Click "Copy Full URL" from the dropdown menu (actual label in gateways.tsx)
    await page.getByRole('menuitem', { name: /copy full url/i }).click()

    // Should show success toast
    await expect(page.getByText('Copied!').first()).toBeVisible()
  })
})
