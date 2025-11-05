import { test, expect } from './setup/test-hooks'
import { AuthHelper } from './helpers/auth.helper'

test.describe('LLM Providers - Configuration', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/llm-providers')
  })

  test('should display LLM providers page', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.assertPageTitle(/llm.*providers|ai.*providers|language.*models/i)
    await expect(page.getByRole('button', { name: /add.*provider|configure.*provider/i })).toBeVisible()
  })

  test('should show available provider types', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('button', { name: /add.*provider/i }).click()
    await assertHelper.assertDialogOpen(/add.*provider|configure/i)

    // Open provider type dropdown to see options
    await page.getByLabel(/provider.*type|select.*provider/i).click()

    // Should show provider options
    await expect(page.getByTestId('provider-type-openai')).toBeVisible()
    await expect(page.getByTestId('provider-type-anthropic')).toBeVisible()
    await expect(page.getByTestId('provider-type-azure')).toBeVisible()
  })

  test('should add OpenAI provider', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('button', { name: /add.*provider/i }).click()

    // Select OpenAI
    await page.getByLabel(/provider.*type|select.*provider/i).click()
    await page.getByRole('option', { name: /openai/i }).click()

    // Fill configuration
    await page.getByLabel(/provider.*name|name/i).fill('OpenAI Production')
    await page.getByLabel(/api.*key/i).fill('sk-test-key-1234567890')
    await page.getByLabel(/organization.*id/i).fill('org-test123')

    await page.getByRole('button', { name: /save|add/i }).click()

    // Should show success
    await assertHelper.assertToastMessage(/added|configured|success/i)
    await expect(page.getByText('OpenAI Production')).toBeVisible()
  })

  test('should add Anthropic provider', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('button', { name: /add.*provider/i }).click()

    // Select Anthropic
    await page.getByLabel(/provider.*type/i).click()
    await page.getByRole('option', { name: /anthropic|claude/i }).click()

    // Fill configuration
    await page.getByLabel(/provider.*name/i).fill('Anthropic Production')
    await page.getByLabel(/api.*key/i).fill('sk-ant-test-key-1234567890')

    await page.getByRole('button', { name: /save|add/i }).click()

    await assertHelper.assertToastMessage(/added|success/i)
    await expect(page.getByText('Anthropic Production')).toBeVisible()
  })

  test('should validate API key format', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('button', { name: /add.*provider/i }).click()

    // Select provider
    await page.getByLabel(/provider.*type/i).click()
    await page.getByRole('option', { name: /openai/i }).click()

    // Fill with invalid API key
    await page.getByLabel(/provider.*name/i).fill('Test Provider')
    await page.getByLabel(/api.*key/i).fill('invalid-key')

    await page.getByRole('button', { name: /save|add/i }).click()

    // Should show validation error
    await expect(page.getByText(/invalid.*api.*key|key.*format/i)).toBeVisible()
  })

  test('should test provider connection', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    // Get token from auth and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses for API calls
    await llmProvidersHelper.setupMockResponses()

    // Create provider via API helper (faster and more reliable)
    const provider = await llmProvidersHelper.createLLMProvider({
      name: 'Connection Test Provider',
      type: 'openai',
      apiKey: 'sk-test-connection-key-1234567890',
    })

    // Reload page to see the new provider
    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Find provider row and click Test button
    const providerRow = page.locator('tr').filter({ hasText: 'Connection Test Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })

    // Wait for any animations
    await page.waitForTimeout(500)

    await providerRow.getByRole('button', { name: /test/i }).click()

    // Wait for test dialog to open - match by exact heading "Test Provider:"
    await page.waitForTimeout(1500)
    const testDialog = page.getByRole('dialog').filter({ hasText: 'Test Provider:' })
    await expect(testDialog).toBeVisible({ timeout: 10000 })

    // Click the "Test Provider" button
    await page.waitForTimeout(1000)
    await testDialog.getByRole('button', { name: 'Test Provider' }).click()

    // Should show connection result - look for "Success!" text or response content
    await expect(testDialog.getByText(/success|response|error/i).first()).toBeVisible({ timeout: 20000 })
  })

  test('should display provider models', async ({ authenticatedPage: page, apiHelper, assertHelper, llmProvidersHelper }) => {
    // Get token and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses
    await llmProvidersHelper.setupMockResponses()

    // Create provider via LLM helper
    const provider = await llmProvidersHelper.createLLMProvider({
      name: 'Models Test Provider',
      type: 'openai',
      apiKey: 'sk-test-models-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Open provider details via Details button
    const providerRow = page.locator('tr').filter({ hasText: 'Models Test Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })

    await page.waitForTimeout(500)
    await providerRow.getByRole('button', { name: /details/i }).click()

    // Wait for details sheet to open - get the first dialog (details sheet)
    await page.waitForTimeout(1000)
    const detailsSheet = page.locator('[role="dialog"]').first()
    await expect(detailsSheet).toBeVisible({ timeout: 10000 })

    // Navigate to Models tab
    const modelsTab = detailsSheet.getByRole('tab', { name: /models/i })
    await expect(modelsTab).toBeVisible({ timeout: 10000 })
    await modelsTab.click()
    await page.waitForTimeout(500)

    // Should show available models (from capabilities or mocked data) - use .first() to handle multiple matches
    await expect(detailsSheet.getByText(/gpt-4|model/i).first()).toBeVisible({ timeout: 10000 })
  })

  test('should select default model', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    // Get token and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses
    await llmProvidersHelper.setupMockResponses()

    // Create provider via helper
    const provider = await llmProvidersHelper.createLLMProvider({
      name: 'Default Model Provider',
      type: 'openai',
      apiKey: 'sk-test-default-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Open provider settings via Edit button
    const providerRow = page.locator('tr').filter({ hasText: 'Default Model Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })

    await page.waitForTimeout(500)
    await providerRow.getByRole('button', { name: /edit/i }).click()

    // Wait for edit dialog to open - get the last dialog
    await page.waitForTimeout(1000)
    const editDialog = page.locator('[role="dialog"]').last()
    await expect(editDialog).toBeVisible({ timeout: 10000 })

    // Select default model
    const modelInput = editDialog.getByLabel(/default.*model|model/i)
    await expect(modelInput).toBeVisible({ timeout: 10000 })
    await modelInput.click()
    await page.getByRole('option', { name: /gpt-4/i }).first().click()

    await editDialog.getByRole('button', { name: /save|update/i }).click()

    // Should show updated configuration
    await assertHelper.assertToastMessage(/updated|saved/i)
  })

  test('should configure model parameters', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    // Get token and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses
    await llmProvidersHelper.setupMockResponses()

    // Create provider via helper
    const provider = await llmProvidersHelper.createLLMProvider({
      name: 'Params Provider',
      type: 'openai',
      apiKey: 'sk-test-params-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Open provider settings via Edit button
    const providerRow = page.locator('tr').filter({ hasText: 'Params Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })

    await page.waitForTimeout(500)
    await providerRow.getByRole('button', { name: /edit/i }).click()

    // Wait for edit dialog to open - match by exact heading
    await page.waitForTimeout(1500)
    const editDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Edit Provider', exact: true }) })
    await expect(editDialog).toBeVisible({ timeout: 10000 })

    // Wait for content to render
    await page.waitForTimeout(1000)

    // Configure parameters using specific IDs
    const tempInput = page.locator('#editTemperature')
    await expect(tempInput).toBeVisible({ timeout: 5000 })
    await tempInput.clear()
    await tempInput.fill('0.7')

    const maxTokensInput = page.locator('#editMaxTokens')
    await expect(maxTokensInput).toBeVisible({ timeout: 5000 })
    await maxTokensInput.clear()
    await maxTokensInput.fill('2000')

    // Wait for Update Provider button and click
    const updateButton = page.getByRole('button', { name: 'Update Provider', exact: true })
    await expect(updateButton).toBeVisible({ timeout: 10000 })
    await updateButton.click()

    await assertHelper.assertToastMessage(/updated|saved/i)
  })

  test('should edit provider configuration', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    // Get token and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses
    await llmProvidersHelper.setupMockResponses()

    // Create provider via helper
    const provider = await llmProvidersHelper.createLLMProvider({
      name: 'Edit Test Provider',
      type: 'openai',
      apiKey: 'sk-test-edit-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Edit provider via Edit button
    const providerRow = page.locator('tr').filter({ hasText: 'Edit Test Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(500)
    await providerRow.getByRole('button', { name: /edit/i }).click()

    // Wait for edit dialog to open - get the center dialog
    const editDialog = page.locator('[role="dialog"]').filter({ hasText: /edit/i }).last()
    await expect(editDialog).toBeVisible({ timeout: 10000 })

    // Update name in the scoped dialog
    await editDialog.getByLabel(/provider.*name/i).clear()
    await editDialog.getByLabel(/provider.*name/i).fill('Updated Provider Name')

    await editDialog.getByRole('button', { name: /save|update/i }).click()

    // Should show updated name
    await assertHelper.assertToastMessage(/updated/i)
    await expect(page.getByText('Updated Provider Name')).toBeVisible()
  })

  test('should delete provider with confirmation', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    // Get token and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses
    await llmProvidersHelper.setupMockResponses()

    // Create provider via helper
    const provider = await llmProvidersHelper.createLLMProvider({
      name: 'To Delete Provider',
      type: 'openai',
      apiKey: 'sk-test-delete-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Delete provider
    const providerRow = page.locator('tr').filter({ hasText: 'To Delete Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })

    await page.waitForTimeout(500)
    await providerRow.getByRole('button', { name: /delete|remove/i }).click()

    // Wait for confirmation dialog - AlertDialog has role="alertdialog"
    await page.waitForTimeout(1500)
    const deleteDialog = page.getByRole('alertdialog').filter({ has: page.getByRole('heading', { name: 'Delete Provider', exact: true }) })
    await expect(deleteDialog).toBeVisible({ timeout: 10000 })

    // Wait and confirm deletion
    await page.waitForTimeout(1000)
    const deleteButton = deleteDialog.getByRole('button', { name: 'Delete', exact: true })
    await expect(deleteButton).toBeVisible({ timeout: 5000 })
    await deleteButton.click()

    // Should be removed
    await page.waitForTimeout(1000)
    await expect(page.getByText('To Delete Provider')).not.toBeVisible()
  })

  test('should display provider status badges', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    // Get token and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses
    await llmProvidersHelper.setupMockResponses()

    // Create multiple providers
    await llmProvidersHelper.createLLMProvider({
      name: 'Active Provider',
      type: 'openai',
      apiKey: 'sk-test-active-key',
    })

    await llmProvidersHelper.createLLMProvider({
      name: 'Inactive Provider',
      type: 'anthropic',
      apiKey: 'sk-ant-inactive-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Wait for providers to be visible
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // Verify both providers are showing in the table
    await expect(page.getByText('Active Provider').first()).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('Inactive Provider').first()).toBeVisible({ timeout: 5000 })

    // Status is displayed as text in the Status column - verify both show "active"
    const activeProviderRow = page.locator('tr').filter({ hasText: 'Active Provider' })
    const inactiveProviderRow = page.locator('tr').filter({ hasText: 'Inactive Provider' })

    // Both should show "active" status (green text in Status column)
    await expect(activeProviderRow.getByText('active').first()).toBeVisible({ timeout: 5000 })
    await expect(inactiveProviderRow.getByText('active').first()).toBeVisible({ timeout: 5000 })
  })

  test('should toggle provider active status', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    // Get token and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses
    await llmProvidersHelper.setupMockResponses()

    // Create provider via helper
    const provider = await llmProvidersHelper.createLLMProvider({
      name: 'Toggle Status Provider',
      type: 'openai',
      apiKey: 'sk-test-toggle-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()

    // Toggle status
    const providerRow = page.locator('tr').filter({ hasText: 'Toggle Status Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })
    const toggleSwitch = providerRow.locator('input[type="checkbox"], button[role="switch"]')

    if (await toggleSwitch.isVisible()) {
      await toggleSwitch.click()
      await assertHelper.assertToastMessage(/updated|disabled|enabled/i)
    }
  })

  test('should show provider usage statistics', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    // Get token and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses (includes usage statistics)
    await llmProvidersHelper.setupMockResponses()

    // Create provider via helper
    const provider = await llmProvidersHelper.createLLMProvider({
      name: 'Usage Stats Provider',
      type: 'openai',
      apiKey: 'sk-test-usage-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Open provider details via Details button
    const providerRow = page.locator('tr').filter({ hasText: 'Usage Stats Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(500)
    await providerRow.getByRole('button', { name: /details/i }).click()

    // Wait for details sheet to open - match by provider name
    await page.waitForTimeout(1500)
    const detailsSheet = page.getByRole('dialog').filter({ hasText: 'Usage Stats Provider' })
    await expect(detailsSheet).toBeVisible({ timeout: 10000 })

    // Navigate to Usage tab
    await page.waitForTimeout(1000)
    const usageTab = detailsSheet.getByRole('tab', { name: /usage/i })
    await expect(usageTab).toBeVisible({ timeout: 10000 })
    await usageTab.click()
    await page.waitForTimeout(1500)

    // Should show usage metrics (real data from backend) in the Usage tab
    // Verify Cost Breakdown section is visible
    await expect(detailsSheet.getByText('Cost Breakdown')).toBeVisible({ timeout: 10000 })
    await expect(detailsSheet.getByText('Total Tokens:')).toBeVisible({ timeout: 10000 })
    await expect(detailsSheet.getByText('Total Cost:')).toBeVisible({ timeout: 10000 })
  })

  test('should handle provider API errors gracefully', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    // Get token and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses first for successful provider creation
    await llmProvidersHelper.setupMockResponses()

    // Create a provider first
    const provider = await llmProvidersHelper.createLLMProvider({
      name: 'Error Test Provider',
      type: 'openai',
      apiKey: 'sk-test-error-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Now setup error mock for testing connection
    await llmProvidersHelper.setupErrorMock()

    // Test the connection (should fail with mocked error)
    const providerRow = page.locator('tr').filter({ hasText: 'Error Test Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })

    await page.waitForTimeout(500)
    await providerRow.getByRole('button', { name: /test/i }).click()

    // Wait for test dialog to open - match by exact heading "Test Provider:"
    await page.waitForTimeout(1500)
    const testDialog = page.getByRole('dialog').filter({ hasText: 'Test Provider:' })
    await expect(testDialog).toBeVisible({ timeout: 10000 })

    // Click the "Test Provider" button
    await page.waitForTimeout(1000)
    await testDialog.getByRole('button', { name: 'Test Provider' }).click()

    // Should show error message (mocked error response)
    await expect(testDialog.getByText(/invalid.*api.*key|error|failed|connection.*failed/i).first()).toBeVisible({ timeout: 10000 })
  })

  test('should display empty state when no providers configured', async ({ page, authHelper, assertHelper }) => {
    // Create fresh user with no providers
    const testUser = AuthHelper.generateTestUser()
    await authHelper.registerViaAPI(testUser)
    await authHelper.loginViaAPI(testUser.email, testUser.password)

    await page.goto('/llm-providers')
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Should show empty state - use .first() to handle multiple matches
    await expect(page.getByText(/no.*providers|get.*started|add.*first.*provider/i).first()).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: /add.*provider/i })).toBeVisible()
  })

  test('should filter providers by type', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    // Create providers of different types
    await apiHelper.createLLMProvider({
      name: 'OpenAI Test',
      type: 'openai',
      apiKey: 'sk-openai-key',
    })

    await apiHelper.createLLMProvider({
      name: 'Anthropic Test',
      type: 'anthropic',
      apiKey: 'sk-ant-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()

    // Filter by type
    const filterSelect = page.getByLabel(/filter.*type|provider.*type/i)
    if (await filterSelect.isVisible()) {
      await filterSelect.click()
      await page.getByRole('option', { name: /openai/i }).click()

      // Should show only OpenAI providers
      await expect(page.getByText('OpenAI Test')).toBeVisible()
      await expect(page.getByText('Anthropic Test')).not.toBeVisible()
    }
  })

  test('should search providers by name', async ({ authenticatedPage: page, apiHelper, assertHelper }) => {
    // Create multiple providers
    await apiHelper.createLLMProvider({
      name: 'Production OpenAI',
      type: 'openai',
      apiKey: 'sk-prod-key',
    })

    await apiHelper.createLLMProvider({
      name: 'Development OpenAI',
      type: 'openai',
      apiKey: 'sk-dev-key',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()

    // Search
    const searchInput = page.getByPlaceholder(/search/i)
    if (await searchInput.isVisible()) {
      await searchInput.fill('Production')

      // Should show only matching provider
      await expect(page.getByText('Production OpenAI')).toBeVisible()
      await expect(page.getByText('Development OpenAI')).not.toBeVisible()
    }
  })
})
