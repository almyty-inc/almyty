import { test, expect } from './setup/test-hooks'
import { TEST_APIS } from './fixtures/test-data'
import { MINIMAL_OPENAPI_SCHEMA } from './fixtures/schemas'

const BOX = 'Paste a link, drop a file, or paste it here'

test.describe('APIs - importing a description', () => {
  let testApi: any

  test.beforeEach(async ({ apiHelper }) => {
    testApi = await apiHelper.createAPI({
      name: 'Schema Test API',
      baseUrl: 'https://schema-test.example.com',
      type: 'openapi',
    })
  })

  test('[CRITICAL VERIFICATION] connects Petstore from its link and extracts its operations', async ({ authenticatedPage: page, assertHelper }) => {
    test.setTimeout(120000)

    await page.goto('/apis/new')
    await page.getByLabel(BOX).fill(TEST_APIS.PETSTORE.schemaUrl)
    await page.getByRole('button', { name: 'Import' }).click()

    // Petstore declares a key: the next page asks for it, and only that.
    await expect(page).toHaveURL(/\/apis\/[^/]+\/setup\?/)
    await expect(page.getByRole('heading', { name: /Finish connecting/ })).toBeVisible()
    await expect(page.getByText(/Found \d+ operations/)).toBeVisible({ timeout: 90000 })
    await page.getByRole('button', { name: /skip for now|open/i }).click()

    await assertHelper.waitForLoadingComplete()
    const operationsText = await page.getByText(/\d+ operations parsed from schema/).textContent()
    const count = parseInt(operationsText?.match(/\d+/)?.[0] || '0')
    expect(count).toBe(TEST_APIS.PETSTORE.expectedOperations)
  })

  test('updates the description from the API page', async ({ authenticatedPage: page, assertHelper }) => {
    test.setTimeout(120000)
    await page.goto(`/apis/${testApi.id}`)
    await page.getByRole('button', { name: /import a description|update the description/i }).first().click()
    await expect(page).toHaveURL(new RegExp(`/apis/${testApi.id}/import`))
    await expect(page.getByRole('heading', { name: 'Update the description' })).toBeVisible()

    await page.getByLabel(BOX).fill(JSON.stringify(MINIMAL_OPENAPI_SCHEMA))
    await page.getByRole('button', { name: 'Import' }).click()

    await expect(page).toHaveURL(new RegExp(`/apis/${testApi.id}$`), { timeout: 90000 })
    await assertHelper.assertToastMessage(/description updated/i, { timeout: 15000 })
  })

  test('imports a description through the API as well', async ({ authenticatedPage: page, assertHelper, apiHelper }) => {
    test.setTimeout(120000)
    await apiHelper.importSchema(testApi.id, { schemaContent: JSON.stringify(MINIMAL_OPENAPI_SCHEMA), generateTools: true })
    await page.waitForTimeout(15000)
    await page.goto('/tools')
    await assertHelper.waitForLoadingComplete()
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10000 })
  })

  test('"Make a tool for every operation" is under Advanced and on by default', async ({ authenticatedPage: page }) => {
    await page.goto(`/apis/${testApi.id}/import`)
    await page.getByRole('button', { name: 'Advanced' }).click()
    const checkbox = page.getByLabel('Make a tool for every operation')
    await expect(checkbox).toBeChecked()
    await checkbox.uncheck()
    await expect(checkbox).not.toBeChecked()
  })

  test('an empty import says what to do', async ({ authenticatedPage: page }) => {
    await page.goto(`/apis/${testApi.id}/import`)
    await page.getByRole('button', { name: 'Import' }).click()
    await expect(page.locator('[role="alert"]').getByText('Paste a link, drop a file, or paste the description first.')).toBeVisible()
  })

  test('a link that returns no description is refused in plain words', async ({ authenticatedPage: page }) => {
    await page.goto(`/apis/${testApi.id}/import`)
    await page.getByLabel(BOX).fill('https://invalid-url-that-does-not-exist.com/schema.json')
    await page.getByRole('button', { name: 'Import' }).click()
    await expect(page.locator('[role="alert"]').getByText("This link doesn't return an API description.")).toBeVisible({ timeout: 30000 })
  })

  test('a description of another kind is refused', async ({ authenticatedPage: page }) => {
    await page.goto(`/apis/${testApi.id}/import`)
    await page.getByLabel(BOX).fill('type Query {\n  hello: String\n}')
    await page.getByRole('button', { name: 'Import' }).click()
    await expect(page.locator('[role="alert"]').getByText(/This is a GraphQL description, but Schema Test API is an OpenAPI API/)).toBeVisible()
  })

  test('Cancel with something typed asks first', async ({ authenticatedPage: page }) => {
    await page.goto(`/apis/${testApi.id}/import`)
    await page.getByLabel(BOX).fill(TEST_APIS.PETSTORE.schemaUrl)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: /discard changes/i }).click()
    await expect(page).toHaveURL(new RegExp(`/apis/${testApi.id}$`))
  })
})
