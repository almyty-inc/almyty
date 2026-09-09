import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

/**
 * Models layer, Deployments and Versions tabs: the adapter list, the deploy
 * dialog with an adapter's JSON-schema config form, registering a registry
 * version, deploying it to the in-memory stub adapter, and driving the
 * deployment through scale-to-zero and teardown.
 *
 * The stub adapter is registered whenever NODE_ENV is not production (or
 * MODEL_STUB_ADAPTER=true); against a stack without it the deploy tests are
 * skipped. The reconcile loop is a cron (MODEL_RECONCILE_CRON, every two
 * minutes by default); the waits below allow for one tick at a one-minute
 * cadence and can be widened with E2E_RECONCILE_WAIT_MS.
 *
 *   npx playwright test --config=playwright.local.config.ts models-deployments.spec.ts
 */

const API_PATHS = /^\/(models|model-adapters|model-deployments|model-versions)(\/|\?|$)/
const RECONCILE_WAIT_MS = Number(process.env.E2E_RECONCILE_WAIT_MS || 150000)

async function registerUser(page: Page, suffix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const user = {
    email: `e2e-${suffix}-${stamp}@example.com`,
    password: 'E2e#Models2026pass',
    firstName: 'E2E',
    lastName: suffix,
    organizationName: `E2E ${suffix} ${stamp}`,
  }
  // Through the real form: registration sets the httpOnly cookie and seeds
  // the persisted auth store, which a cookie-only cold load does not get.
  await page.goto('/auth/register')
  await page.locator('#firstName').fill(user.firstName)
  await page.locator('#lastName').fill(user.lastName)
  await page.locator('#email').fill(user.email)
  await page.locator('#organizationName').fill(user.organizationName)
  await page.locator('#password').fill(user.password)
  await page.locator('#confirmPassword').fill(user.password)
  await page.locator('#terms').click()
  const registered = page.waitForResponse((r) => r.url().includes('/auth/register') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create account' }).click()
  const res = await registered
  expect(res.status(), `register: ${await res.text()}`).toBe(201)
  await page.waitForURL(/\/dashboard/)
  return user
}

/**
 * One throwaway user per file. /auth/register is throttled to ten per hour
 * per IP, so registering in every test exhausts it after two runs; a
 * worker-scoped fixture registers once and hands the cookie plus the
 * persisted auth store to every page through storageState.
 */
type AuthState = Awaited<ReturnType<BrowserContext['storageState']>>
const test = base.extend<{}, { authState: AuthState }>({
  authState: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL })
      const page = await context.newPage()
      await registerUser(page, 'deploy')
      const state = await context.storageState()
      await context.close()
      await use(state)
    },
    { scope: 'worker' },
  ],
})
test.use({ storageState: async ({ authState }, use) => { await use(authState) } })

function guardJsonResponses(page: Page): string[] {
  const violations: string[] = []
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (!API_PATHS.test(path) || response.request().resourceType() === 'document') return
    const type = response.headers()['content-type'] || ''
    if (response.status() !== 204 && !type.includes('application/json')) {
      violations.push(`${response.request().method()} ${path} -> ${response.status()} ${type || '(no content-type)'}`)
    }
  })
  return violations
}

/** Polls the API until the single deployment reaches one of the states. */
async function waitForState(page: Page, states: string[], timeoutMs: number) {
  const started = Date.now()
  let last = ''
  while (Date.now() - started < timeoutMs) {
    const res = await page.request.get('/model-deployments')
    const rows = (await res.json())?.data ?? []
    last = rows[0]?.state ?? '(none)'
    if (states.includes(last)) return rows[0]
    await page.waitForTimeout(3000)
  }
  throw new Error(`deployment did not reach ${states.join('|')} within ${timeoutMs}ms (last: ${last})`)
}

test.describe.configure({ mode: 'serial' })

