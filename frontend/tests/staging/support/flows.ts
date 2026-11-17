/**
 * UI steps several gate tests share. Each drives the real page the way a
 * person would; none of them calls the API behind the page's back.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import type { Gate } from './fixtures'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

/** The id at the end of the current URL (`/apis/<id>`, `/tools/<id>`, …). */
export function idFromUrl(page: Page): string {
  const m = page.url().match(UUID)
  if (!m) throw new Error(`no id in ${page.url()}`)
  return m[0]
}

/**
 * An agent page's secondary actions (Export, Tech doc, Duplicate,
 * Activate, Deactivate) are buttons from the sm breakpoint up; on a phone
 * they sit behind "More agent actions". This opens the menu when it is the
 * way in and returns the action, as a button or a menu item.
 */
export async function agentAction(page: Page, name: string): Promise<Locator> {
  const more = page.getByRole('button', { name: 'More agent actions' })
  if (await more.isVisible()) {
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click()
    return page.getByRole('menuitem', { name, exact: true })
  }
  return page.getByRole('button', { name, exact: true })
}

/** Turn the agent on from its page, and see it offer Deactivate. */
export async function activateAgent(page: Page): Promise<void> {
  await (await agentAction(page, 'Activate')).click()
  await expect(await agentAction(page, 'Deactivate')).toBeVisible()
  // On a phone the check left the menu open.
  if (await page.getByRole('menu').isVisible()) await page.keyboard.press('Escape')
}

/**
 * Connect an API from APIs › Connect an API: pick the kind, fill what the
 * kind asks for, name it under Advanced, and connect. Lands on the API page
 * and registers the API for deletion.
 */
export async function connectApi(
  page: Page,
  gate: Gate,
  opts: { kind: RegExp; name: string; fill: (page: Page) => Promise<void> },
): Promise<string> {
  await page.goto('/apis/new')
  await page.getByRole('button', { name: opts.kind }).click()
  await opts.fill(page)
  const advanced = page.getByRole('button', { name: 'Advanced' })
  if ((await advanced.getAttribute('aria-expanded')) !== 'true') await advanced.click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(opts.name)
  await page.getByRole('button', { name: 'Connect API' }).click()
  await expect(page, `connecting ${opts.name} should open its API page`).toHaveURL(/\/apis\/[0-9a-f-]{36}$/, { timeout: 120_000 })
  const id = idFromUrl(page)
  gate.track('api', id)
  await expect(page.getByRole('heading', { name: opts.name, level: 1 })).toBeVisible()
  return id
}

/** From an API page, open the tool list filtered to this API through "Tools generated". */
export async function openApiTools(page: Page, apiName: string): Promise<void> {
  await page.getByRole('link', { name: new RegExp(`^Show the \\d+ tools? of ${escape(apiName)}$`) }).click()
  await expect(page).toHaveURL(/\/tools\?.*api/i)
}

/** Open a tool's Test tool tab by its page id. */
export async function openTestTool(page: Page, toolId: string): Promise<Locator> {
  await page.goto(`/tools/${toolId}`)
  await page.getByRole('tab', { name: 'Test tool' }).click()
  const panel = page.getByRole('tabpanel', { name: 'Test tool' })
  await expect(panel.getByRole('button', { name: 'Execute tool' })).toBeVisible()
  return panel
}

/**
 * A tool made by hand starts as a draft. Switch it on from its page, the
 * way a person would before testing it.
 */
export async function activateTool(page: Page): Promise<void> {
  const on = page.getByRole('switch', { name: 'Activate tool' })
  const off = page.getByRole('switch', { name: 'Deactivate tool' })
  // The status next to the switch says where the tool stands once it has loaded.
  const status = page.getByRole('main').getByText(/^(draft|active|inactive)$/i).first()
  await expect(status).toBeVisible()
  if (!/^active$/i.test((await status.innerText()).trim())) {
    await on.click()
    await expect(off).toBeVisible()
    await expect(page.getByRole('main').getByText(/^active$/i).first()).toBeVisible()
  }
}

/** Fill the Test tool form (`Enter <param>` boxes) and run it; resolves with the result the page shows. */
export async function executeTool(panel: Locator, params: Record<string, string>): Promise<'Success' | 'Error'> {
  const page = panel.page()
  for (const [key, value] of Object.entries(params)) {
    await panel.getByRole('textbox', { name: `Enter ${key}`, exact: true }).fill(value)
  }
  const answered = page.waitForResponse(
    (r) => /\/tools\/[0-9a-f-]{36}\/execute$/.test(r.url()) && r.request().method() === 'POST',
    { timeout: 180_000 },
  )
  await panel.getByRole('button', { name: 'Execute tool' }).click()
  await answered
  await expect(panel.getByRole('button', { name: 'Execute tool' })).toBeEnabled()
  const badge = panel.getByText(/^(Success|Error)$/)
  await expect(badge, 'the tool run should finish with a result').toBeVisible()
  return (await badge.innerText()).trim() as 'Success' | 'Error'
}

/** The "Response data" a successful tool test shows, read through its Copy button, parsed. */
export async function responseData(panel: Locator): Promise<any> {
  const page = panel.page()
  await expect(panel.getByText('Response data:')).toBeVisible()
  await panel.getByRole('button', { name: 'Copy' }).first().click()
  const text = await page.evaluate(() => navigator.clipboard.readText())
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
