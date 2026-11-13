/**
 * An autonomous weather agent built through Create agent, the way a
 * person would: Open-Meteo connected by link as its tool, models picked
 * from the QA org's connected providers, a work mode, and memory if
 * asked. Its answers are checked against Open-Meteo itself, fetched at
 * the same moment.
 *
 * Used by the compatible-API, CLI, strategy and memory tests.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import type { Gate } from './fixtures'
import { connectApi, escape, idFromUrl } from './flows'
import { BERLIN, OPEN_METEO_SPEC, berlinDaily } from './open-meteo'

export const MAIN_MODEL = process.env.GATE_MAIN_MODEL || 'gpt-4.1-mini'
export const CHECK_MODEL = process.env.GATE_CHECK_MODEL || 'claude-haiku-4-5'

/** Pick a model in a model picker by searching for it. */
export async function pickModel(page: Page, picker: Locator, model: string): Promise<void> {
  await picker.click()
  await page.getByRole('searchbox', { name: 'Search models' }).fill(model)
  const option = page.getByRole('option', { name: new RegExp(escape(model)) }).first()
  await expect(option, `${model} should be offered by a connected provider`).toBeVisible()
  await option.click()
  await expect(picker).not.toContainText('Choose a model')
}

export const WEATHER_INSTRUCTIONS =
  'You report weather. Always call the Open-Meteo forecast tool for the numbers ' +
  '(daily=temperature_2m_max, timezone=Europe/Berlin, start_date and end_date set to the day asked). ' +
  'Report exactly the value the tool returned, in °C, with one decimal. Never invent numbers.'

/** Connect Open-Meteo by link; returns the API's name (its tools are `<name>_get_v1_forecast`). API names are unique per org, so each test passes its own `what`. */
export async function connectOpenMeteo(page: Page, gate: Gate, what: string): Promise<string> {
  const apiName = gate.name(`openmeteo-${what}`)
  await connectApi(page, gate, {
    kind: /OpenAPI \/ Swagger/,
    name: apiName,
    fill: async (p) => {
      await p.getByRole('textbox', { name: 'Link to the description' }).fill(OPEN_METEO_SPEC)
    },
  })
  return apiName
}

export interface AgentSpec {
  what: string
  /** The API whose tools the agent gets (connectOpenMeteo). */
  apiName?: string
  instructions?: string
  memory?: boolean
  /** Work mode as the dropdown names it ("Cascade", "Panel", …), and one model per slot, top to bottom. */
  workMode?: { label: string; models: string[] }
}

/** Build, save and activate an autonomous agent; returns its id and name. */
export async function buildAgent(page: Page, gate: Gate, spec: AgentSpec): Promise<{ id: string; name: string }> {
  const name = gate.name(spec.what)
  await page.goto('/agents/new')
  await page.getByRole('textbox', { name: 'Agent name' }).fill(name)
  await expect(page.getByRole('button', { name: 'Autonomous' }), 'Create agent should open in Autonomous mode').toHaveAttribute('aria-pressed', 'true')
  if (spec.workMode) {
    await page.getByTestId('work-mode-select').click()
    await page.getByRole('option', { name: new RegExp(`^${escape(spec.workMode.label)}`) }).click()
    await expect(page.getByTestId('work-mode-select')).toContainText(spec.workMode.label)
    const pickers = page.getByTestId('work-mode-slots').getByRole('combobox', { name: 'Model' })
    await expect(pickers, `${spec.workMode.label} should ask for ${spec.workMode.models.length} models`).toHaveCount(spec.workMode.models.length)
    for (let i = 0; i < spec.workMode.models.length; i++) {
      await pickModel(page, pickers.nth(i), spec.workMode.models[i])
    }
  } else {
    await pickModel(page, page.getByTestId('work-mode-slots').getByRole('combobox', { name: 'Model' }), MAIN_MODEL)
  }
  await page.getByRole('textbox', { name: 'Instructions' }).fill(spec.instructions ?? WEATHER_INSTRUCTIONS)
  if (spec.memory) {
    const remember = page.getByRole('switch', { name: 'Remember between conversations' })
    await remember.click()
    await expect(remember).toBeChecked()
  }
  if (spec.apiName) {
    await page.getByRole('textbox', { name: 'Search tools' }).fill(spec.apiName)
    await page.getByRole('checkbox', { name: new RegExp(`^All tools of ${escape(spec.apiName)}`) }).check()
    await expect(page.getByText(`${spec.apiName}, all tools`)).toBeVisible()
  }
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page, 'Save should open the new agent').toHaveURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 60_000 })
  const id = idFromUrl(page)
  gate.track('agent', id)

  await page.goto(`/agents/${id}`)
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Activate', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Deactivate', exact: true })).toBeVisible()
  return { id, name }
}

/** Ask from Try it on the agent's page; resolves with the answer the page shows. */
export async function tryIt(page: Page, message: string, timeout = 240_000): Promise<string> {
  await page.getByRole('textbox', { name: 'Message' }).fill(message)
  await page.getByRole('button', { name: 'Run test' }).click()
  const answer = page.getByTestId('try-it-answer')
  const failed = page.getByRole('tabpanel', { name: 'Overview' }).getByRole('alert')
  await expect(answer.or(failed).first(), 'the agent should answer').toBeVisible({ timeout })
  if (await failed.first().isVisible()) throw new Error(`Try it failed: ${(await failed.first().innerText()).slice(0, 400)}`)
  return (await answer.innerText()).trim()
}

/** Tomorrow's date in Berlin, as Open-Meteo writes it (YYYY-MM-DD). */
export function berlinTomorrow(): string {
  const now = new Date(Date.now() + 24 * 3600_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function weatherQuestion(day = berlinTomorrow()): string {
  return (
    `What is the maximum temperature in Berlin (latitude ${BERLIN.latitude}, longitude ${BERLIN.longitude}) on ${day}? ` +
    'Use timezone Europe/Berlin. Answer with the number in °C.'
  )
}

/** Open-Meteo's own daily maximum for Berlin on `day`. */
export async function openMeteoMax(day = berlinTomorrow()): Promise<number> {
  const daily = await berlinDaily(3)
  const idx = daily.time.indexOf(day)
  expect(idx, `Open-Meteo should forecast ${day}`).toBeGreaterThanOrEqual(0)
  return daily.temperature_2m_max[idx]
}

/**
 * The answer states the temperature Open-Meteo gives, to within 0.5 °C
 * (Open-Meteo gives one decimal; an answer may round to a whole degree).
 */
export function expectTemperature(text: string, expected: number, day = berlinTomorrow()): void {
  const temps = [...text.matchAll(/(-?\d+(?:[.,]\d+)?)\s*°/g)].map((m) => Number(m[1].replace(',', '.')))
  expect(temps.length, `the answer "${text.slice(0, 400)}" should state a temperature in °`).toBeGreaterThan(0)
  for (const t of temps) {
    expect(Math.abs(t - expected), `the answer "${text.slice(0, 400)}" should give ${expected} °C (Open-Meteo, ${day})`).toBeLessThanOrEqual(0.5)
  }
}