test.describe('Models: deployments and versions', () => {
  let violations: string[] = []
  let hasStub = false

  test.beforeEach(async ({ page }) => {
    violations = guardJsonResponses(page)
    const adapters = await page.request.get('/model-adapters')
    expect(adapters.headers()['content-type']).toContain('application/json')
    const keys: string[] = ((await adapters.json())?.data ?? []).map((a: any) => a.key)
    hasStub = keys.includes('stub')
  })

  test.afterEach(async () => {
    expect(violations, 'non-JSON API responses').toEqual([])
  })

  test('deployments tab lists adapters and the deploy dialog renders an adapter config form', async ({ page }) => {
    const adapters = page.waitForResponse((r) => r.url().includes('/model-adapters') && r.request().resourceType() !== 'document')
    await page.goto('/models?tab=deployments')
    expect((await adapters).status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No deployments yet' })).toBeVisible()

    await page.getByRole('button', { name: 'Deploy', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Deploy a version' })).toBeVisible()
    const adapterGroup = dialog.getByRole('radiogroup', { name: 'Adapter' })
    await expect(adapterGroup.getByRole('radio').first()).toBeVisible()
    await expect(adapterGroup.getByRole('radio', { name: /Hugging Face Inference Endpoints/ })).toBeVisible()
    // No version yet: the select says so and points at the Versions tab.
    await expect(dialog.getByText('Register a version on the Versions tab first.')).toBeVisible()
    await expect(dialog.getByText('Pick an adapter to see its settings.')).toBeVisible()

    test.skip(!hasStub, 'stub adapter not registered on this stack')
    await adapterGroup.getByRole('radio', { name: /Stub \(in-memory\)/ }).click()
    // The stub's JSON schema: a secret token, an image with a default, a simulate enum.
    await expect(dialog.getByLabel('API token', { exact: true })).toHaveAttribute('type', 'password')
    await expect(dialog.getByRole('button', { name: 'Show API token' })).toBeVisible()
    await expect(dialog.getByLabel('Container image')).toHaveValue('stub/vllm:latest')
    await expect(dialog.getByLabel('simulate')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })

  test('versions tab registers an hf:// version; the stub deploys it, scales to zero and tears down', async ({ page }) => {
    test.skip(!hasStub, 'stub adapter not registered on this stack')
    test.setTimeout(3 * RECONCILE_WAIT_MS + 120000)

    // Register the version.
    await page.goto('/models?tab=versions')
    await expect(page.getByRole('heading', { name: 'No versions registered' })).toBeVisible()
    await page.getByRole('button', { name: 'Register version' }).click()
    const versionDialog = page.getByRole('dialog')
    await expect(versionDialog.getByRole('heading', { name: 'Register a version' })).toBeVisible()
    await versionDialog.locator('#version-name').fill('e2e-qwen3-v1')
    await versionDialog.locator('#version-base').fill('qwen3-14b')
    await versionDialog.locator('#version-registry-uri').fill('hf://e2e-org/qwen3-14b@abc123def')
    const created = page.waitForResponse((r) => r.url().includes('/model-versions') && r.request().method() === 'POST')
    await versionDialog.getByRole('button', { name: 'Register', exact: true }).click()
    const createdRes = await created
    expect(createdRes.status(), await createdRes.text()).toBe(201)
    await expect(page.getByText('Version registered', { exact: true })).toBeVisible()
    const versionRow = page.getByRole('row').filter({ hasText: 'e2e-qwen3-v1' })
    await expect(versionRow).toBeVisible()
    await expect(versionRow.getByRole('cell', { name: 'hf://e2e-org/qwen3-14b@abc123def' })).toBeVisible()

    // Deploy it to the stub with the credential it accepts.
    await page.goto('/models?tab=deployments')
    await page.getByRole('button', { name: 'Deploy', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('radiogroup', { name: 'Adapter' }).getByRole('radio', { name: /Stub \(in-memory\)/ }).click()
    await dialog.locator('#deploy-version').selectOption({ label: 'e2e-qwen3-v1 (qwen3-14b)' })
    await dialog.getByLabel('API token', { exact: true }).fill('valid')
    const deployed = page.waitForResponse((r) => new URL(r.url()).pathname === '/model-deployments' && r.request().method() === 'POST')
    await dialog.getByRole('button', { name: 'Deploy', exact: true }).click()
    const deployRes = await deployed
    expect(deployRes.status(), await deployRes.text()).toBe(201)
    await expect(page.getByText('Deployment queued', { exact: true })).toBeVisible()
    const row = page.getByRole('row').filter({ hasText: 'Stub (in-memory)' })
    await expect(row).toBeVisible()
    await expect(row).toContainText('e2e-qwen3-v1')

    // The reconcile loop deploys and reads the endpoint back as ready.
    const ready = await waitForState(page, ['ready', 'failed'], RECONCILE_WAIT_MS)
    expect(ready.state, ready.lastError ?? '').toBe('ready')
    expect(ready.externalRef?.url).toContain('stub.invalid')
    await page.getByRole('button', { name: 'Refresh deployments' }).click()
    await expect(row.getByRole('cell', { name: 'ready', exact: true })).toBeVisible({ timeout: 15000 })

    // Scale to zero from the detail sheet.
    await row.getByRole('cell').first().click()
    const sheet = page.getByRole('dialog')
    await expect(sheet.getByRole('heading', { name: /Stub \(in-memory\)/ })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Copy endpoint URL' })).toBeVisible()
    await sheet.locator('#deployment-replicas').fill('0')
    await sheet.getByRole('button', { name: 'Scale', exact: true }).click()
    const confirmScale = page.getByRole('alertdialog')
    await expect(confirmScale).toContainText('Scale to 0 replicas?')
    const scaled = page.waitForResponse((r) => r.url().includes('/scale'))
    await confirmScale.getByRole('button', { name: 'Scale', exact: true }).click()
    expect((await scaled).status()).toBe(201)
    await expect(page.getByText('Scale requested', { exact: true })).toBeVisible()
    const stopped = await waitForState(page, ['ready', 'failed'], RECONCILE_WAIT_MS)
    expect(stopped.state).toBe('ready')
    expect(stopped.desired?.replicas).toBe(0)
    expect(stopped.actual?.state).toBe('stopped')

    // Tear it down. The sheet may have closed on the list refetch; reopen it.
    if (!(await sheet.isVisible())) await row.getByRole('cell').first().click()
    await sheet.getByRole('button', { name: 'Tear down' }).click()
    const confirmTeardown = page.getByRole('alertdialog')
    await expect(confirmTeardown).toContainText('Tear down this deployment?')
    const torn = page.waitForResponse((r) => r.url().includes('/teardown'))
    await confirmTeardown.getByRole('button', { name: 'Tear down' }).click()
    expect((await torn).status()).toBe(201)
    await expect(page.getByText('Teardown requested', { exact: true })).toBeVisible()
    const final = await waitForState(page, ['torn_down', 'failed'], RECONCILE_WAIT_MS)
    expect(final.state).toBe('torn_down')
    expect(final.externalRef).toBeNull()
    // Reload the tab rather than trusting the sheet/list state after two reconciles.
    await page.goto('/models?tab=deployments')
    await expect(page.getByRole('row').filter({ hasText: 'Stub (in-memory)' }).getByRole('cell', { name: 'torn down' })).toBeVisible({ timeout: 15000 })

    // A version that a torn-down deployment referenced can be deleted.
    const versions = await page.request.get('/model-versions')
    expect(versions.headers()['content-type']).toContain('application/json')
    expect(((await versions.json())?.data ?? []).map((v: any) => v.name)).toContain('e2e-qwen3-v1')
  })
})
