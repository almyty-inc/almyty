import { expect, type Page } from '@playwright/test'
import { test as hooked } from './setup/test-hooks'

/**
 * Settings > Connections: the connector gallery, the connect sheet (from
 * the tab and from the LLM provider dialog), grants on a connection, and
 * the EE governance section in its locked and unlocked states.
 *
 * Live connects need a real key: set E2E_CONNECT_API_KEY (and optionally
 * E2E_CONNECT_CONNECTOR_KEY, default openai) to run the two tests that
 * create a connection; they are skipped otherwise.
 */
const CONNECTOR_KEY = process.env.E2E_CONNECT_CONNECTOR_KEY || 'openai'
const API_KEY = process.env.E2E_CONNECT_API_KEY

/** Gallery order, as in frontend/src/types/connections.ts. */
const KIND_LABELS = ['Inference', 'Deployment', 'Memory', 'MCP servers', 'Tool sources', 'Channels', 'Clouds', 'Registries']

async function openConnections(page: Page) {
  await page.goto('/settings/connections')
  await page.waitForLoadState('networkidle')
  await expect(page.getByLabel('Search connections')).toBeVisible()
}

/** Connect the fixture connector with an API key and return its card. */
async function connectWithApiKey(page: Page) {
  const card = page.getByTestId(`connector-card-${CONNECTOR_KEY}`)
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: /^Connect / }).click()

  const sheet = page.getByRole('dialog').filter({ hasText: /^Connect / })
  await expect(sheet).toBeVisible()
  const form = sheet.getByTestId('connect-form')
  await expect(form).toBeVisible()
  await form.locator('input[type="password"]').first().fill(API_KEY!)
  await form.getByRole('button', { name: 'Connect' }).click()

  const toast = page.locator('li[role="status"]').filter({ hasText: /Connected|Secret rotated/ })
  await expect(toast).toBeVisible({ timeout: 30000 })
  await expect(card.getByTestId('connector-connections').locator('li')).toHaveCount(1, { timeout: 15000 })
  return card
}

hooked.describe('Connections - gallery', () => {
  hooked.beforeEach(async ({ authenticatedPage: page }) => {
    await openConnections(page)
  })

  hooked('renders the gallery grouped by kind in gallery order', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: 'Personal connections' })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Allow user-scoped connections' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add custom connector' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()

    // Every section is one connector kind; the sections follow the gallery order.
    const sections = page.getByRole('region').filter({ has: page.getByRole('heading', { level: 2 }) })
    const names: string[] = []
    for (const section of await sections.all()) {
      const label = await section.getAttribute('aria-label')
      if (label && KIND_LABELS.includes(label)) names.push(label)
    }
    expect(names.length).toBeGreaterThan(0)
    const positions = names.map((n) => KIND_LABELS.indexOf(n))
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)

    // Each connector card carries a connect button named after the connector.
    const firstCard = page.locator('[data-testid^="connector-card-"]').first()
    await expect(firstCard).toBeVisible()
    await expect(firstCard.getByRole('button', { name: /^Connect / })).toBeVisible()
  })

  hooked('filters the gallery by search', async ({ authenticatedPage: page }) => {
    const search = page.getByLabel('Search connections')
    await search.fill('zzzz-no-such-connector')
    await expect(page.getByText('No connector matches')).toBeVisible()
    await search.fill('')
    await expect(page.locator('[data-testid^="connector-card-"]').first()).toBeVisible()
  })

  hooked('opens the connect sheet with a connector picker', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    const sheet = page.getByRole('dialog').filter({ hasText: 'Connect an account' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByLabel('Search connectors')).toBeVisible()
    await expect(sheet.locator('[data-testid^="connector-option-"]').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })

  hooked('connects an api_key connector against the fixture', async ({ authenticatedPage: page }) => {
    hooked.skip(!API_KEY, 'E2E_CONNECT_API_KEY not set')
    const card = await connectWithApiKey(page)
    await expect(card.getByTestId('connection-health')).toBeVisible()
  })

  hooked('grants editor adds and revokes a grant', async ({ authenticatedPage: page, assertHelper }) => {
    hooked.skip(!API_KEY, 'E2E_CONNECT_API_KEY not set')
    const card = await connectWithApiKey(page)
    await card.getByTestId('connector-connections').getByRole('button', { name: /^Open / }).first().click()

    const detail = page.getByRole('dialog').filter({ hasText: 'Who can use it' })
    await expect(detail).toBeVisible()
    const form = detail.getByTestId('grant-form')
    await form.getByLabel('Principal type').selectOption('role')
    await form.getByLabel('Role', { exact: true }).selectOption('owner')
    await form.getByRole('button', { name: 'Add grant' }).click()
    await assertHelper.assertToastMessage(/Access granted/)
    const grants = detail.getByTestId('grants-list')
    await expect(grants).toContainText('Owners')

    await detail.getByRole('button', { name: 'Revoke Owners' }).click()
    await expect(page.getByRole('alertdialog')).toContainText('Revoke access?')
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click()
    await assertHelper.assertToastMessage(/Access revoked/)
    await expect(detail.getByText('No grants yet')).toBeVisible()
  })
})

