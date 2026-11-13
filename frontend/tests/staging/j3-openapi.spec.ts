/**
 * J3: give an AI your API. Open-Meteo's forecast description, connected by
 * link: its servers are declared on the path, not at the top level, which
 * is exactly what decides whether the tools call the right host.
 */
import { test, expect, type Gate } from './support/fixtures'
import { connectApi, executeTool, idFromUrl, openApiTools, openTestTool, responseData } from './support/flows'
import { BERLIN, OPEN_METEO, OPEN_METEO_SPEC, forecast } from './support/open-meteo'
import type { Page } from '@playwright/test'

async function connectOpenMeteo(page: Page, gate: Gate, name: string): Promise<string> {
  return connectApi(page, gate, {
    kind: /OpenAPI \/ Swagger/,
    name,
    fill: async (p) => {
      await p.getByRole('textbox', { name: 'Link to the description' }).fill(OPEN_METEO_SPEC)
    },
  })
}

/** The single forecast tool of the API, opened from the API's "Tools generated" link. */
async function openForecastTool(page: Page, apiName: string): Promise<string> {
  await openApiTools(page, apiName)
  const rows = page.getByRole('row').filter({ hasText: apiName })
  await expect(rows).toHaveCount(1)
  await rows.first().getByText('Open-Meteo Weather Forecast API').click()
  await expect(page).toHaveURL(/\/tools\/[0-9a-f-]{36}/)
  return idFromUrl(page)
}

test.describe('J3 connect an API by OpenAPI link', () => {
  test('J3 OpenAPI link import: the API address is the API host, not the spec host', async ({ page, gate, qa }) => {
    const name = gate.name('openmeteo-address')
    const apiId = await connectOpenMeteo(page, gate, name)

    // What the page says and what the tools will call.
    await expect(page.getByRole('main').getByText(OPEN_METEO, { exact: true }).first()).toBeVisible()
    const api = (await (await qa.get(`/apis/${apiId}`)).json()).data
    expect(api.baseUrl).toBe(OPEN_METEO)
    await expect(page.getByRole('heading', { name: 'API operations' })).toBeVisible()
    await expect(page.getByRole('button', { name: /GET \/v1\/forecast/ })).toBeVisible()
  })

  test('J3 Test tool returns real forecast data, and a 4xx shows Error', async ({ page, gate }) => {
    const name = gate.name('openmeteo-run')
    await connectOpenMeteo(page, gate, name)
    const toolId = await openForecastTool(page, name)
    const panel = await openTestTool(page, toolId)

    const params = { ...BERLIN, daily: 'temperature_2m_max', timezone: 'Europe/Berlin', forecast_days: '3' }
    const [outcome, direct] = await Promise.all([executeTool(panel, params), forecast(params)])
    expect(outcome, 'a real forecast call should show Success').toBe('Success')
    await expect(panel.getByText(/^Executed in \d+ms$/)).toBeVisible()
    const shown = await responseData(panel)
    const body = shown?.body ?? shown?.data ?? shown
    expect(body.daily.time).toEqual(direct.daily.time)
    expect(body.daily.temperature_2m_max).toEqual(direct.daily.temperature_2m_max)

    // Open-Meteo answers 400 for an impossible latitude: the page must say Error.
    const failed = await executeTool(panel, { latitude: '999' })
    expect(failed, 'an upstream 400 must not show as Success').toBe('Error')
    await expect(panel.getByText(/HTTP Status:\s*400/)).toBeVisible()
  })

  test('J3 Tools generated lists only this API\'s tools, and Test connection is Reachable', async ({ page, gate }) => {
    const name = gate.name('openmeteo-links')
    const apiId = await connectOpenMeteo(page, gate, name)

    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByText(/^(Reachable|Failed)$/)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/^(Reachable|Failed)$/), 'Open-Meteo is up: the API should test Reachable').toHaveText('Reachable')

    await openApiTools(page, name)
    expect(page.url()).toContain(apiId)
    // Every listed tool belongs to this API, and there is exactly its one tool.
    const bodyRows = page.locator('tbody tr')
    await expect(bodyRows).toHaveCount(1)
    await expect(bodyRows.first()).toContainText(name)
    await expect(page.getByText(/^1 tools?$/)).toBeVisible()
  })
})
