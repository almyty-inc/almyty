/**
 * J4: duplicate an autonomous agent from its page, and find every setting
 * of the original on the copy's settings page: its instructions, model and
 * the model's temperature and max tokens, its memory and its answer check.
 * A staging model comparison (2026-11-13) found a copy kept only its name,
 * description and graph, so a duplicated autonomous agent lost its
 * instructions and its check.
 *
 * Models come from the QA org's connected providers; nothing here holds a
 * key. GATE_MAIN_MODEL / GATE_CHECK_MODEL pick other connected models.
 */
import { test, expect } from './support/fixtures'
import { idFromUrl } from './support/flows'
import { data } from './support/qa-api'
import type { Locator, Page } from '@playwright/test'

const MAIN_MODEL = process.env.GATE_MAIN_MODEL || 'gpt-4.1-mini'
const CHECK_MODEL = process.env.GATE_CHECK_MODEL || 'claude-haiku-4-5'
const INSTRUCTIONS = 'You list new research works. Leave out what you already reported. Never invent a DOI.'

/** Pick a model in an open model picker by searching for it. */
async function pickModel(page: Page, picker: Locator, model: string): Promise<void> {
  await picker.click()
  await page.getByRole('searchbox', { name: 'Search models' }).fill(model)
  const option = page.getByRole('option', { name: new RegExp(model.replace(/[.]/g, '\\.')) }).first()
  await expect(option, `${model} should be offered by a connected provider`).toBeVisible()
  await option.click()
  await expect(picker).not.toContainText('Choose a model')
}

/** The main model's Advanced settings on an agent's settings page, opened. */
async function openMainAdvanced(page: Page): Promise<void> {
  const advanced = page.getByTestId('role-main-advanced')
  await advanced.getByRole('button', { name: /^Advanced/ }).click()
  await expect(page.locator('#role-main-max-tokens')).toBeVisible()
}

test.describe('J4 duplicate an agent', () => {
  test('J4 the copy of an autonomous agent has its instructions, model settings, memory and answer check', async ({ page, gate, qa }) => {
    // The original, built on its page.
    const agentName = gate.name('dup-source')
    await page.goto('/agents/new')
    await page.getByRole('textbox', { name: 'Agent name' }).fill(agentName)
    await expect(page.getByRole('button', { name: 'Autonomous' })).toHaveAttribute('aria-pressed', 'true')
    await pickModel(page, page.getByRole('combobox', { name: 'Model' }).first(), MAIN_MODEL)
    await openMainAdvanced(page)
    await page.locator('#role-main-temperature').fill('0.3')
    await page.locator('#role-main-max-tokens').fill('1500')
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill(INSTRUCTIONS)
    await page.getByRole('switch', { name: 'Remember between conversations' }).click()
    await expect(page.getByRole('switch', { name: 'Remember between conversations' })).toBeChecked()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 60_000 })
    const originalId = idFromUrl(page)
    gate.track('agent', originalId)

    // Its answer check: a second vendor's model.
    await page.goto(`/agents/${originalId}`)
    await expect(page.getByRole('heading', { name: agentName, level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Configure verification' }).click()
    const verify = page.getByTestId('verify-config-editor')
    await verify.getByRole('switch', { name: 'Enable verification' }).click()
    await verify.getByRole('button', { name: 'Add reviewer' }).click()
    await verify.getByRole('textbox', { name: 'Reviewer name' }).fill('gate checker')
    await pickModel(page, verify.getByRole('combobox', { name: 'Model' }), CHECK_MODEL)
    await verify.getByRole('button', { name: 'Save verification' }).click()
    await expect(page.getByTestId('verify-mode-badge')).toHaveText(/Reports only/)

    // Duplicate it: the page lands on the copy.
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click()
    await expect(page).not.toHaveURL(new RegExp(originalId), { timeout: 30_000 })
    await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/)
    const copyId = idFromUrl(page)
    gate.track('agent', copyId)
    await expect(page.getByRole('heading', { name: `Copy of ${agentName}`, level: 1 })).toBeVisible()
    // Its answer check came along.
    await expect(page.getByTestId('verify-mode-badge'), 'the copy should keep the answer check').toHaveText(/Reports only/)

    // The copy's settings page: everything the original was given.
    await page.goto(`/agents/${copyId}/edit`)
    await expect(page.getByRole('textbox', { name: 'Agent name' })).toHaveValue(`Copy of ${agentName}`)
    await expect(page.getByRole('button', { name: 'Autonomous' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue(INSTRUCTIONS)
    await expect(page.getByRole('combobox', { name: 'Model' }).first()).toContainText(MAIN_MODEL)
    await expect(page.getByRole('switch', { name: 'Remember between conversations' })).toBeChecked()
    await openMainAdvanced(page)
    await expect(page.locator('#role-main-temperature')).toHaveValue('0.3')
    await expect(page.locator('#role-main-max-tokens')).toHaveValue('1500')

    // And field by field, as stored.
    const original = await data<any>(await qa.get(`/agents/${originalId}`))
    const copy = await data<any>(await qa.get(`/agents/${copyId}`))
    for (const field of ['mode', 'instructions', 'personality', 'toolIds', 'modelConfig', 'models', 'memoryConfig', 'agentConfig', 'variables']) {
      expect(copy[field], `the copy's ${field}`).toEqual(original[field])
    }
    expect(copy.agentConfig?.verify?.checkers?.[0]?.model).toBe(CHECK_MODEL)
    expect(copy.modelConfig?.maxTokens).toBe(1500)
    expect(copy.status).toBe('draft')
  })
})
