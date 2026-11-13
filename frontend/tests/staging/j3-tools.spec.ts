/**
 * J3/J5: tools made by hand. An HTTP tool against the npm registry, a
 * JavaScript tool in the sandbox, and an outside MCP server (DeepWiki) as
 * a tool source. Each is created through Create tool / Add MCP server and
 * then run through Test tool.
 */
import { test, expect, type Gate } from './support/fixtures'
import { activateTool, executeTool, idFromUrl, openTestTool, responseData } from './support/flows'
import type { Page } from '@playwright/test'

/** Add one required string parameter on the Create tool form. */
async function addProperty(page: Page, name: string): Promise<void> {
  const names = page.getByRole('textbox', { name: 'Property name' })
  const before = await names.count()
  if (before === 0) await page.getByRole('button', { name: 'Add first property' }).click()
  else await page.getByRole('button', { name: 'Add property' }).click()
  await expect(names).toHaveCount(before + 1)
  await names.nth(before).fill(name)
  await expect(names.nth(before)).toHaveValue(name)
  await page.getByRole('switch', { name: 'Required' }).nth(before).click()
}

async function createTool(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Create tool' }).click()
  await expect(page, 'Create tool should open the new tool').toHaveURL(/\/tools\/[0-9a-f-]{36}/, { timeout: 60_000 })
  return idFromUrl(page)
}

