import { test, expect } from './setup/test-hooks'
import type { Page } from '@playwright/test'
import { AuthHelper } from './helpers/auth.helper'

/**
 * Inference providers: the APIs models are called through, with their keys.
 * /llm-providers is its own page, reached from the Models header. Adding one
 * is a page too (/llm-providers/new); testing and editing one happen in place
 * on the provider's own page (/llm-providers/:id). No dialogs.
 */

/** The row actions menu: a button whose only name is the sr-only "Actions". */
async function openRowActions(page: Page, providerName: string) {
  const row = page.getByRole('row').filter({ hasText: providerName })
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.getByRole('button', { name: 'Actions' }).click()
}

async function openAddPage(page: Page) {
  await page.getByRole('button', { name: 'Add inference provider' }).first().click()
  await expect(page).toHaveURL(/\/llm-providers\/new$/)
  await expect(page.getByRole('heading', { name: 'Add inference provider', level: 1 })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test.describe('Inference providers', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/llm-providers')
    await page.waitForLoadState('networkidle')
  })

  test('should display the inference providers page', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Inference providers', level: 1 })).toBeVisible()
    // It hangs off Models; the way back is a link, not a sidebar entry.
    await expect(page.getByRole('main').getByRole('link', { name: 'Models' }).first()).toHaveAttribute('href', '/models')
    // Empty or not, there is one way to add one.
    await expect(page.getByRole('button', { name: 'Add inference provider' }).first()).toBeVisible()
  })

  test('should open the add page and show provider types', async ({ authenticatedPage: page }) => {
    await openAddPage(page)

    // Provider Name, Provider Type and the API key, on the page itself.
    await expect(page.locator('#providerName')).toBeVisible()
    await expect(page.locator('#providerType')).toBeVisible()
    await expect(page.getByPlaceholder('Enter your API key')).toBeVisible()

    await page.locator('#providerType').click()
    await expect(page.getByRole('option', { name: 'OpenAI', exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Anthropic', exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Google Gemini', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    // Cancel goes back to the list.
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(/\/llm-providers$/)
  })

  test('should add OpenAI provider', async ({ authenticatedPage: page, assertHelper }) => {
    await openAddPage(page)

    await page.locator('#providerName').fill('OpenAI Production')
    await page.locator('#providerType').click()
    await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
    // Must be at least 8 characters.
    await page.getByPlaceholder('Enter your API key').fill('sk-test-key-1234567890')

    // Organization ID appears for OpenAI only.
    await expect(page.locator('#organizationId')).toBeVisible()
    await page.locator('#organizationId').fill('org-test123')

    await page.getByRole('button', { name: 'Add inference provider' }).click()

    await assertHelper.assertToastMessage(/Inference provider added/)
    // Saving lands on the new provider's own page.
    await expect(page).toHaveURL(/\/llm-providers\/[^/]+$/)
    await expect(page.getByRole('heading', { name: 'OpenAI Production', level: 1 })).toBeVisible()
  })

  test('should add Anthropic provider', async ({ authenticatedPage: page, assertHelper }) => {
    await openAddPage(page)

    await page.locator('#providerName').fill('Anthropic Production')
    await page.locator('#providerType').click()
    await page.getByRole('option', { name: 'Anthropic', exact: true }).click()
    await page.getByPlaceholder('Enter your API key').fill('sk-ant-test-key-1234567890')

    // Organization ID does NOT appear for Anthropic.
    await expect(page.locator('#organizationId')).not.toBeVisible()

    await page.getByRole('button', { name: 'Add inference provider' }).click()

    await assertHelper.assertToastMessage(/Inference provider added/)
    await expect(page.getByRole('heading', { name: 'Anthropic Production', level: 1 })).toBeVisible()
  })

  test('should validate API key is not too short', async ({ authenticatedPage: page }) => {
    await openAddPage(page)

    await page.locator('#providerName').fill('Test Provider')
    await page.locator('#providerType').click()
    await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
    await page.getByPlaceholder('Enter your API key').fill('short')

    await page.getByRole('button', { name: 'Add inference provider' }).click()

    await expect(page.getByText('API key is too short')).toBeVisible()
    await expect(page).toHaveURL(/\/llm-providers\/new$/)
  })

  test('should test provider connection', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
    const token = await page.evaluate(() => localStorage.getItem('token'))
    if (token) {
      llmProvidersHelper.setToken(token)
    }

    // Setup mock responses for the test endpoint
    await llmProvidersHelper.setupMockResponses()

    await llmProvidersHelper.createLLMProvider({
      name: 'Connection Test Provider',
      type: 'openai',
      apiKey: 'sk-test-connection-key-1234567890',
    })

    await page.reload()
    await assertHelper.waitForLoadingComplete()
    await page.waitForLoadState('networkidle')

    await openRowActions(page, 'Connection Test Provider')
    await page.getByRole('menuitem', { name: 'Test connection' }).click()

    // The test runs on the provider's own page and answers there, inline.
    await expect(page).toHaveURL(/\/llm-providers\/[^/?]+$/, { timeout: 10000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('provider-test-result')).toContainText(/Connection OK|Connection failed/, { timeout: 20000 })
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

    // Edit opens the provider's edit page (not a dialog).
    await openRowActions(page, 'Edit Test Provider')
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()

    await expect(page).toHaveURL(/\/llm-providers\/[^/?]+\/edit$/, { timeout: 10000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const editForm = page.getByRole('form', { name: 'Edit provider' })
    await expect(editForm).toBeVisible()

    const nameInput = editForm.locator('#editProviderName')
    await nameInput.clear()
    await nameInput.fill('Updated Provider Name')

    const tempInput = editForm.locator('#editTemperature')
    await tempInput.clear()
    await tempInput.fill('0.5')

    await editForm.getByRole('button', { name: 'Save changes' }).click()

    await assertHelper.assertToastMessage(/saved|updated/i)
    await expect(page.getByRole('heading', { name: 'Updated Provider Name' })).toBeVisible()
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

    await openRowActions(page, 'To Delete Provider')
    await page.getByRole('menuitem', { name: 'Delete' }).click()

    const deleteDialog = page.getByRole('alertdialog')
    await expect(deleteDialog).toBeVisible({ timeout: 10000 })
    await expect(deleteDialog.getByRole('heading', { name: 'Delete provider?' })).toBeVisible()

    await deleteDialog.getByRole('button', { name: 'Delete provider' }).click()

    await expect(page.getByText('To Delete Provider')).not.toBeVisible({ timeout: 10000 })
  })

  test('should open the provider page from View Details', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
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

    await openRowActions(page, 'Details Test Provider')
    await page.getByRole('menuitem', { name: 'View Details' }).click()

    // Details are the provider's own page, not a sheet.
    await expect(page).toHaveURL(/\/llm-providers\/[^/]+$/)
    await expect(page.getByRole('heading', { name: 'Details Test Provider', level: 1 })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Inference providers' }).first()).toHaveAttribute('href', '/llm-providers')
    await expect(page.getByRole('tab', { name: /overview/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /models/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /usage/i })).toBeVisible()
  })

  test('should display provider usage stats on its page', async ({ authenticatedPage: page, assertHelper, llmProvidersHelper }) => {
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

    // A row click opens the provider's page.
    await page.getByRole('row').filter({ hasText: 'Usage Stats Provider' }).getByRole('cell').first().click()
    await expect(page).toHaveURL(/\/llm-providers\/[^/]+$/)

    const usageTab = page.getByRole('tab', { name: /usage/i })
    await expect(usageTab).toBeVisible()
    await usageTab.click()

    await expect(page.getByText('Cost Breakdown')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Total Tokens:')).toBeVisible()
    await expect(page.getByRole('tabpanel').getByText('Total Cost:')).toBeVisible()
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

    await expect(page.getByText('Searchable Alpha')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Searchable Beta')).toBeVisible({ timeout: 10000 })

    await page.getByPlaceholder('Search providers...').fill('Alpha')

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

    await expect(page.getByRole('heading', { name: 'No inference providers yet' })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('button', { name: 'Add inference provider' })).toHaveCount(1)
  })

  test('?new=1 opens the add page', async ({ authenticatedPage: page }) => {
    await page.goto('/llm-providers?new=1')
    await expect(page).toHaveURL(/\/llm-providers\/new$/)
    await expect(page.getByRole('heading', { name: 'Add inference provider', level: 1 })).toBeVisible()
  })
})
