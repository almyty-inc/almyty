import { expect, type Page } from '@playwright/test'
import { test as hooked } from './setup/test-hooks'

/**
 * Connections: the list, connecting a service (tile, key, checked,
 * listed), a connection's page, the admins' Advanced tab with grants and
 * the EE governance section, and the inline flow from connecting a
 * provider.
 *
 * A catalog connect needs a real key: set E2E_CONNECT_API_KEY and
 * E2E_CONNECT_CONNECTOR_KEY (a connector that is not an AI model provider;
 * those connect on Models) to run it; it is skipped otherwise. "Other
 * service" needs no real key, so the rest always run.
 */
const CONNECTOR_KEY = process.env.E2E_CONNECT_CONNECTOR_KEY || 'other'
const API_KEY = process.env.E2E_CONNECT_API_KEY

async function openConnections(page: Page) {
  await page.goto('/connections')
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: 'Connections', level: 1 })).toBeVisible()
}

/** Save a key as "Other service" and return its name. */
async function connectOtherService(page: Page): Promise<string> {
  const name = `E2E key ${Date.now()}`
  await page.goto('/connections/connect?service=other')
  const form = page.getByRole('form', { name: 'Connect Other service' })
  await expect(form).toBeVisible()
  await form.getByLabel('Name').fill(name)
  await form.locator('input[type="password"]').first().fill('e2e-secret-value')
  await form.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByTestId('connect-success')).toContainText(`${name} is connected.`, { timeout: 30000 })
  return name
}

hooked.describe('Connections - list and connect', () => {
  hooked('connect a service is a tile grid with search', async ({ authenticatedPage: page }) => {
    await openConnections(page)
    await page.getByRole('link', { name: 'Connect a service' }).first().click()
    await expect(page).toHaveURL(/\/connections\/connect$/)
    await expect(page.getByRole('heading', { name: 'Connect a service', level: 1 })).toBeVisible()
    await expect(page.locator('[data-testid^="service-tile-"]').first()).toBeVisible()
    await page.getByLabel('Search services').fill('zzzz-no-such-service')
    await expect(page.getByRole('button', { name: 'Save its key as another service' })).toBeVisible()
  })

  hooked('saves another service by name and lists it', async ({ authenticatedPage: page }) => {
    const name = await connectOtherService(page)
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page).toHaveURL(/\/connections$/)
    const card = page.locator('[data-testid^="connection-card-"]').filter({ hasText: name })
    await expect(card).toBeVisible()
    await expect(card.getByTestId('connection-status')).toHaveText('Saved')
  })

  hooked('connects a catalog service with a real key', async ({ authenticatedPage: page }) => {
    hooked.skip(!API_KEY || CONNECTOR_KEY === 'other', 'E2E_CONNECT_API_KEY / E2E_CONNECT_CONNECTOR_KEY not set')
    await page.goto(`/connections/connect?service=${CONNECTOR_KEY}`)
    const form = page.getByTestId('connect-form')
    await form.locator('input[type="password"]').first().fill(API_KEY!)
    await form.getByRole('button', { name: 'Connect' }).click()
    await expect(page.getByTestId('connect-success').getByTestId('connection-status')).toHaveText('Works', { timeout: 30000 })
  })

  hooked('a connection has its own page with check again and disconnect', async ({ authenticatedPage: page }) => {
    const name = await connectOtherService(page)
    await page.getByRole('button', { name: 'Open connection' }).click()
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByTestId('connection-check-result')).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: 'Disconnect' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click()
    await expect(page).toHaveURL(/\/connections$/)
  })
})

hooked.describe('Connections - advanced', () => {
  hooked('grants editor adds and revokes a grant', async ({ authenticatedPage: page, assertHelper }) => {
    await connectOtherService(page)
    await page.getByRole('button', { name: 'Open connection' }).click()
    await page.getByRole('link', { name: 'Change' }).click()
    await expect(page).toHaveURL(/\/connections\/advanced\?connection=/)
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
    await page.goto('/connections/advanced')
    const section = page.getByRole('region', { name: 'Governance' })
    await section.scrollIntoViewIfNeeded()
    await expect(section).toBeVisible()
    const locked = section.getByTestId('governance-locked')
    const unlocked = section.getByTestId('governance-unlocked')
    await expect(locked.or(unlocked)).toBeVisible({ timeout: 15000 })
    if (await unlocked.isVisible()) {
      await section.getByRole('link', { name: 'Add policy' }).first().click()
      await expect(page).toHaveURL(/\/connections\/policies\/new/)
      await expect(page.getByTestId('policy-form')).toBeVisible()
    } else {
      await expect(locked).toContainText('Connections governance')
    }
  })
})

hooked.describe('Connections - from connecting a provider', () => {
  hooked('the connect flow opens inline from a provider tile', async ({ authenticatedPage: page }) => {
    await page.goto('/models/connect?type=openai')
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('heading', { name: 'Connect a provider', level: 1 })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('main').getByRole('button', { name: 'Connect an account' }).click()
    const flow = page.getByTestId('connect-flow')
    await expect(flow).toBeVisible()
    await expect(flow.locator('[data-testid^="service-tile-"], [data-testid="connect-form"]').first()).toBeVisible()
  })
})
