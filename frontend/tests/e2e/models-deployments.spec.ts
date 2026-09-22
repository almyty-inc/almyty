import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

/**
 * Models layer, Deployments and Tracked artifacts.
 *
 * Deploying is about the model, not about a registered version. The dialog
 * asks where the model is, takes a reference (hf://org/repo@sha,
 * s3://bucket/prefix@etag, or a model a platform already holds such as
 * bedrock:// or fireworks://), and only then offers the providers that can
 * run it. Tracked artifacts are the operator's optional record of their own
 * weights, and most deployments never have one.
 *
 * The versionless POST body is asserted on the wire below. That is the one
 * shape a controller DTO and a form can disagree about while every unit
 * suite on both sides stays green, so it is checked where the two meet.
 *
 * The stub adapter is registered whenever NODE_ENV is not production (or
 * MODEL_STUB_ADAPTER=true); against a stack without it the deploy tests are
 * skipped. The reconcile loop is a cron (MODEL_RECONCILE_CRON, every two
 * minutes by default); the waits below allow for one tick at a one-minute
 * cadence and can be widened with E2E_RECONCILE_WAIT_MS.
 *
 *   npx playwright test --config=playwright.local.config.ts models-deployments.spec.ts
 */

// The deploy dialog also reads credentials, budgets and connections; a
// missing proxy rule for any of them answers with index.html and the form
// silently loses a field, so they are guarded alongside the models paths.
const API_PATHS = /^\/(models|model-adapters|model-deployments|model-versions|credentials|budgets|connections|connectors)(\/|\?|$)/
const RECONCILE_WAIT_MS = Number(process.env.E2E_RECONCILE_WAIT_MS || 150000)

/** A Hub repository, pinned. Nothing registers it anywhere. */
const MODEL_REF = 'hf://e2e-org/qwen3-14b@abc123def'
/** The artifact the optional Tracked artifacts tab records. */
const ARTIFACT_URI = 'hf://e2e-org/qwen3-14b-tracked@def456abc'

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

