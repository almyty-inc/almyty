import { expect, type Page } from '@playwright/test'
import { test as hooked } from './setup/test-hooks'

/**
 * Credentials: the list (a table), Add credential (tile, key, checked,
 * listed), a credential's page, the admins' Advanced tab with who can use
 * each credential and the EE governance section, the pick-or-create
 * control where a key is used, and the older Connections addresses, which
 * only redirect.
 *
 * A catalog add needs a real key: set E2E_CONNECT_API_KEY and
 * E2E_CONNECT_CONNECTOR_KEY (a service that is not a model provider;
 * those are added on Models) to run it; it is skipped otherwise. "Other
 * service" needs no real key, so the rest always run.
 */
const CONNECTOR_KEY = process.env.E2E_CONNECT_CONNECTOR_KEY || 'other'
const API_KEY = process.env.E2E_CONNECT_API_KEY

async function openCredentials(page: Page) {
  await page.goto('/credentials')
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: 'Credentials', level: 1 })).toBeVisible()
}

/** Save a key as "Other service" and return its name. */
async function addOtherKey(page: Page): Promise<string> {
  const name = `E2E key ${Date.now()}`
  await page.goto('/credentials/new?service=other')
  const form = page.getByRole('form', { name: 'Add a key' })
  await expect(form).toBeVisible()
  await form.getByLabel('Name').fill(name)
  await form.locator('input[type="password"]').first().fill('e2e-secret-value')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('connect-success')).toContainText(`${name} is saved.`, { timeout: 30000 })
  return name
}

hooked.describe('Credentials - list and add', () => {
  hooked('Add credential is a tile grid with search', async ({ authenticatedPage: page }) => {
    await openCredentials(page)
    await page.getByRole('link', { name: 'Add credential' }).first().click()
    await expect(page).toHaveURL(/\/credentials\/new$/)
    await expect(page.getByRole('heading', { name: 'Add credential', level: 1 })).toBeVisible()
    await expect(page.locator('[data-testid^="service-tile-"]').first()).toBeVisible()
    await page.getByLabel('Search services').fill('zzzz-no-such-service')
    await expect(page.getByRole('button', { name: 'Save its key as another service' })).toBeVisible()
  })

  hooked('saves another key by name and lists it in the table', async ({ authenticatedPage: page }) => {
    const name = await addOtherKey(page)
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page).toHaveURL(/\/credentials$/)
    const row = page.getByTestId('credentials-table').getByRole('row').filter({ hasText: name })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('credential-status')).toHaveText('Saved')
  })

  hooked('adds a catalog service with a real key', async ({ authenticatedPage: page }) => {
    hooked.skip(!API_KEY || CONNECTOR_KEY === 'other', 'E2E_CONNECT_API_KEY / E2E_CONNECT_CONNECTOR_KEY not set')
    await page.goto(`/credentials/new?service=${CONNECTOR_KEY}`)
    const form = page.getByTestId('connect-form')
    await form.locator('input[type="password"]').first().fill(API_KEY!)
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('connect-success').getByTestId('connection-status')).toHaveText('Works', { timeout: 30000 })
  })

  hooked('a credential has its own page with check again and delete', async ({ authenticatedPage: page }) => {
    const name = await addOtherKey(page)
    await page.getByRole('button', { name: 'Open credential' }).click()
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible()
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByTestId('credential-check-result')).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: 'Delete credential' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
    await expect(page).toHaveURL(/\/credentials$/)
  })
})

hooked.describe('Credentials - advanced', () => {
  hooked('who can use it: adds and revokes a grant', async ({ authenticatedPage: page, assertHelper }) => {
    await addOtherKey(page)
    await page.getByRole('button', { name: 'Open credential' }).click()
    await page.getByRole('link', { name: 'Change' }).click()
    await expect(page).toHaveURL(/\/credentials\/advanced\?credential=/)
    const form = page.getByTestId('grant-form')
    await form.getByLabel('Principal type').selectOption('role')
    await form.getByLabel('Role', { exact: true }).selectOption('owner')
    await form.getByRole('button', { name: 'Add grant' }).click()
    await assertHelper.assertToastMessage(/Access granted/)
    const grants = page.getByTestId('grants-list')
    await expect(grants).toContainText('Owners')
    await page.getByRole('button', { name: 'Revoke Owners' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click()
    await assertHelper.assertToastMessage(/Access revoked/)
  })

  hooked('shows the governance section locked or unlocked to match the entitlement', async ({ authenticatedPage: page }) => {
    await page.goto('/credentials/advanced')
    const section = page.getByRole('region', { name: 'Governance' })
    await section.scrollIntoViewIfNeeded()
    await expect(section).toBeVisible()
    const locked = section.getByTestId('governance-locked')
    const unlocked = section.getByTestId('governance-unlocked')
    await expect(locked.or(unlocked)).toBeVisible({ timeout: 15000 })
    if (await unlocked.isVisible()) {
      await section.getByRole('link', { name: 'Add policy' }).first().click()
      await expect(page).toHaveURL(/\/credentials\/policies\/new/)
      await expect(page.getByTestId('policy-form')).toBeVisible()
    } else {
      await expect(locked).toContainText('Credentials governance')
    }
  })
})

hooked.describe('Credentials - where a key is used', () => {
  hooked('Add MCP server picks the token from Credentials or creates it inline', async ({ authenticatedPage: page }) => {
    await page.goto('/tools/mcp-servers/new')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Create one here' }).click()
    const flow = page.getByTestId('connect-flow')
    await expect(flow).toBeVisible()
    await expect(flow.getByRole('button', { name: 'Save' })).toBeVisible()
    await flow.getByRole('button', { name: 'Cancel' }).click()
    await expect(flow).toHaveCount(0)
  })

  hooked('the add flow opens inline from a model provider tile', async ({ authenticatedPage: page }) => {
    await page.goto('/models/connect?type=openai')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('main').getByRole('button', { name: 'Connect an account' }).click()
    const flow = page.getByTestId('connect-flow')
    await expect(flow).toBeVisible()
    await expect(flow.locator('[data-testid^="service-tile-"], [data-testid="connect-form"]').first()).toBeVisible()
  })
})

hooked.describe('Credentials - the older addresses', () => {
  hooked('Connections lands on Credentials', async ({ authenticatedPage: page }) => {
    await page.goto('/connections')
    await expect(page).toHaveURL(/\/credentials$/)
    await expect(page.getByRole('heading', { name: 'Credentials', level: 1 })).toBeVisible()
  })

  hooked('connecting a service lands on Add credential', async ({ authenticatedPage: page }) => {
    await page.goto('/connections/connect?service=other')
    await expect(page).toHaveURL(/\/credentials\/new\?service=other$/)
    await expect(page.getByRole('heading', { name: 'Add credential', level: 1 })).toBeVisible()
  })

  hooked('access keys land on the gateways they unlock', async ({ authenticatedPage: page }) => {
    await page.goto('/credentials/access-keys/new')
    await expect(page).toHaveURL(/\/gateways$/)
  })
})
