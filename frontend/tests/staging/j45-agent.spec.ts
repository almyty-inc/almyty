/**
 * J4/J5: build an autonomous agent in the QA organization with the
 * Open-Meteo tool and memory, check its answers with a second vendor's
 * model, and run it from Try it. The answer's numbers must be what
 * Open-Meteo says at the same moment, and the run must show the tool call
 * and the check's verdict.
 *
 * Models come from the QA org's connected providers; nothing here holds a
 * key. GATE_MAIN_MODEL / GATE_CHECK_MODEL pick other connected models.
 */
import { test, expect } from './support/fixtures'
import { connectApi, idFromUrl } from './support/flows'
import { BERLIN, OPEN_METEO_SPEC, berlinDaily } from './support/open-meteo'
import type { Locator, Page } from '@playwright/test'

const MAIN_MODEL = process.env.GATE_MAIN_MODEL || 'gpt-4.1-mini'
const CHECK_MODEL = process.env.GATE_CHECK_MODEL || 'claude-haiku-4-5'

/** Pick a model in an open model picker by searching for it. */
async function pickModel(page: Page, picker: Locator, model: string): Promise<void> {
  await picker.click()
  await page.getByRole('searchbox', { name: 'Search models' }).fill(model)
  // Options read "<label><model id> <price>"; the id is what is matched.
  const option = page.getByRole('option', { name: new RegExp(model.replace(/[.]/g, '\\.')) }).first()
  await expect(option, `${model} should be offered by a connected provider`).toBeVisible()
  await option.click()
  await expect(picker).not.toContainText('Choose a model')
}

/** Tomorrow's date in Berlin, as Open-Meteo writes it (YYYY-MM-DD). */
function berlinTomorrow(): string {
  const now = new Date(Date.now() + 24 * 3600_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

test.describe('J4/J5 autonomous agent with a real tool', () => {
  test('J4/J5 agent answers from Open-Meteo, and the run shows the tool call and the check', async ({ page, gate }) => {
    // The tool: Open-Meteo, connected by link.
    const apiName = gate.name('agent-openmeteo')
    await connectApi(page, gate, {
      kind: /OpenAPI \/ Swagger/,
      name: apiName,
      fill: async (p) => {
        await p.getByRole('textbox', { name: 'Link to the description' }).fill(OPEN_METEO_SPEC)
      },
    })

    // J4: build it.
    const agentName = gate.name('weather-agent')
    await page.goto('/agents/new')
    await page.getByRole('textbox', { name: 'Agent name' }).fill(agentName)
    // A new agent starts autonomous.
    await expect(page.getByRole('button', { name: 'Autonomous' }), 'Create agent should open in Autonomous mode').toHaveAttribute('aria-pressed', 'true')
    await pickModel(page, page.getByRole('combobox', { name: 'Model' }), MAIN_MODEL)
    await page.getByRole('textbox', { name: 'Instructions' }).fill(
      'You report weather. Always call the Open-Meteo forecast tool for the numbers ' +
        '(daily=temperature_2m_max, timezone=Europe/Berlin, start_date and end_date set to the day asked). ' +
        'Report exactly the value the tool returned, in °C, with one decimal. Never invent numbers.',
    )
    await page.getByRole('switch', { name: 'Remember between conversations' }).click()
    await expect(page.getByRole('switch', { name: 'Remember between conversations' })).toBeChecked()
    await page.getByRole('textbox', { name: 'Search tools' }).fill(apiName)
    await page.getByRole('checkbox', { name: new RegExp(`^All tools of ${apiName}`) }).check()
    await expect(page.getByText(`${apiName}, all tools`)).toBeVisible()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 60_000 })
    const agentId = idFromUrl(page)
    gate.track('agent', agentId)

    // Turn it on, and have a second vendor's model check every answer.
    await page.goto(`/agents/${agentId}`)
    await expect(page.getByRole('heading', { name: agentName, level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Activate', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Deactivate', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Configure verification' }).click()
    const verify = page.getByTestId('verify-config-editor')
    await verify.getByRole('switch', { name: 'Enable verification' }).click()
    await verify.getByRole('button', { name: 'Add reviewer' }).click()
    await verify.getByRole('textbox', { name: 'Reviewer name' }).fill('gate checker')
    await pickModel(page, verify.getByRole('combobox', { name: 'Model' }), CHECK_MODEL)
    await verify.getByRole('button', { name: 'Save verification' }).click()
    await expect(page.getByTestId('verify-mode-badge')).toHaveText(/Reports only/)

    // J5: ask from Try it, and look at Open-Meteo ourselves at the same moment.
    const day = berlinTomorrow()
    await page.getByRole('textbox', { name: 'Message' }).fill(
      `What is the maximum temperature in Berlin (latitude ${BERLIN.latitude}, longitude ${BERLIN.longitude}) on ${day}? ` +
        'Use timezone Europe/Berlin.',
    )
    const [, daily] = await Promise.all([
      page.getByRole('button', { name: 'Run test' }).click(),
      berlinDaily(3),
    ])
    const idx = daily.time.indexOf(day)
    expect(idx, `Open-Meteo should forecast ${day}`).toBeGreaterThanOrEqual(0)
    const expected = daily.temperature_2m_max[idx]

    // Try it's answer (the empty "No runs yet" status has no digits).
    const answer = page.getByRole('tabpanel', { name: 'Overview' }).getByRole('status').filter({ hasText: /\d/ }).first()
    await expect(answer, 'the agent should answer').toContainText(/°/, { timeout: 180_000 })
    const text = await answer.innerText()
    // The temperatures it states: numbers written with °.
    const temps = [...text.matchAll(/(-?\d+(?:[.,]\d+)?)\s*°/g)].map((m) => Number(m[1].replace(',', '.')))
    expect(temps.length, `the answer "${text}" should state a temperature`).toBeGreaterThan(0)
    // Open-Meteo gives one decimal; the agent may round to a whole degree.
    for (const t of temps) {
      expect(Math.abs(t - expected), `the answer "${text}" should give ${expected} °C (Open-Meteo, ${day})`).toBeLessThanOrEqual(0.5)
    }

    // The run: the tool call that fetched it, and the check's verdict.
    await page.getByRole('row', { name: /^Open the run of/ }).first().click()
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}/)
    const runs = page.getByRole('tabpanel', { name: 'Runs' })
    await expect(runs.getByText(/^completed$/).first()).toBeVisible({ timeout: 60_000 })
    await expect(runs.getByRole('heading', { name: 'Steps' })).toBeVisible()
    // The steps list: each step's number, kind, input and output.
    const steps = (await runs.innerText()).replace(/\s+/g, ' ')
    const toolIdent = `${apiName.replace(/-/g, '_')}_get_v1_forecast`
    expect(steps, 'the run should list the forecast tool call').toMatch(new RegExp(`#\\d+ tool_call In: \\{"tool":"${toolIdent}"`))
    // What the tool returned is the number the answer gave.
    expect(steps).toMatch(new RegExp(`"temperature_2m_max":\\[[^\\]]*${String(expected).replace('.', '\\.')}[,\\]]`))
    expect(steps, 'the run should list the answer check').toMatch(/#\d+ verify Answer check/)
    await expect(runs.getByText('Check passed').first(), 'a correct answer should pass its check').toBeVisible()
  })
})
