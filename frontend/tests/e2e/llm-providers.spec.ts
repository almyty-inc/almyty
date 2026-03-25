import { test, expect } from './setup/test-hooks'
import { AuthHelper } from './helpers/auth.helper'

test.describe('LLM Providers - Configuration', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/llm-providers')
    await page.waitForLoadState('networkidle')
  })

  test('should display LLM providers page', async ({ authenticatedPage: page }) => {
    // Page heading is "AI Models"
    await expect(page.getByRole('heading', { name: 'AI Models', level: 1 })).toBeVisible()

    // Empty state shows "Add First Provider" button, non-empty shows "Add Provider"
    const addButton = page.getByRole('button', { name: /add.*provider/i })
    await expect(addButton).toBeVisible()
  })

  test('should open add provider dialog and show provider types', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /add.*provider/i }).click()

    // Dialog should open with title "Add Provider"
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Add Provider' })).toBeVisible()

    // Should have Provider Name, Provider Type, and API Key fields
    await expect(dialog.locator('#providerName')).toBeVisible()
    await expect(dialog.locator('#providerType')).toBeVisible()
    await expect(dialog.locator('#apiKey')).toBeVisible()

    // Open the provider type dropdown and verify some options
    await dialog.locator('#providerType').click()
    await expect(page.getByRole('option', { name: 'OpenAI' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Anthropic' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Google Gemini' })).toBeVisible()
  })

  test('should add OpenAI provider', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('button', { name: /add.*provider/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Fill provider name
    await dialog.locator('#providerName').fill('OpenAI Production')

    // Select provider type
    await dialog.locator('#providerType').click()
    await page.getByRole('option', { name: 'OpenAI' }).click()

    // Fill API key (must be >= 8 chars per validation)
    await dialog.locator('#apiKey').fill('sk-test-key-1234567890')

    // Organization ID field should appear for OpenAI
    await expect(dialog.locator('#organizationId')).toBeVisible()
    await dialog.locator('#organizationId').fill('org-test123')

    // Submit
    await dialog.getByRole('button', { name: 'Add Provider' }).click()

    // Should show success toast
    await assertHelper.assertToastMessage(/added|connected|success/i)
    await expect(page.getByText('OpenAI Production')).toBeVisible()
  })

  test('should add Anthropic provider', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('button', { name: /add.*provider/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Fill provider name
    await dialog.locator('#providerName').fill('Anthropic Production')

    // Select Anthropic
    await dialog.locator('#providerType').click()
    await page.getByRole('option', { name: 'Anthropic' }).click()

    // Fill API key
    await dialog.locator('#apiKey').fill('sk-ant-test-key-1234567890')

    // Organization ID should NOT appear for Anthropic
    await expect(dialog.locator('#organizationId')).not.toBeVisible()

    // Submit
    await dialog.getByRole('button', { name: 'Add Provider' }).click()

    await assertHelper.assertToastMessage(/added|connected|success/i)
    await expect(page.getByText('Anthropic Production')).toBeVisible()
  })

  test('should validate API key is not too short', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /add.*provider/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Fill with short API key (< 8 chars)
    await dialog.locator('#providerName').fill('Test Provider')
    await dialog.locator('#providerType').click()
    await page.getByRole('option', { name: 'OpenAI' }).click()
    await dialog.locator('#apiKey').fill('short')

    await dialog.getByRole('button', { name: 'Add Provider' }).click()

    // Should show validation error about API key being too short
    await expect(dialog.getByText(/too short/i)).toBeVisible()
  })

  test('should test provider connection', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    // Get token from auth and set it on llmProvidersHelper
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses for the test endpoint
    await llmProvidersHelper.setupMockResponses()

    // Create provider via API helper
    await llmProvidersHelper.createLLMProvider({
      name: 'Connection Test Provider',
      type: 'openai',
      apiKey: 'sk-test-connection-key-1234567890',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Find provider row and click Test button
    const providerRow = page.locator('tr').filter({ hasText: 'Connection Test Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })
    await providerRow.getByRole('button', { name: /test/i }).click()

    // Test dialog should open with title "Test Provider: Connection Test Provider"
    const testDialog = page.getByRole('dialog')
    await expect(testDialog).toBeVisible({ timeout: 10000 })
    await expect(testDialog.getByText('Test Provider: Connection Test Provider')).toBeVisible()

    // Click the "Test Provider" button inside the dialog
    await testDialog.getByRole('button', { name: 'Test Provider' }).click()

    // Should show result (success or error)
    await expect(testDialog.getByText(/success|error|response/i).first()).toBeVisible({ timeout: 20000 })
  })

  test('should edit provider configuration', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    await llmProvidersHelper.createLLMProvider({
      name: 'Edit Test Provider',
      type: 'openai',
      apiKey: 'sk-test-edit-key-12345678',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Click Edit on the provider row
    const providerRow = page.locator('tr').filter({ hasText: 'Edit Test Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })
    await providerRow.getByRole('button', { name: /edit/i }).click()

    // Edit dialog should open
    const editDialog = page.getByRole('dialog')
    await expect(editDialog).toBeVisible({ timeout: 10000 })
    await expect(editDialog.getByRole('heading', { name: 'Edit Provider' })).toBeVisible()

    // Update the provider name
    const nameInput = editDialog.locator('#editProviderName')
    await expect(nameInput).toBeVisible()
    await nameInput.clear()
    await nameInput.fill('Updated Provider Name')

    // Update temperature
    const tempInput = editDialog.locator('#editTemperature')
    await expect(tempInput).toBeVisible()
    await tempInput.clear()
    await tempInput.fill('0.5')

    // Submit
    await editDialog.getByRole('button', { name: 'Update Provider' }).click()

    await assertHelper.assertToastMessage(/updated|saved/i)
    await expect(page.getByText('Updated Provider Name')).toBeVisible()
  })

  test('should delete provider with confirmation', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    await llmProvidersHelper.createLLMProvider({
      name: 'To Delete Provider',
      type: 'openai',
      apiKey: 'sk-test-delete-key-12345678',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Click Delete on the provider row
    const providerRow = page.locator('tr').filter({ hasText: 'To Delete Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })
    await providerRow.getByRole('button', { name: /delete/i }).click()

    // Confirmation AlertDialog should open
    const deleteDialog = page.getByRole('alertdialog')
    await expect(deleteDialog).toBeVisible({ timeout: 10000 })
    await expect(deleteDialog.getByRole('heading', { name: 'Delete Provider' })).toBeVisible()

    // Confirm deletion
    await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click()

    // Provider should be removed from the page
    await expect(page.getByText('To Delete Provider')).not.toBeVisible({ timeout: 10000 })
  })

  test('should view provider details sheet', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    await llmProvidersHelper.createLLMProvider({
      name: 'Details Test Provider',
      type: 'openai',
      apiKey: 'sk-test-details-key-12345678',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Click Details button
    const providerRow = page.locator('tr').filter({ hasText: 'Details Test Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })
    await providerRow.getByRole('button', { name: /details/i }).click()

    // Details sheet should open with provider name
    const detailsSheet = page.locator('[role="dialog"]').first()
    await expect(detailsSheet).toBeVisible({ timeout: 10000 })
    await expect(detailsSheet.getByText('Details Test Provider')).toBeVisible()

    // Should have tabs: Overview, Chat, Models, Usage, Config, Monitoring
    await expect(detailsSheet.getByRole('tab', { name: /overview/i })).toBeVisible()
    await expect(detailsSheet.getByRole('tab', { name: /models/i })).toBeVisible()
    await expect(detailsSheet.getByRole('tab', { name: /usage/i })).toBeVisible()
  })

  test('should display provider usage stats in details', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    await llmProvidersHelper.createLLMProvider({
      name: 'Usage Stats Provider',
      type: 'openai',
      apiKey: 'sk-test-usage-key-12345678',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Open details sheet
    const providerRow = page.locator('tr').filter({ hasText: 'Usage Stats Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })
    await providerRow.getByRole('button', { name: /details/i }).click()

    const detailsSheet = page.locator('[role="dialog"]').first()
    await expect(detailsSheet).toBeVisible({ timeout: 10000 })

    // Navigate to Usage tab
    const usageTab = detailsSheet.getByRole('tab', { name: /usage/i })
    await expect(usageTab).toBeVisible()
    await usageTab.click()

    // Should show Cost Breakdown section
    await expect(detailsSheet.getByText('Cost Breakdown')).toBeVisible({ timeout: 10000 })
    await expect(detailsSheet.getByText('Total Tokens:')).toBeVisible()
    await expect(detailsSheet.getByText('Total Cost:')).toBeVisible()
  })

  test('should display provider status in table', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    await llmProvidersHelper.createLLMProvider({
      name: 'Status Badge Provider',
      type: 'openai',
      apiKey: 'sk-test-status-key-12345678',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Provider row should be visible with status badge
    const providerRow = page.locator('tr').filter({ hasText: 'Status Badge Provider' })
    await expect(providerRow).toBeVisible({ timeout: 10000 })
    await expect(providerRow.getByText('active').first()).toBeVisible({ timeout: 5000 })
  })

  test('should search providers by name', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    await llmProvidersHelper.createLLMProvider({
      name: 'Searchable Alpha',
      type: 'openai',
      apiKey: 'sk-test-search1-12345678',
    })
    await llmProvidersHelper.createLLMProvider({
      name: 'Searchable Beta',
      type: 'anthropic',
      apiKey: 'sk-ant-search2-12345678',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Both should be visible initially
    await expect(page.getByText('Searchable Alpha')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Searchable Beta')).toBeVisible({ timeout: 10000 })

    // Search for Alpha
    const searchInput = page.getByPlaceholder(/search/i)
    await searchInput.fill('Alpha')

    // Only Alpha should be visible
    await expect(page.getByText('Searchable Alpha')).toBeVisible()
    await expect(page.getByText('Searchable Beta')).not.toBeVisible()
  })

  test('should display empty state when no providers configured', async ({ page, authHelper, assertHelper }) => {
    // Create fresh user with no providers
    const testUser = AuthHelper.generateTestUser()
    await authHelper.registerViaAPI(testUser)
    await authHelper.loginViaAPI(testUser.email, testUser.password)

    await page.goto('/llm-providers')
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    // Should show empty state message and "Add First Provider" button
    await expect(page.getByText(/no ai models configured/i)).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: /add first provider/i })).toBeVisible()
  })
})