hooked.describe('Connections - from the LLM provider dialog', () => {
  hooked('the connect sheet opens from Add Provider', async ({ authenticatedPage: page }) => {
    await page.goto('/llm-providers')
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /add.*provider/i }).click()

    const dialog = page.getByRole('dialog').filter({ hasText: 'Add Provider' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Connect an account' }).click()

    const sheet = page.getByRole('dialog').filter({ hasText: /Connect an account|^Connect / })
    await expect(sheet.last()).toBeVisible()
    // Only inference connectors are offered; the picker (or the single
    // connector's form) is on screen.
    const picker = sheet.last().locator('[data-testid^="connector-option-"], [data-testid="connect-form"]')
    await expect(picker.first()).toBeVisible()
  })
})

hooked.describe('Connections - governance', () => {
  hooked.beforeEach(async ({ authenticatedPage: page }) => {
    await openConnections(page)
  })

  hooked('shows the governance section locked or unlocked to match the entitlement', async ({ authenticatedPage: page }) => {
    const section = page.getByRole('region', { name: 'Governance' })
    await section.scrollIntoViewIfNeeded()
    await expect(section).toBeVisible()

    // Either the locked card or the sub-navigation renders once entitlements land.
    const locked = section.getByTestId('governance-locked')
    const unlocked = section.getByTestId('governance-unlocked')
    await expect(locked.or(unlocked)).toBeVisible({ timeout: 15000 })

    // When the API is reachable from the app origin, the UI state must agree with it.
    let entitled: boolean | null = null
    try {
      const res = await page.request.get('/licensing/entitlements')
      if (res.ok()) {
        const body = await res.json()
        const list = body?.data?.entitlements ?? body?.entitlements
        if (Array.isArray(list)) entitled = list.includes('connections_governance')
      }
    } catch {
      entitled = null
    }

    if (await unlocked.isVisible()) {
      if (entitled !== null) expect(entitled).toBe(true)
      await expect(section.getByRole('tab', { name: 'Policies' })).toHaveAttribute('aria-selected', 'true')
      await expect(section.getByTestId('policies-panel')).toBeVisible()

      await section.getByRole('tab', { name: 'Review' }).click()
      await expect(section.getByTestId('review-panel')).toBeVisible()
      await expect(section.getByLabel('Environment')).toHaveValue('production')

      await section.getByRole('tab', { name: 'Expiry and rotation' }).click()
      await expect(section.getByTestId('expiry-panel')).toBeVisible()
      await expect(section.getByRole('button', { name: 'Rotate due now' })).toBeVisible()
      await expect(section.getByRole('button', { name: 'Export JSON' })).toBeVisible()
      await expect(section.getByRole('button', { name: 'Export CSV' })).toBeVisible()

      await section.getByRole('tab', { name: 'Policies' }).click()
      await section.getByRole('button', { name: 'Add policy' }).first().click()
      const dialog = page.getByTestId('policy-dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Kind')).toHaveValue('connector_allowlist')
      await dialog.getByLabel('Kind').selectOption('expiry_rule')
      await expect(dialog.getByLabel('Maximum age (days)')).toHaveValue('90')
      await expect(dialog.getByLabel('Warn ahead (days)')).toHaveValue('7')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toBeHidden()
    } else {
      if (entitled !== null) expect(entitled).toBe(false)
      await expect(locked).toContainText('Connections governance')
      await expect(locked).toContainText(/Upgrade to unlock it for your organization/)
      await expect(locked.getByRole('link', { name: /Upgrade to|View plans/ })).toHaveAttribute('href', '/settings/billing')
      await expect(section.getByRole('tab', { name: 'Policies' })).toHaveCount(0)
    }
  })
})
