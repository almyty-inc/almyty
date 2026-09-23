import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

/**
 * Models: hosting a model on your own cloud account.
 *
 * Add model > Your cloud account (/models/new?via=cloud) asks which model
 * first (hf://org/repo, s3://bucket/prefix@etag, or a model a cloud already
 * holds such as bedrock:// or fireworks://), and only then offers the clouds
 * that can run it. A Hugging Face repository may be named without a commit;
 * the server pins it. Nothing has to be registered first, and there is no
 * dialog anywhere in the flow. The request creates the model in the list at
 * once and the browser lands on its page, where the "On your cloud" section
 * carries its state, cost and controls.
 *
 * The POST body is asserted on the wire below. That is the one shape a
 * controller DTO and a form can disagree about while every unit suite on
 * both sides stays green, so it is checked where the two meet.
 *
 * The in-memory test cloud (the `stub` integration) is registered whenever
 * NODE_ENV is not production (or MODEL_STUB_ADAPTER=true); against a stack
 * without it the hosting run is skipped. The reconcile loop is a cron
 * (MODEL_RECONCILE_CRON, every two minutes by default); the waits below
 * allow for one tick at a one-minute cadence and can be widened with
 * E2E_RECONCILE_WAIT_MS.
 *
 *   npx playwright test --config=playwright.local.config.ts models-deployments.spec.ts
 */

// The host form also reads credentials, budgets and connections; a missing
// proxy rule for any of them answers with index.html and the form silently
// loses a field, so they are guarded alongside the models paths.
const API_PATHS = /^\/(models|model-adapters|model-deployments|model-versions|credentials|budgets|connections|connectors)(\/|\?|$)/
const RECONCILE_WAIT_MS = Number(process.env.E2E_RECONCILE_WAIT_MS || 150000)

/**
 * A Hub repository pinned to a full commit, so the server has nothing to
 * resolve against the Hub for a repository that does not exist there.
 */
const MODEL_REF = 'hf://e2e-org/qwen3-14b@0123456789abcdef0123456789abcdef01234567'
const MODEL_NAME = 'E2E hosted qwen'
/** Integrations that are not a cloud; the picker never offers them. */
const NOT_A_CLOUD = new Set(['custom-endpoint'])

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
      await registerUser(page, 'hosting')
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

/** Polls the API until the single hosted model reaches one of the states. */
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
  throw new Error(`hosted model did not reach ${states.join('|')} within ${timeoutMs}ms (last: ${last})`)
}

