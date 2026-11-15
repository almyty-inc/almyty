/**
 * J10: how an autonomous agent works. Memory carries a fact from one
 * conversation to the next, and every work mode (Cascade, Best of N,
 * Panel, Explore/extract/patch) runs a real question to completion with
 * the answer checked against Open-Meteo at the same moment.
 *
 * Models are the QA org's connected providers; nothing here holds a key.
 */
import { test, expect } from './support/fixtures'
import {
  CHECK_MODEL,
  MAIN_MODEL,
  buildAgent,
  connectOpenMeteo,
  expectTemperature,
  openMeteoMax,
  tryIt,
  weatherQuestion,
} from './support/weather-agent'
import type { Page } from '@playwright/test'

/**
 * Open the agent's run that ran in work mode `label` (its "Cost by role"
 * table is headed with the mode) and wait for it to say completed;
 * returns the run's text. A mode that runs helpers as runs of their own
 * (the explorers) lists those too, each headed "Single".
 */
async function runInMode(page: Page, agentId: string, label: string): Promise<string> {
  const rows = page.getByRole('row', { name: /^Open the run of/ })
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  const count = await rows.count()
  const seen: string[] = []
  for (let i = 0; i < count; i++) {
    await page.goto(`/agents/${agentId}`)
    await page.getByRole('row', { name: /^Open the run of/ }).nth(i).click()
    await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}/)
    const runs = page.getByRole('tabpanel', { name: 'Runs' })
    await expect(runs.getByRole('heading', { name: 'Steps' })).toBeVisible({ timeout: 60_000 })
    const text = (await runs.innerText()).replace(/\s+/g, ' ')
    const mode = text.match(/Cost by role\s*(.+?) Role Purpose/)?.[1] ?? '?'
    seen.push(mode)
    if (mode === label) {
      await expect(runs.getByText(/^completed$/).first(), `the ${label} run should complete`).toBeVisible({ timeout: 60_000 })
      return text
    }
  }
  throw new Error(`no run of the agent ran in work mode ${label}; its runs ran in: ${seen.join(', ')}`)
}

test.describe('J10 memory', () => {
  test('J10 an agent with memory recalls in a new conversation what it was told in the last', async ({ page, gate }) => {
    const code = String(100000 + Math.floor(Math.random() * 900000))
    await buildAgent(page, gate, {
      what: 'memory-agent',
      memory: true,
      instructions:
        'You are a personal assistant. When the user tells you a fact about themselves, remember it. ' +
        'When asked about it later, answer with the remembered fact exactly.',
    })
    // Run 1 tells it; each Try it run is its own conversation.
    await tryIt(page, `Please remember this for later: my locker code is ${code}.`)
    // Memory is written after the run; give it a moment to land before asking.
    await page.waitForTimeout(5_000)
    const recall = await tryIt(page, 'What is my locker code?')
    expect(recall, `the second conversation should recall the locker code ${code}`).toContain(code)
  })
})

/**
 * Each work mode, with one model per slot top to bottom (two vendors where
 * the mode compares), and the step that only that mode takes.
 */
const MODES: { key: string; label: string; models: string[]; shape: RegExp }[] = [
  // Drafter, Checker, Main: the checker checks the draft.
  { key: 'cascade', label: 'Cascade', models: [MAIN_MODEL, CHECK_MODEL, MAIN_MODEL], shape: /#\d+ verify/ },
  // Main, Checker: the main model writes candidates, the checker picks one.
  { key: 'best_of_n', label: 'Best of N', models: [MAIN_MODEL, CHECK_MODEL], shape: /Candidate 2 .*#\d+ judge .*Picked candidate \d of \d/ },
  // Main, Panelist 1, Panelist 2: each panelist answers, then one answer is judged from all.
  { key: 'panel', label: 'Panel', models: [MAIN_MODEL, MAIN_MODEL, CHECK_MODEL], shape: /Panel answer.*Panel answer.*#\d+ judge .*Judged a panel of \d/ },
  // Explorer, Summariser, Main, Checker: explore, a brief, then the main model's answer checked.
  { key: 'explore_extract_patch', label: 'Explore, extract, patch', models: [MAIN_MODEL, CHECK_MODEL, MAIN_MODEL, CHECK_MODEL], shape: /#\d+ explore .*#\d+ extract_context .*#\d+ verify/ },
]

test.describe('J10 work modes', () => {
  for (const mode of MODES) {
    test(`J10 work mode ${mode.label} answers from Open-Meteo and completes`, async ({ page, gate }) => {
      const apiName = await connectOpenMeteo(page, gate, mode.key)
      const agent = await buildAgent(page, gate, { what: `mode-${mode.key}`, apiName, workMode: { label: mode.label, models: mode.models } })
      const [answer, expected] = await Promise.all([tryIt(page, weatherQuestion(), 300_000), openMeteoMax()])
      expectTemperature(answer, expected)
      const run = await runInMode(page, agent.id, mode.label)
      expect(run, `the run should show the ${mode.label} shape`).toMatch(mode.shape)
    })
  }
})