/**
 * J7/J8: a workflow agent built in the builder from steps that need no
 * model: Input → Tool call (an HTTP tool to the npm registry) → Transform
 * → Condition → Output (yes) / Output (no). It runs from the builder's
 * Test panel and must answer with what the npm registry says at that
 * moment. Then it runs on a one-minute schedule: the scheduled run has to
 * come when the schedule said it would, and turning the schedule off has
 * to stop it.
 */
import { test, expect, type Gate } from './support/fixtures'
import { idFromUrl } from './support/flows'
import { data } from './support/qa-api'
import {
  connect,
  deleteStep,
  dropStep,
  editAsText,
  newWorkflow,
  openStep,
  pickTool,
  runFromTestPanel,
  saveNewAgent,
  step,
  toolInput,
} from './support/workflow'
import type { APIRequestContext, Page } from '@playwright/test'

const PKG = 'slugify'

/** What the npm registry says the latest version of a package is, read by the test itself. */
async function npmLatest(pkg: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`)
  if (!res.ok) throw new Error(`the npm registry answered ${res.status}`)
  return (await res.json()).version
}

/**
 * Create tool: an HTTP GET to the npm registry with one required input,
 * `pkg`. `tag` keeps its name apart from other tests' tools in the same
 * run (tool names are unique in the org). Returns the picker label.
 */
async function makeNpmTool(page: Page, gate: Gate, tag: string): Promise<string> {
  const label = `${gate.name(`${tag}-npm`)} latest npm version`
  await page.goto('/tools/new')
  await page.getByRole('textbox', { name: 'Tool name' }).fill(gate.ident(`${tag}_npm`))
  await page.getByRole('textbox', { name: 'Description' }).first().fill(label)
  await page.getByRole('textbox', { name: 'URL' }).fill('https://registry.npmjs.org/{pkg}/latest')
  await page.getByRole('button', { name: 'Add first property' }).click()
  await page.getByRole('textbox', { name: 'Property name' }).first().fill('pkg')
  await page.getByRole('switch', { name: 'Required' }).first().click()
  await page.getByRole('button', { name: 'Create tool' }).click()
  await expect(page, 'Create tool should open the new tool').toHaveURL(/\/tools\/[0-9a-f-]{36}/, { timeout: 60_000 })
  gate.track('tool', idFromUrl(page))
  const status = page.getByRole('main').getByText(/^(draft|active|inactive)$/i).first()
  await expect(status).toBeVisible()
  if (!/^active$/i.test((await status.innerText()).trim())) {
    await page.getByRole('switch', { name: 'Activate tool' }).click()
    await expect(page.getByRole('switch', { name: 'Deactivate tool' })).toBeVisible()
  }
  return label
}

/**
 * Build Input → Tool call → Transform → Condition → Output/Output in the
 * builder and save it. The yes path answers `<name>@<version>`; the no
 * path answers "not <pkg>: …". Returns the agent id.
 */
async function buildNpmWorkflow(page: Page, gate: Gate, tag: string): Promise<{ agentId: string; name: string; ids: Record<string, string> }> {
  const toolLabel = await makeNpmTool(page, gate, tag)
  const name = gate.name(`${tag}-workflow`)
  await newWorkflow(page, name)
  // The new workflow starts with a Model call; this one uses no model.
  await deleteStep(page, step(page, 'llm_call'))
  await dropStep(page, 'Tool call', { x: 0.3, y: 0.25 })
  await dropStep(page, 'Transform', { x: 0.45, y: 0.65 })
  await dropStep(page, 'Condition', { x: 0.62, y: 0.25 })
  await dropStep(page, 'Output', { x: 0.8, y: 0.8 })
  const input = step(page, 'input')
  const tool = step(page, 'tool_call')
  const transform = step(page, 'transform')
  const condition = step(page, 'condition')
  const yes = page.locator('.react-flow__node-output[data-id="output_1"]')
  const no = page.locator('.react-flow__node-output:not([data-id="output_1"])')
  await connect(page, input, tool)
  await connect(page, tool, transform)
  await connect(page, transform, condition)
  await connect(page, condition, yes, 'true')
  await connect(page, condition, no, 'false')

  // Tool call: the npm tool, its package asked when the run starts.
  const toolId = await openStep(page, tool)
  await pickTool(page, { label: toolLabel })
  await toolInput(page, 'pkg', 'Ask the user')
  // Input: only the package (the message it started with is not used).
  await openStep(page, input)
  await expect(page.getByRole('textbox', { name: 'Field 2 name' })).toHaveValue('pkg')
  await page.getByRole('button', { name: 'Remove field 1' }).click()
  await expect(page.getByRole('textbox', { name: 'Field 1 name' })).toHaveValue('pkg')
  // Transform: "<name>@<version>" from what the registry returned.
  const transformId = await openStep(page, transform)
  await editAsText(page)
  await page.locator('#transform-expr').fill(`{{nodes.${toolId}.output.name}}@{{nodes.${toolId}.output.version}}`)
  // Condition: the registry answered for the package that was asked for.
  const conditionId = await openStep(page, condition)
  await editAsText(page)
  const expr = page.locator('.cm-content').last()
  await expr.click()
  await page.keyboard.insertText(`{{nodes.${toolId}.output.name}} === '${PKG}'`)
  await expect(expr).toContainText(`=== '${PKG}'`)
  // Outputs.
  const yesId = await openStep(page, yes)
  await editAsText(page)
  await page.locator('#output-mapping').fill(`{{nodes.${transformId}.output}}`)
  const noId = await openStep(page, no)
  await editAsText(page)
  await page.locator('#output-mapping').fill(`not ${PKG}: {{nodes.${transformId}.output}}`)
  await page.getByRole('button', { name: 'Close step settings' }).click()
  await expect(page.getByText('To finish:'), 'nothing should be left to finish').toHaveCount(0)

  const agentId = await saveNewAgent(page, gate)
  return { agentId, name, ids: { toolId, transformId, conditionId, yesId, noId } }
}

/** The agent's workflow runs, newest first, read back as the QA user. */
async function executions(qa: APIRequestContext, agentId: string): Promise<any[]> {
  const body = await data<any>(await qa.get(`/agents/${agentId}/executions?limit=20`))
  const rows = Array.isArray(body) ? body : body?.items || body?.executions || body?.data || []
  return [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

test.describe('J7/J8 workflow agent without a model', () => {
  test('J7 workflow built in the builder (tool call, transform, condition) answers from the npm registry', async ({ page, gate }) => {
    const { ids } = await buildNpmWorkflow(page, gate, 'wf-run')

    const [run, version] = await Promise.all([runFromTestPanel(page, { pkg: PKG }), npmLatest(PKG)])
    expect(run.status, `the run should complete: ${JSON.stringify(run).slice(0, 400)}`).toBe('completed')
    expect(run.output, 'the answer is the registry\'s name@version, through the yes path').toBe(`${PKG}@${version}`)
    const steps = run.nodeResults || {}
    expect(steps[ids.toolId]?.output?.version, 'the tool call returned what the registry says').toBe(version)
    expect(steps[ids.conditionId]?.output?.result, 'the condition took the yes path').toBe(true)
    expect(steps[ids.noId]?.skipped, 'the no path did not run').toBe(true)
  })

  test('J8 a one-minute schedule runs the workflow on time, and turning it off stops it', async ({ page, gate, qa }) => {
    test.setTimeout(12 * 60_000)
    const { agentId, name } = await buildNpmWorkflow(page, gate, 'wf-sched')
    // If the test stops half way, the agent's deletion takes its schedule with it.

    await page.goto(`/agents/${agentId}`)
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
    await page.getByRole('button', { name: 'Activate', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Deactivate', exact: true })).toBeVisible()

    // Set up a schedule: every 1 minute, given the package.
    await page.getByRole('link', { name: 'Set up a schedule' }).click()
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/schedule`))
    await page.locator('#schedule-kind').click()
    await page.getByRole('option', { name: 'Every few minutes or hours' }).click()
    await page.locator('input#schedule-every').fill('1')
    await page.getByRole('combobox', { name: 'Unit' }).click()
    await page.getByRole('option', { name: 'minutes', exact: true }).click()
    await expect(page.getByTestId('schedule-summary')).toContainText(/minute/i)
    const input = page.locator('.cm-content').last()
    await input.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Delete')
    await page.keyboard.insertText(JSON.stringify({ pkg: PKG }))
    await page.getByRole('button', { name: 'Save schedule' }).click()
    await expect(page, 'saving the schedule should go back to the agent').toHaveURL(new RegExp(`/agents/${agentId}$`))
    const savedAt = Date.now()

    // The agent page says when it runs next.
    await expect(page.getByTestId('schedule-card-summary')).not.toContainText(/^Off:/)
    await expect(page.getByTestId('schedule-card-next-run'), 'the schedule card should say when it runs next').toBeVisible()
    const view = await data<any>(await qa.get(`/agents/${agentId}/schedule`))
    expect(view.nextRunAt, 'the server should know the next run').toBeTruthy()
    const due = Date.parse(view.nextRunAt)
    expect(due - savedAt, 'a one-minute schedule runs within the next minute').toBeLessThanOrEqual(65_000)

    // Wait for the scheduled run on the agent's Runs tab.
    const version = await npmLatest(PKG)
    let scheduled: any
    await expect(async () => {
      await page.reload()
      await page.getByRole('tab', { name: 'Runs' }).click()
      const rows = page.getByRole('tabpanel', { name: 'Runs' }).locator('[data-testid^="execution-row-"]')
      await expect(rows.first()).toBeVisible({ timeout: 10_000 })
      scheduled = (await executions(qa, agentId)).find((e) => e.metadata?.triggerType === 'scheduled')
      expect(scheduled, 'a scheduled run should appear').toBeTruthy()
      await expect(page.getByTestId(`execution-row-${scheduled.id}`)).toBeVisible()
    }).toPass({ timeout: 4 * 60_000, intervals: [10_000] })

    // On time: started within 30 s of when the schedule said, and it answered.
    const started = Date.parse(scheduled.createdAt)
    expect(Math.abs(started - due), `the scheduled run started at ${scheduled.createdAt}; it was due at ${view.nextRunAt}`).toBeLessThanOrEqual(30_000)
    await expect.poll(async () => (await executions(qa, agentId)).find((e) => e.id === scheduled.id)?.status, { timeout: 60_000 }).toBe('completed')
    const done = (await executions(qa, agentId)).find((e) => e.id === scheduled.id)
    expect(done.output, 'the scheduled run answers from the registry too').toBe(`${PKG}@${version}`)

    // Turn the schedule off on the agent page; no scheduled run comes after.
    await page.reload()
    await page.locator('#schedule-toggle').click()
    await expect(page.getByTestId('schedule-card-summary')).toContainText(/^Off:/)
    const offAt = Date.now()
    const after = await data<any>(await qa.get(`/agents/${agentId}/schedule`))
    expect(after.nextRunAt, 'a schedule that is off has no next run').toBeFalsy()
    await page.waitForTimeout(75_000)
    const late = (await executions(qa, agentId)).filter((e) => e.metadata?.triggerType === 'scheduled' && Date.parse(e.createdAt) > offAt + 2_000)
    expect(late.map((e) => e.createdAt), 'no scheduled run after the schedule was turned off').toEqual([])
  })
})
