/**
 * Building a workflow agent in the builder the way a person does: drag
 * steps from the Steps palette onto the canvas, wire them handle to
 * handle, click each step and fill its settings, Save, and run it from
 * the builder's Test panel.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import type { Gate } from './fixtures'
import { idFromUrl } from './flows'

export type StepType = 'input' | 'output' | 'tool_call' | 'transform' | 'condition' | 'llm_call'

/** Start a new agent, name it, and switch it to Workflow. */
export async function newWorkflow(page: Page, name: string): Promise<void> {
  await page.goto('/agents/new')
  await page.getByRole('textbox', { name: 'Agent name' }).fill(name)
  await page.getByRole('group', { name: 'Agent mode' }).getByRole('button', { name: 'Workflow' }).click()
  await expect(page.getByRole('button', { name: 'Workflow' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.react-flow__node-input')).toBeVisible()
}

/** A step on the canvas, by its type; `nth` picks among several of one type (in the order they were added). */
export function step(page: Page, type: StepType, nth = 0): Locator {
  return page.locator(`.react-flow__node-${type}`).nth(nth)
}

/** Drag a step from the palette onto the canvas at a fraction of its size. */
export async function dropStep(page: Page, label: string, at: { x: number; y: number }): Promise<void> {
  const pane = page.locator('.react-flow__pane')
  const box = await pane.boundingBox()
  if (!box) throw new Error('the canvas is not on screen')
  const before = await page.locator('.react-flow__node').count()
  await page
    .locator('div[draggable="true"]')
    .filter({ hasText: new RegExp(`^${label}`) })
    .dragTo(pane, { targetPosition: { x: box.width * at.x, y: box.height * at.y } })
  await expect(page.locator('.react-flow__node'), `${label} should land on the canvas`).toHaveCount(before + 1)
}

/** Click a step and delete it from its settings panel. */
export async function deleteStep(page: Page, node: Locator): Promise<void> {
  await node.click()
  await page.getByRole('button', { name: 'Delete step' }).click()
  await expect(node).toHaveCount(0)
}

/** Drag from one step's output handle (`handle`: a condition's 'true' or 'false') to another's input handle. */
export async function connect(page: Page, from: Locator, to: Locator, handle?: 'true' | 'false'): Promise<void> {
  const edges = page.locator('.react-flow__edge')
  const before = await edges.count()
  const source = handle ? from.locator(`.react-flow__handle.source[data-handleid="${handle}"]`) : from.locator('.react-flow__handle.source')
  await source.dragTo(to.locator('.react-flow__handle.target'))
  await expect(edges, 'dragging handle to handle should draw an edge').toHaveCount(before + 1)
}

/** Open a step's settings; returns its step id (shown under Advanced). */
export async function openStep(page: Page, node: Locator): Promise<string> {
  await node.click()
  const advanced = page.getByTestId('step-advanced')
  await expect(advanced).toBeVisible()
  if (!(await page.getByTestId('step-id').isVisible())) await advanced.getByRole('button').first().click()
  return (await page.getByTestId('step-id').innerText()).trim()
}

/** Turn on "Edit values as text" in the open step's Advanced section. */
export async function editAsText(page: Page): Promise<void> {
  const sw = page.getByRole('switch', { name: 'Edit values as text' })
  if (!(await sw.isVisible())) await page.getByTestId('step-advanced').getByRole('button').first().click()
  if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
}

/** In the open Tool call step: pick the tool by what the picker shows for it, or by its exact name (`title`). */
export async function pickTool(page: Page, by: { label?: string; name?: string }): Promise<void> {
  await page.locator('#tool-step-tool').click()
  const option = by.name ? page.locator(`[role="option"][title="${by.name}"]`) : page.getByRole('option', { name: by.label!, exact: true })
  await expect(option, `the tool picker should offer ${by.name || by.label}`).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(page.getByTestId('tool-step-inputs')).toBeVisible()
}

/** In the open Tool call step: say where a tool input comes from. */
export async function toolInput(page: Page, param: string, source: 'Ask the user' | 'Fixed value', value?: string): Promise<void> {
  await page.getByRole('combobox', { name: `Where ${param} comes from` }).click()
  await page.getByRole('option', { name: source, exact: true }).click()
  if (source === 'Fixed value') await page.getByRole('textbox', { name: `${param} value` }).fill(value ?? '')
}

/** Save a new agent from the builder; registers it for deletion and returns its id. */
export async function saveNewAgent(page: Page, gate: Gate): Promise<string> {
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await expect(save, 'Save should be enabled once every step is set up').toBeEnabled()
  await save.click()
  await expect(page, 'saving a new agent should open it in the builder').toHaveURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 60_000 })
  const id = idFromUrl(page)
  gate.track('agent', id)
  return id
}

/** Run the saved workflow from the builder's Test panel with this input; resolves with the run the panel shows. */
export async function runFromTestPanel(page: Page, input: Record<string, unknown>, timeout = 180_000): Promise<any> {
  await page.getByRole('button', { name: /^Test$/ }).click()
  await expect(page.getByText('Test agent', { exact: true })).toBeVisible()
  const editor = page.getByText('Input JSON', { exact: true }).locator('xpath=..').locator('.cm-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(JSON.stringify(input))
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  const shown = page.locator('pre[role="status"], pre[role="alert"]').filter({ hasNotText: 'Run the agent to see output' })
  await expect(shown, 'the Test panel should show the run').toBeVisible({ timeout })
  const text = (await shown.innerText()).trim()
  if (text.startsWith('Error:')) return { status: 'error', error: text }
  return JSON.parse(text)
}