/** Opens the deploy dialog from the Deployments tab. */
async function openDeployDialog(page: Page) {
  await page.goto('/models?tab=deployments')
  await page.getByRole('button', { name: 'Run a model', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Run a model' })).toBeVisible()
  return dialog
}

test.describe.configure({ mode: 'serial' })

test.describe('Models: deployments and tracked artifacts', () => {
  let violations: string[] = []
  let hasStub = false
  let adapterCount = 0

  test.beforeEach(async ({ page }) => {
    violations = guardJsonResponses(page)
    const adapters = await page.request.get('/model-adapters')
    expect(adapters.headers()['content-type']).toContain('application/json')
    const list: any[] = (await adapters.json())?.data ?? []
    adapterCount = list.length
    expect(adapterCount).toBeGreaterThan(0)
    hasStub = list.some((a) => a.key === 'stub')
    // modelSchemes is the compatibility rule the form filters with; without
    // it every provider looks able to run everything.
    expect(list.every((a) => Array.isArray(a.modelSchemes) && a.modelSchemes.length > 0)).toBe(true)
  })

  test.afterEach(async () => {
    expect(violations, 'non-JSON API responses').toEqual([])
  })

  test('the deploy dialog asks where the model is before it asks who runs it', async ({ page }) => {
    const adapters = page.waitForResponse((r) => r.url().includes('/model-adapters') && r.request().resourceType() !== 'document')
    await page.goto('/models?tab=deployments')
    expect((await adapters).status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No deployments yet' })).toBeVisible()

    await page.getByRole('button', { name: 'Run a model', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Run a model' })).toBeVisible()

    // The model is the first question and it is a free reference: nothing
    // has to exist in this organization before a deployment can name it.
    const model = dialog.getByLabel('Where is the model?')
    await expect(model).toHaveValue('')
    await expect(dialog.getByText('Nothing has to be registered first. Paste the reference and pick a provider that can run it.')).toBeVisible()

    // Who runs it: every provider this server has, until a reference narrows it.
    const providers = dialog.getByRole('radiogroup', { name: 'Provider' })
    await expect(providers.getByRole('radio')).toHaveCount(adapterCount)
    await expect(providers.getByRole('radio', { name: /Hugging Face Inference Endpoints/ })).toBeVisible()
    await expect(dialog.getByText('Pick a provider to see its settings.')).toBeVisible()

    // A registered artifact is optional, so it is folded away.
    await expect(dialog.getByLabel('Registered version')).toBeHidden()
    await dialog.getByRole('button', { name: /Tracked artifact/ }).click()
    await expect(dialog.getByLabel('Registered version')).toBeVisible()
    await expect(dialog.getByRole('option', { name: 'None, use the reference above' })).toBeAttached()
    await expect(dialog.getByText(/Most deployments never use one/)).toBeVisible()

    test.skip(!hasStub, 'stub adapter not registered on this stack')
    await providers.getByRole('radio', { name: /Stub \(in-memory\)/ }).click()
    // The stub's JSON schema: a secret token, an image with a default, a simulate enum.
    await expect(dialog.getByLabel('API token', { exact: true })).toHaveAttribute('type', 'password')
    await expect(dialog.getByRole('button', { name: 'Show API token' })).toBeVisible()
    await expect(dialog.getByLabel('Container image')).toHaveValue('stub/vllm:latest')
    await expect(dialog.getByLabel('simulate')).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })

  test('the provider list narrows to the typed reference, and the excluded ones say why', async ({ page }) => {
    const dialog = await openDeployDialog(page)
    const model = dialog.getByLabel('Where is the model?')
    const providers = dialog.getByRole('radiogroup', { name: 'Provider' })
    await expect(providers.getByRole('radio')).toHaveCount(adapterCount)

    // A Hub repository: the providers that read hf:// stay on offer.
    await model.fill('hf://Qwen/Qwen3-14B@abc123')
    await expect(dialog.getByText('Hugging Face repo: Qwen/Qwen3-14B, pinned to abc123')).toBeVisible()
    const hfCount = await providers.getByRole('radio').count()
    expect(hfCount).toBeGreaterThan(0)
    expect(hfCount).toBeLessThan(adapterCount)
    await expect(providers.getByRole('radio', { name: /Hugging Face Inference Endpoints/ })).toBeVisible()
    await expect(providers.getByRole('radio', { name: /Amazon SageMaker/ })).toHaveCount(0)

    // The rest are still reachable, each with its own reason.
    await dialog.getByRole('button', { name: /cannot run this model/ }).click()
    const blocked = dialog.getByTestId('blocked-providers')
    await expect(blocked.getByRole('listitem')).toHaveCount(adapterCount - hfCount)
    await expect(blocked).toContainText('Amazon SageMaker AI (real-time endpoint)')
    await expect(blocked).toContainText('not hf://')

    // A model a platform already holds: only that platform can run it.
    await model.fill('bedrock://arn:aws:bedrock:eu-west-1::model/acme.support-v1')
    await expect(providers.getByRole('radio')).toHaveCount(1)
    await expect(providers.getByRole('radio', { name: /AWS Bedrock/ })).toBeVisible()
    await expect(dialog.getByText(`1 of ${adapterCount} providers can run a bedrock:// model.`)).toBeVisible()
    await expect(blocked).toContainText('only that provider can run it')

    // The filter runs both ways: picking a provider narrows the sources.
    await providers.getByRole('radio', { name: /AWS Bedrock/ }).click()
    await expect(dialog.getByTestId('adapter-accepts')).toHaveText('AWS Bedrock accepts s3://, bedrock://.')
    const chips = dialog.getByTestId('model-source-chips')
    await expect(chips).toContainText('Amazon S3')
    await expect(chips).not.toContainText('Hugging Face repo')
    await chips.getByRole('button', { name: 'Amazon S3' }).click()
    await expect(model).toHaveValue('s3://bucket/prefix@etag')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })

  test('a provider that cannot read the reference is refused by the form, and by the server', async ({ page }) => {
    const dialog = await openDeployDialog(page)
    const providers = dialog.getByRole('radiogroup', { name: 'Provider' })

    // Pick first, then name a model that provider cannot read. It drops out
    // of the offered list, so the form says where it went.
    await providers.getByRole('radio', { name: /Hugging Face Inference Endpoints/ }).click()
    await dialog.getByLabel('Where is the model?').fill('s3://weights/support@e3b0c442')
    await expect(dialog.getByTestId('dropped-selection')).toContainText('Hugging Face Inference Endpoints is no longer on offer')

    let posted = false
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/model-deployments') posted = true
    })
    await dialog.getByRole('button', { name: 'Deploy', exact: true }).click()
    // The error belongs to the model field, so it is read there rather than
    // from the amber note that also names the provider.
    await expect(dialog.locator('#deploy-model-error')).toHaveText('Hugging Face Inference Endpoints reads hf://, not s3://')
    expect(posted, 'the form settled the pair without asking the server').toBe(false)

    // The same pair straight at the API: the rule is the server's, not a
    // client-side courtesy, and it names the code the form reads.
    const refused = await page.request.post('/model-deployments', {
      data: { providerType: 'huggingface-endpoints', model: 's3://weights/support@e3b0c442' },
    })
    expect(refused.status()).toBe(400)
    const body = await refused.json()
    expect(body?.error?.code).toBe('ADAPTER_UNSUPPORTED_SOURCE')
    expect(body?.error?.message).toContain('cannot run s3://weights/support@e3b0c442')

    await dialog.getByRole('button', { name: 'Cancel' }).click()
  })

  test('a model reference alone deploys: the POST carries model and no version, and the stub runs it', async ({ page }) => {
    test.skip(!hasStub, 'stub adapter not registered on this stack')
    test.setTimeout(3 * RECONCILE_WAIT_MS + 120000)

    const dialog = await openDeployDialog(page)
    await dialog.getByLabel('Where is the model?').fill(MODEL_REF)
    await dialog.getByRole('radiogroup', { name: 'Provider' }).getByRole('radio', { name: /Stub \(in-memory\)/ }).click()
    await dialog.getByLabel('API token', { exact: true }).fill('valid')

    // The shape that matters: the model is configuration, so the body
    // carries `model` and nothing points at a registered version. The
    // controller DTO has to accept exactly this.
    const posted = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/model-deployments')
    const deployed = page.waitForResponse((r) => new URL(r.url()).pathname === '/model-deployments' && r.request().method() === 'POST')
    await dialog.getByRole('button', { name: 'Deploy', exact: true }).click()
    const sent = (await posted).postDataJSON()
    expect(sent).toEqual({
      model: MODEL_REF,
      providerType: 'stub',
      desired: { replicas: 1 },
      providerConfig: { token: 'valid', image: 'stub/vllm:latest', simulate: 'none' },
    })
    // Said twice on purpose: the whole point is that no registered version
    // exists anywhere and none is referenced.
    expect(sent).not.toHaveProperty('modelVersionId')

    const deployRes = await deployed
    expect(deployRes.status(), await deployRes.text()).toBe(201)
    const created = (await deployRes.json())?.data
    expect(created?.modelRef).toBe(MODEL_REF)
    expect(created?.modelVersionId ?? null).toBeNull()
    await expect(page.getByText('Deployment queued', { exact: true })).toBeVisible()

    const row = page.getByRole('row').filter({ hasText: 'Stub (in-memory)' })
    await expect(row).toBeVisible()
    await expect(row).toContainText(MODEL_REF)

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
    // The sheet says the model was named here rather than tracked anywhere.
    await expect(sheet.getByText('Named as configuration on the deployment. Nothing had to be registered.')).toBeVisible()
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
  })

  test('a tracked artifact is optional, and deploying one pre-fills the reference', async ({ page }) => {
    await page.goto('/models?tab=versions')
    await expect(page.getByRole('heading', { name: 'Tracked artifacts', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Nothing tracked here, and most people never need this' })).toBeVisible()

    await page.getByRole('button', { name: 'Register artifact', exact: true }).click()
    const registerDialog = page.getByRole('dialog')
    await expect(registerDialog.getByRole('heading', { name: 'Register an artifact' })).toBeVisible()
    await registerDialog.locator('#version-name').fill('e2e-qwen3-v1')
    await registerDialog.locator('#version-base').fill('qwen3-14b')
    await registerDialog.locator('#version-registry-uri').fill(ARTIFACT_URI)
    const created = page.waitForResponse((r) => new URL(r.url()).pathname === '/model-versions' && r.request().method() === 'POST')
    await registerDialog.getByRole('button', { name: 'Register', exact: true }).click()
    const createdRes = await created
    expect(createdRes.status(), await createdRes.text()).toBe(201)
    await expect(page.getByText('Version registered', { exact: true })).toBeVisible()
    const versionRow = page.getByRole('row').filter({ hasText: 'e2e-qwen3-v1' })
    await expect(versionRow.getByRole('cell', { name: ARTIFACT_URI })).toBeVisible()

    // Deploying a tracked artifact fills the reference from the record, and
    // sends the id instead of the reference.
    await versionRow.getByRole('cell').first().click()
    const sheet = page.getByRole('dialog')
    await expect(sheet.getByRole('heading', { name: 'e2e-qwen3-v1' })).toBeVisible()
    await sheet.getByRole('button', { name: 'Deploy this version' }).click()
    const deployDialog = page.getByRole('dialog')
    await expect(deployDialog.getByRole('heading', { name: 'Run a model' })).toBeVisible()
    await expect(deployDialog.getByLabel('Where is the model?')).toHaveValue(ARTIFACT_URI)
    await expect(deployDialog.getByLabel('Registered version')).not.toHaveValue('')

    test.skip(!hasStub, 'stub adapter not registered on this stack')
    await deployDialog.getByRole('radiogroup', { name: 'Provider' }).getByRole('radio', { name: /Stub \(in-memory\)/ }).click()
    await deployDialog.getByLabel('API token', { exact: true }).fill('valid')
    const posted = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/model-deployments')
    const deployed = page.waitForResponse((r) => new URL(r.url()).pathname === '/model-deployments' && r.request().method() === 'POST')
    await deployDialog.getByRole('button', { name: 'Deploy', exact: true }).click()
    const sent = (await posted).postDataJSON()
    expect(sent.modelVersionId).toBeTruthy()
    expect(sent).not.toHaveProperty('model')
    const deployRes = await deployed
    expect(deployRes.status(), await deployRes.text()).toBe(201)
    expect((await deployRes.json())?.data?.modelVersionId).toBe(sent.modelVersionId)
  })
})