test.describe('J3 tools made by hand', () => {
  test('J3 HTTP tool calls the npm registry and returns the live version', async ({ page, gate }) => {
    const name = gate.ident('npm_latest')
    await page.goto('/tools/new')
    await page.getByRole('textbox', { name: 'Tool name' }).fill(name)
    await page.getByRole('textbox', { name: 'Description' }).first().fill('Latest published version of an npm package')
    await page.getByRole('textbox', { name: 'URL' }).fill('https://registry.npmjs.org/{pkg}/latest')
    await addProperty(page, 'pkg')
    const toolId = await createTool(page)
    gate.track('tool', toolId)
    await activateTool(page)

    const direct = await (await fetch('https://registry.npmjs.org/slugify/latest')).json()
    const panel = await openTestTool(page, toolId)
    expect(await executeTool(panel, { pkg: 'slugify' }), 'the registry call should succeed').toBe('Success')
    const shown = JSON.stringify(await responseData(panel))
    expect(shown).toContain('"name":"slugify"')
    expect(shown).toContain(`"version":"${direct.version}"`)

    // A package that does not exist is a 404 upstream, and the page says Error.
    expect(await executeTool(panel, { pkg: `gate-${gate.runId}-no-such-package` })).toBe('Error')
    await expect(panel.getByText(/HTTP Status:\s*404/)).toBeVisible()
  })

  /** Make a JavaScript tool with one parameter `n`, run it with n = 7, and return what it showed. */
  async function runJsTool(page: Page, gate: Gate, what: string, read: string): Promise<{ outcome: string; shown: string }> {
    await page.goto('/tools/new')
    await page.getByRole('combobox', { name: 'Execution method' }).click()
    await page.getByRole('option', { name: 'Custom JavaScript' }).click()
    await page.getByRole('textbox', { name: 'Tool name' }).fill(gate.ident(what))
    await page.getByRole('textbox', { name: 'Description' }).first().fill('Square and double of a number')
    await addProperty(page, 'n')
    const script = `const v = Number(${read}); return { square: v * v, double: v * 2, runId: "${gate.runId}" }`
    // The code editor (CodeMirror): select what is there and type over it.
    const code = page.locator('.cm-content').first()
    await code.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Delete')
    await page.keyboard.insertText(script)
    await expect(code).toContainText(`Number(${read})`)
    const toolId = await createTool(page)
    gate.track('tool', toolId)
    await activateTool(page)

    const panel = await openTestTool(page, toolId)
    const outcome = await executeTool(panel, { n: '7' })
    const shown = outcome === 'Success' ? JSON.stringify(await responseData(panel)) : await panel.innerText()
    return { outcome, shown }
  }

  test('J3 JavaScript tool runs in the sandbox and returns its result', async ({ page, gate }) => {
    const { outcome, shown } = await runJsTool(page, gate, 'js_math', 'parameters.n')
    expect(outcome, `the sandboxed script should succeed: ${shown.slice(0, 300)}`).toBe('Success')
    expect(shown).toContain('"square":49')
    expect(shown).toContain('"double":14')
    expect(shown).toContain(gate.runId)
  })

  test('J3 JavaScript tool reads a parameter the way the form says (directly as its name)', async ({ page, gate }) => {
    // The form: "Access via params.name or directly as name".
    // (tool-form.tsx shows this hint above the code editor.)
    const { outcome, shown } = await runJsTool(page, gate, 'js_direct', 'n')
    expect(outcome, `code using the parameter by name should run: ${shown.slice(0, 300)}`).toBe('Success')
    expect(shown).toContain('"square":49')
  })

  test('J3 Create tool: adding a second parameter does not submit the form', async ({ page, gate, qa, org }) => {
    const name = gate.ident('two_params')
    await page.goto('/tools/new')
    await page.getByRole('combobox', { name: 'Execution method' }).click()
    await page.getByRole('option', { name: 'Custom JavaScript' }).click()
    await page.getByRole('textbox', { name: 'Tool name' }).fill(name)
    await page.getByRole('textbox', { name: 'Description' }).first().fill('Two parameters')
    await addProperty(page, 'a')
    try {
      // Still on the form, with a second empty row to name.
      await page.getByRole('button', { name: 'Add property' }).click()
      await expect(page, '"Add property" must not create the tool').toHaveURL(/\/tools\/new/)
      await expect(page.getByRole('textbox', { name: 'Property name' })).toHaveCount(2)
    } finally {
      // If the click did create a tool, remove it.
      const found = (await (await qa.get(`/organizations/${org.id}/tools?search=${name}`)).json()).data?.tools || []
      for (const t of found) gate.track('tool', t.id)
    }
  })

  test('J3 MCP server as a tool source (DeepWiki): discovered tools run', async ({ page, gate }) => {
    const name = gate.ident('deepwiki')
    await page.goto('/tools/mcp-servers/new')
    await page.getByRole('textbox', { name: 'Name' }).fill(name)
    await page.getByRole('textbox', { name: 'Server URL' }).fill('https://mcp.deepwiki.com/mcp')
    const created = page.waitForResponse((r) => /\/mcp-sources$/.test(r.url()) && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Add server' }).click()
    const res = await created
    expect(res.ok(), `adding the MCP server answered ${res.status()}`).toBeTruthy()
    const body = (await res.json()).data
    const sourceId = body?.source?.id ?? body?.id
    expect(sourceId, 'adding the server should return the new source').toBeTruthy()
    gate.track('mcp-source', sourceId)

    // Its tools are discovered and listed under the server's name.
    await page.goto(`/tools?search=${name}`)
    const row = page.getByRole('row', { name: new RegExp(`^Select ${name}\\S*read_wiki_structure `) })
    await expect(row, 'DeepWiki\'s read_wiki_structure should be discovered').toBeVisible({ timeout: 60_000 })
    await row.locator('td').nth(1).click()
    await expect(page).toHaveURL(/\/tools\/[0-9a-f-]{36}/)
    const panel = await openTestTool(page, idFromUrl(page))
    expect(await executeTool(panel, { repoName: 'microsoft/playwright' }), 'read_wiki_structure should succeed').toBe('Success')
    // DeepWiki's real table of contents for the repo.
    const shown = JSON.stringify(await responseData(panel)).toLowerCase()
    expect(shown).toContain('playwright')
    expect(shown.length).toBeGreaterThan(200)
  })
})
