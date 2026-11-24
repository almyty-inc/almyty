/**
 * Showcase: from an API to a working autonomous agent, filmed on staging.
 *
 * Connect Open-Meteo by its link, build an autonomous agent on it, have a
 * second vendor's model check its answers, ask it something, and open the
 * run to show the tool call and the check. Nothing is staged: the answer
 * is compared with what Open-Meteo says at the same moment, so a recording
 * of a wrong answer fails instead of being kept.
 */
import { test, expect } from '../staging/support/fixtures'
import { activateAgent, connectApi, idFromUrl } from '../staging/support/flows'
import { BERLIN, OPEN_METEO_SPEC, berlinDaily } from '../staging/support/open-meteo'
import type { Locator, Page } from '@playwright/test'

const MAIN_MODEL = process.env.GATE_MAIN_MODEL || 'gpt-4.1-mini'
const CHECK_MODEL = process.env.GATE_CHECK_MODEL || 'claude-haiku-4-5'

/** A pause long enough to read what just appeared. */
const beat = (page: Page, ms = 1500) => page.waitForTimeout(ms)

async function pickModel(page: Page, picker: Locator, model: string): Promise<void> {
  await picker.click()
  await page.getByRole('searchbox', { name: 'Search models' }).pressSequentially(model, { delay: 40 })
  const option = page.getByRole('option', { name: new RegExp(model.replace(/[.]/g, '\\.')) }).first()
  await expect(option).toBeVisible()
  await beat(page, 600)
  await option.click()
  await expect(picker).not.toContainText('Choose a model')
}

function berlinTomorrow(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Date.now() + 24 * 3600_000),
  )
}

test('weather brief: API to autonomous agent to checked answer', async ({ page, gate }) => {
  const apiName = 'Weather forecast'
  await connectApi(page, gate, {
    kind: /OpenAPI \/ Swagger/,
    name: apiName,
    fill: async (p) => {
      await p.getByRole('textbox', { name: 'Link to the description' }).pressSequentially(OPEN_METEO_SPEC, { delay: 15 })
    },
  })
  await beat(page, 2500)

  const agentName = 'Morning weather brief'
  await page.goto('/agents/new')
  await page.getByRole('textbox', { name: 'Agent name' }).pressSequentially(agentName, { delay: 40 })
  await pickModel(page, page.getByRole('combobox', { name: 'Model' }), MAIN_MODEL)
  await page.getByRole('textbox', { name: 'Instructions' }).fill(
    'You report weather. Always call the forecast tool for the numbers ' +
      '(daily=temperature_2m_max, timezone=Europe/Berlin, start_date and end_date set to the day asked). ' +
      'Report exactly the value the tool returned, in °C, with one decimal. Never invent numbers.',
  )
  await beat(page)
  await page.getByRole('switch', { name: 'Remember between conversations' }).click()
  await page.getByRole('textbox', { name: 'Search tools' }).pressSequentially(apiName, { delay: 40 })
  await page.getByRole('checkbox', { name: new RegExp(`^All tools of ${apiName}`) }).check()
  await beat(page)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 60_000 })
  const agentId = idFromUrl(page)
  gate.track('agent', agentId)

  await page.goto(`/agents/${agentId}`)
  await expect(page.getByRole('heading', { name: agentName, level: 1 })).toBeVisible()
  await activateAgent(page)
  await page.getByRole('button', { name: 'Configure verification' }).click()
  const verify = page.getByTestId('verify-config-editor')
  await verify.getByRole('switch', { name: 'Enable verification' }).click()
  await verify.getByRole('button', { name: 'Add reviewer' }).click()
  await verify.getByRole('textbox', { name: 'Reviewer name' }).pressSequentially('Second opinion', { delay: 40 })
  await pickModel(page, verify.getByRole('combobox', { name: 'Model' }), CHECK_MODEL)
  await verify.getByRole('button', { name: 'Save verification' }).click()
  await expect(page.getByTestId('verify-mode-badge')).toHaveText(/Reports only/)
  await beat(page)

  const day = berlinTomorrow()
  await page.getByRole('textbox', { name: 'Message' }).pressSequentially(
    `What will the maximum temperature be in Berlin (${BERLIN.latitude}, ${BERLIN.longitude}) on ${day}?`,
    { delay: 25 },
  )
  const [, daily] = await Promise.all([page.getByRole('button', { name: 'Run test' }).click(), berlinDaily(3)])
  const expected = daily.temperature_2m_max[daily.time.indexOf(day)]

  const answer = page.getByRole('tabpanel', { name: 'Overview' }).getByRole('status').filter({ hasText: /\d/ }).first()
  await expect(answer).toContainText(/°/, { timeout: 180_000 })
  const temps = [...(await answer.innerText()).matchAll(/(-?\d+(?:[.,]\d+)?)\s*°/g)].map((m) => Number(m[1].replace(',', '.')))
  expect(temps.length).toBeGreaterThan(0)
  for (const t of temps) expect(Math.abs(t - expected), `answer should match Open-Meteo (${expected} °C)`).toBeLessThanOrEqual(0.5)
  await beat(page, 3000)

  await page.getByRole('row', { name: /^Open the run of/ }).first().click()
  const runs = page.getByRole('tabpanel', { name: 'Runs' })
  await expect(runs.getByText(/^completed$/i).first()).toBeVisible({ timeout: 60_000 })
  await expect(runs.getByText('No contradictions found').first()).toBeVisible()
  await beat(page, 1500)
  await runs.getByRole('heading', { name: 'Steps' }).scrollIntoViewIfNeeded()
  await beat(page, 4000)
})