/** Opens Add model > Your cloud account. */
async function openHostForm(page: Page) {
  await page.goto('/models/new?via=cloud')
  await expect(page.getByRole('heading', { name: 'Host a model on your cloud', level: 1 })).toBeVisible()
  await expect(page.getByLabel('Which model')).toBeVisible()
  return {
    model: page.getByLabel('Which model'),
    clouds: page.getByRole('radiogroup', { name: 'Cloud' }),
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('Models: hosting a model on your cloud account', () => {
  let violations: string[] = []
  let hasStub = false
  let cloudCount = 0

  test.beforeEach(async ({ page }) => {
    violations = guardJsonResponses(page)
    const adapters = await page.request.get('/model-adapters')
    expect(adapters.headers()['content-type']).toContain('application/json')
    const list: any[] = (await adapters.json())?.data ?? []
    cloudCount = list.filter((a) => !NOT_A_CLOUD.has(a.key)).length
    expect(cloudCount).toBeGreaterThan(0)
    hasStub = list.some((a) => a.key === 'stub')
    // modelSchemes is the compatibility rule the form filters with; without
    // it every cloud looks able to run everything.
    expect(list.every((a) => Array.isArray(a.modelSchemes) && a.modelSchemes.length > 0)).toBe(true)
  })

  test.afterEach(async () => {
    expect(violations, 'non-JSON API responses').toEqual([])
  })

  test('the host form asks which model before which cloud, on a page, with nothing to register', async ({ page }) => {
    const adapters = page.waitForResponse((r) => r.url().includes('/model-adapters') && r.request().resourceType() !== 'document')
    await page.goto('/models/new')
    await page.getByRole('list', { name: 'Where does it run?' }).getByRole('button', { name: /^Your cloud account/ }).click()
    await expect(page).toHaveURL(/\/models\/new\?via=cloud$/)
    expect((await adapters).status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Host a model on your cloud', level: 1 })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The model is the first question and it is a free reference: nothing
    // has to exist in this organization before a model can be hosted.
    const model = page.getByLabel('Which model')
    await expect(model).toHaveValue('')
    await expect(page.getByText('Paste the repository or path, then pick the cloud that runs it.')).toBeVisible()

    // Which cloud: every cloud this server has, until a source narrows it.
    const clouds = page.getByRole('radiogroup', { name: 'Cloud' })
    await expect(clouds.getByRole('radio')).toHaveCount(cloudCount)
    await expect(clouds.getByRole('radio', { name: /Hugging Face Inference Endpoints/ })).toBeVisible()
    await expect(page.getByText('Pick a cloud to see its settings.')).toBeVisible()

    // No registered versions or tracked weights to pick from anywhere.
    await expect(page.getByText(/Tracked artifact|Registered version/)).toHaveCount(0)

    // A Hub repository without a commit is accepted; the server pins it.
    await model.fill('hf://Qwen/Qwen3-14B')
    await expect(page.getByText('Hugging Face repo: Qwen/Qwen3-14B, pinned to its exact commit when you save')).toBeVisible()
    await model.fill('')

    test.skip(!hasStub, 'test cloud not registered on this stack')
    await clouds.getByRole('radio', { name: /Test cloud \(in memory\)/ }).click()
    // The stub's JSON schema: a secret token, an image with a default, a simulate enum.
    await expect(page.getByLabel('API token', { exact: true })).toHaveAttribute('type', 'password')
    await expect(page.getByRole('button', { name: 'Show API token' })).toBeVisible()
    await expect(page.getByLabel('Container image')).toHaveValue('stub/vllm:latest')
    await expect(page.getByLabel('simulate')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(/\/models$/)
  })

  test('the cloud list narrows to the named model, and the excluded ones say why', async ({ page }) => {
    const { model, clouds } = await openHostForm(page)
    await expect(clouds.getByRole('radio')).toHaveCount(cloudCount)

    // A Hub repository: the clouds that read hf:// stay on offer.
    await model.fill('hf://Qwen/Qwen3-14B@abc123')
    await expect(page.getByText('Hugging Face repo: Qwen/Qwen3-14B at abc123, pinned to its exact commit when you save')).toBeVisible()
    const hfCount = await clouds.getByRole('radio').count()
    expect(hfCount).toBeGreaterThan(0)
    expect(hfCount).toBeLessThan(cloudCount)
    await expect(clouds.getByRole('radio', { name: /Hugging Face Inference Endpoints/ })).toBeVisible()
    await expect(clouds.getByRole('radio', { name: /Amazon SageMaker/ })).toHaveCount(0)

    // The rest are still reachable, each with its own reason.
    await page.getByRole('button', { name: /cannot run this model/ }).click()
    const blocked = page.getByTestId('blocked-providers')
    await expect(blocked.getByRole('listitem')).toHaveCount(cloudCount - hfCount)
    await expect(blocked).toContainText('Amazon SageMaker')
    await expect(blocked).toContainText('not hf://')

    // A model a cloud already holds: only that cloud can run it.
    await model.fill('bedrock://arn:aws:bedrock:eu-west-1::model/acme.support-v1')
    await expect(clouds.getByRole('radio')).toHaveCount(1)
    await expect(clouds.getByRole('radio', { name: /AWS Bedrock/ })).toBeVisible()
    await expect(page.getByText(`1 of ${cloudCount} clouds can run a bedrock:// model.`)).toBeVisible()
    await expect(blocked).toContainText('only that cloud can run it')

    // The filter runs both ways: picking a cloud narrows the sources.
    await clouds.getByRole('radio', { name: /AWS Bedrock/ }).click()
    await expect(page.getByTestId('adapter-accepts')).toHaveText('AWS Bedrock accepts s3://, bedrock://.')
    const chips = page.getByTestId('model-source-chips')
    await expect(chips).toContainText('Amazon S3')
    await expect(chips).not.toContainText('Hugging Face repo')
    await chips.getByRole('button', { name: 'Amazon S3' }).click()
    await expect(model).toHaveValue('s3://bucket/prefix@etag')

    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('a cloud that cannot read the model is refused by the form, and by the server', async ({ page }) => {
    const { model, clouds } = await openHostForm(page)

    // Pick first, then name a model that cloud cannot read. It drops out
    // of the offered list, so the form says where it went.
    await clouds.getByRole('radio', { name: /Hugging Face Inference Endpoints/ }).click()
    await model.fill('s3://weights/support@e3b0c442')
    await expect(page.getByTestId('dropped-selection')).toContainText('Hugging Face Inference Endpoints is no longer on offer')

    let posted = false
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/model-deployments') posted = true
    })
    await page.getByRole('button', { name: 'Host model', exact: true }).click()
    // The error belongs to the model field, so it is read there rather than
    // from the amber note that also names the cloud.
    await expect(page.locator('#host-model-error')).toHaveText('Hugging Face Inference Endpoints reads hf://, not s3://')
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

    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('hosting a model: the POST names the model, the model is in the list at once, and it starts, stops and shuts down from its own page', async ({ page }) => {
    test.skip(!hasStub, 'test cloud not registered on this stack')
    test.setTimeout(3 * RECONCILE_WAIT_MS + 120000)

    const { model, clouds } = await openHostForm(page)
    await model.fill(MODEL_REF)
    await page.locator('#host-name').fill(MODEL_NAME)
    await clouds.getByRole('radio', { name: /Test cloud \(in memory\)/ }).click()
    await page.getByLabel('API token', { exact: true }).fill('valid')

    // The shape that matters: the model is configuration, so the body
    // carries `model` and nothing points at a registered version.
    const posted = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/model-deployments')
    const hosted = page.waitForResponse((r) => new URL(r.url()).pathname === '/model-deployments' && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Host model', exact: true }).click()
    const sent = (await posted).postDataJSON()
    expect(sent).toEqual({
      model: MODEL_REF,
      providerType: 'stub',
      name: MODEL_NAME,
      desired: { replicas: 1, privacyTier: 'private_cloud' },
      providerConfig: { token: 'valid', image: 'stub/vllm:latest', simulate: 'none' },
    })
    expect(sent).not.toHaveProperty('modelVersionId')

    const hostRes = await hosted
    expect(hostRes.status(), await hostRes.text()).toBe(201)
    const created = (await hostRes.json())?.data
    expect(created?.modelRef).toBe(MODEL_REF)
    expect(created?.modelVersionId ?? null).toBeNull()
    // The server creates the model with the request and links it.
    const modelId: string = created?.modelId
    expect(modelId, 'the hosting request created the model').toBeTruthy()
    await expect(page.getByText('Starting your model', { exact: true })).toBeVisible()

    // The browser lands on the model, which is already a model: not usable
    // until it runs and a validation passes, but in the list from now on.
    await expect(page).toHaveURL(new RegExp(`/models/${modelId}$`))
    await expect(page.getByRole('heading', { name: MODEL_NAME, level: 1 })).toBeVisible()
    const card = await (await page.request.get(`/models/${modelId}`)).json()
    expect(card?.data?.status).toBe('deploying')
    expect(card?.data?.selectable).toBe(false)
    const onCloud = page.getByRole('region', { name: 'On your cloud' })
    await expect(onCloud).toBeVisible()
    const panel = onCloud.getByTestId('hosting-panel')
    await expect(panel).toContainText('Test cloud (in memory)')

    await page.goto('/models')
    const listed = page.getByTestId('catalog-cards').getByRole('listitem').filter({ hasText: MODEL_NAME })
    await expect(listed).toContainText('Your cloud')
    await expect(listed).toContainText('Test cloud (in memory)')

    // The reconcile loop starts it and reads the endpoint back as ready.
    const ready = await waitForState(page, ['ready', 'failed'], RECONCILE_WAIT_MS)
    expect(ready.state, ready.lastError ?? '').toBe('ready')
    expect(ready.externalRef?.url).toContain('stub.invalid')
    await expect
      .poll(async () => (await (await page.request.get(`/models/${modelId}`)).json())?.data?.status, { timeout: 30000, message: 'the model turns active once its endpoint is ready' })
      .toBe('active')

    await page.goto(`/models/${modelId}`)
    await expect(panel.locator('[data-state="ready"]')).toHaveText('Running', { timeout: 15000 })
    await expect(panel.getByRole('button', { name: 'Copy endpoint URL' })).toBeVisible()

    // Stop asks first; starting and resizing do not.
    await panel.getByRole('button', { name: 'Stop', exact: true }).click()
    const confirmStop = page.getByRole('alertdialog')
    await expect(confirmStop.getByRole('heading', { name: 'Stop this model?' })).toBeVisible()
    const scaled = page.waitForResponse((r) => r.url().includes('/scale'))
    await confirmStop.getByRole('button', { name: 'Stop', exact: true }).click()
    expect((await scaled).status()).toBe(201)
    await expect(page.getByText('Stopping', { exact: true })).toBeVisible()
    const stopped = await waitForState(page, ['ready', 'failed'], RECONCILE_WAIT_MS)
    expect(stopped.state).toBe('ready')
    expect(stopped.desired?.replicas).toBe(0)
    expect(stopped.actual?.state).toBe('stopped')

    await page.reload()
    await expect(panel.locator('[data-state="ready"]')).toHaveText('Stopped', { timeout: 15000 })
    await expect(panel.getByRole('button', { name: 'Start', exact: true })).toBeVisible()

    // Shut down asks first, then removes it from the cloud; the model stays.
    await panel.getByRole('button', { name: 'Shut down', exact: true }).click()
    const confirmShutDown = page.getByRole('alertdialog')
    await expect(confirmShutDown.getByRole('heading', { name: 'Shut this model down?' })).toBeVisible()
    const torn = page.waitForResponse((r) => r.url().includes('/teardown'))
    await confirmShutDown.getByRole('button', { name: 'Shut down', exact: true }).click()
    expect((await torn).status()).toBe(201)
    await expect(page.getByText('Shutting down', { exact: true }).first()).toBeVisible()
    const final = await waitForState(page, ['torn_down', 'failed'], RECONCILE_WAIT_MS)
    expect(final.state).toBe('torn_down')
    expect(final.externalRef).toBeNull()

    // Reload rather than trusting the page state after two reconciles.
    await page.goto(`/models/${modelId}`)
    await expect(page.getByRole('heading', { name: MODEL_NAME, level: 1 })).toBeVisible()
    await expect(panel.locator('[data-state="torn_down"]')).toHaveText('Shut down', { timeout: 15000 })
    await expect(panel.getByRole('button', { name: 'Shut down', exact: true })).toHaveCount(0)
  })

  test('a hosted model page for something on no cloud says so', async ({ page }) => {
    await page.goto('/models/hosting/00000000-0000-4000-8000-000000000000')
    await expect(page.getByText('This model is not on any of your clouds.')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
