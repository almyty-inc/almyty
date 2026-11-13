/**
 * J6: gateways, served to real clients.
 *
 * Each test makes an HTTP tool by hand (the npm registry's "latest" for a
 * package), puts it behind a gateway made in Create gateway, and calls it
 * the way that protocol's client would:
 *
 * - MCP: the official MCP TypeScript SDK client (@modelcontextprotocol/client)
 *   against staging, signing in with OAuth 2.1 (discovery, dynamic client
 *   registration, PKCE). The authorization URL opens in a browser signed in
 *   as the QA user, who approves on the consent page; the redirect lands on
 *   a local callback server.
 * - UTCP: the gateway's manual, fetched with the access key Create gateway
 *   shows once, and the tool called through the call template the manual gives.
 * - Skills: `almyty skills install` into a throwaway directory, then the
 *   call the installed SKILL.md documents.
 *
 * Every answer is checked against the npm registry, read by the test at
 * the same moment.
 */
import { spawnSync } from 'child_process'
import { createServer, type Server } from 'http'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { AddressInfo } from 'net'
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client'
import { test, expect, type Gate } from './support/fixtures'
import { activateTool, idFromUrl } from './support/flows'
import { cliSession, runCli, throwawayHome } from './support/cli'
import { QA_STATE_FILE } from './support/env'
import type { Browser, Page } from '@playwright/test'

const PKG = 'slugify'

/** What the npm registry says the latest version of a package is, right now. */
async function npmLatest(pkg = PKG): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`)
  if (!res.ok) throw new Error(`npm registry answered ${res.status}`)
  return (await res.json()).version
}

/** Make the npm-registry HTTP tool through Create tool and switch it on. */
async function makeNpmTool(page: Page, gate: Gate, what: string): Promise<{ id: string; name: string }> {
  const name = gate.ident(what)
  await page.goto('/tools/new')
  await page.getByRole('textbox', { name: 'Tool name' }).fill(name)
  await page.getByRole('textbox', { name: 'Description' }).first().fill('Latest published version of an npm package')
  await page.getByRole('textbox', { name: 'URL' }).fill('https://registry.npmjs.org/{pkg}/latest')
  await page.getByRole('button', { name: 'Add first property' }).click()
  await page.getByRole('textbox', { name: 'Property name' }).first().fill('pkg')
  await page.getByRole('switch', { name: 'Required' }).first().click()
  await page.getByRole('button', { name: 'Create tool' }).click()
  await expect(page, 'Create tool should open the new tool').toHaveURL(/\/tools\/[0-9a-f-]{36}/, { timeout: 60_000 })
  const id = idFromUrl(page)
  gate.track('tool', id)
  await activateTool(page)
  return { id, name }
}

/**
 * Create gateway: pick the protocol, the one tool, a name and who can use
 * it. Lands on the gateway page; returns its id and the address it shows.
 */
async function createGateway(
  page: Page,
  gate: Gate,
  opts: { protocol: 'MCP' | 'UTCP' | 'Skills'; toolId: string; toolName: string; name: string; access?: string },
): Promise<{ id: string; address: string }> {
  await page.goto('/gateways/new')
  await page.getByTestId(`gateway-protocol-${opts.protocol.toLowerCase()}`).click()
  await expect(page.getByTestId(`gateway-protocol-${opts.protocol.toLowerCase()}`)).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('textbox', { name: 'Search APIs and tools' }).fill(opts.toolName)
  const box = page.locator(`#share-tool-${opts.toolId}`)
  await expect(box, 'the new tool should be offered').toBeVisible({ timeout: 30_000 })
  await box.click()
  await expect(box).toHaveAttribute('data-state', 'checked')
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(opts.name)
  if (opts.access) await page.getByRole('radio', { name: new RegExp(`^${opts.access}`) }).click()
  await page.getByRole('button', { name: 'Create gateway' }).click()
  await expect(page, 'Create gateway should open the new gateway').toHaveURL(/\/gateways\/[0-9a-f-]{36}$/, { timeout: 60_000 })
  const id = idFromUrl(page)
  gate.track('gateway', id)
  await expect(page.getByRole('heading', { name: opts.name, level: 1 })).toBeVisible()
  const snippets = page.getByTestId('connect-snippets')
  const address = opts.protocol === 'Skills' ? '' : (await snippets.getByTestId('copy-field-value').first().innerText()).trim()
  return { id, address }
}

/** The JSON a tool result carries, whichever way the server wrapped it. */
function versionIn(text: string): string | undefined {
  return text.match(/"version"\s*:\s*"([^"]+)"/)?.[1]
}

/**
 * An OAuth client for one MCP server, the way a desktop MCP client is one:
 * it registers itself, keeps its tokens in memory, and sends the person to
 * the authorization URL (here: a browser signed in as the QA user).
 */
class GateOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL
  private info?: any
  private saved?: any
  private verifier = ''
  constructor(private readonly redirect: string, private readonly clientName: string) {}
  get redirectUrl() {
    return this.redirect
  }
  get clientMetadata() {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    } as any
  }
  clientInformation() {
    return this.info
  }
  saveClientInformation(info: any) {
    this.info = info
  }
  tokens() {
    return this.saved
  }
  saveTokens(tokens: any) {
    this.saved = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(v: string) {
    this.verifier = v
  }
  codeVerifier() {
    return this.verifier
  }
  // Kept with the verifier, so the callback leg is checked against the
  // authorization server the client started with (SEP-2352).
  private discovery?: any
  saveDiscoveryState(state: any) {
    this.discovery = state
  }
  discoveryState() {
    return this.discovery
  }
}

/** A local redirect target that resolves with what the authorization response carried. */
type Callback = { code?: string; error?: string; params: URLSearchParams }
async function callbackServer(): Promise<{ url: string; result: Promise<Callback>; server: Server }> {
  let resolve!: (v: Callback) => void
  const result = new Promise<Callback>((r) => (resolve = r))
  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    if (u.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>Signed in. You can close this window.</p>')
    resolve({ code: u.searchParams.get('code') || undefined, error: u.searchParams.get('error') || undefined, params: u.searchParams })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/callback`, result, server }
}

/** Open the authorization URL as the QA user and approve on the consent page. */
async function approveInBrowser(browser: Browser, authorizationUrl: URL): Promise<void> {
  const context = await browser.newContext({ storageState: QA_STATE_FILE })
  try {
    const page = await context.newPage()
    await page.goto(authorizationUrl.toString())
    await expect(page.getByText('Authorize access')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Approve' }).click()
    await page.waitForURL(/127\.0\.0\.1:\d+\/callback/, { timeout: 30_000 })
  } finally {
    await context.close()
  }
}

/** Every file under a directory, relative paths. */
function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, base))
    else out.push(p.slice(base.length + 1))
  }
  return out
}

test.describe('J6 gateways served to real clients', () => {
  test('J6 MCP gateway: the MCP SDK client signs in with OAuth, lists and calls the tool', async ({ page, browser, gate }) => {
    const tool = await makeNpmTool(page, gate, 'mcp_npm')
    const gw = await createGateway(page, gate, { protocol: 'MCP', toolId: tool.id, toolName: tool.name, name: gate.name('mcp') })
    expect(gw.address, 'the gateway page should show its address').toMatch(/^https:\/\//)

    // The client: unauthenticated at first, so the server sends it to sign in.
    const cb = await callbackServer()
    gate.defer('close the OAuth callback server', () => new Promise<void>((r) => cb.server.close(() => r())))
    const provider = new GateOAuthProvider(cb.url, gate.name('mcp-client'))
    const serverUrl = new URL(gw.address)
    let transport = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider })
    let client = new Client({ name: gate.name('mcp-client'), version: '1.0.0' })
    const first = await client.connect(transport).then(() => null, (err) => err)
    expect(first, 'an org-only gateway should ask an anonymous client to sign in').toBeInstanceOf(UnauthorizedError)
    expect(provider.authorizationUrl, 'the SDK should have found where to sign in').toBeTruthy()
    expect(provider.clientInformation()?.client_id, 'the SDK should have registered itself (DCR)').toBeTruthy()
    expect(provider.authorizationUrl!.searchParams.get('code_challenge_method')).toBe('S256')

    // The person approves in the browser; the redirect brings the code back.
    await approveInBrowser(browser, provider.authorizationUrl!)
    const { code, error, params } = await cb.result
    expect(error, 'the consent page should not deny').toBeUndefined()
    expect(code, 'the redirect should carry an authorization code').toBeTruthy()
    expect(params.get('state'), 'the redirect should return the state the client sent').toBe(provider.authorizationUrl!.searchParams.get('state'))
    // The whole callback, as a client hands it over: the SDK checks `iss` (RFC 9207) before redeeming the code.
    await transport.finishAuth(params)
    expect(provider.tokens()?.access_token, 'the code should be exchanged for a token').toBeTruthy()
    await transport.close().catch(() => {})

    // Signed in: connect again, list, call.
    transport = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider })
    client = new Client({ name: gate.name('mcp-client'), version: '1.0.0' })
    await client.connect(transport)
    gate.defer('close the MCP client', () => client.close())
    const { tools } = await client.listTools()
    const listed = tools.find((t) => t.name === tool.name)
    expect(listed, `tools/list should list ${tool.name} (got ${tools.map((t) => t.name).join(', ')})`).toBeTruthy()
    expect(JSON.stringify(listed!.inputSchema)).toContain('pkg')

    const [result, expected] = await Promise.all([client.callTool({ name: tool.name, arguments: { pkg: PKG } }), npmLatest()])
    const text = JSON.stringify(result.structuredContent ?? '') + (result.content as any[]).map((c) => c.text ?? '').join('\n')
    expect(result.isError, `tools/call should succeed: ${text.slice(0, 300)}`).toBeFalsy()
    expect(text).toContain(PKG)
    expect(versionIn(text.replace(/\\"/g, '"')), `the tool should return npm's latest ${PKG} (${expected})`).toBe(expected)
  })

  test('J6 UTCP gateway: the manual lists the tool and its call template runs it', async ({ page, gate }) => {
    const tool = await makeNpmTool(page, gate, 'utcp_npm')
    const gw = await createGateway(page, gate, {
      protocol: 'UTCP',
      toolId: tool.id,
      toolName: tool.name,
      name: gate.name('utcp'),
      access: 'Outside, protected',
    })
    // The access key is shown once, on this page.
    const key = (await page.getByTestId('initial-api-key').getByTestId('copy-field-value').innerText()).trim()
    expect(key.length, 'Create gateway should show the access key once').toBeGreaterThan(10)
    // The UTCP snippet: `curl -H "x-api-key: <key>" <address>/manual`.
    const snippet = await page.getByTestId('snippet-utcp').innerText().catch(async () => {
      await page.getByRole('tab', { name: 'UTCP' }).click()
      return page.getByTestId('snippet-utcp').innerText()
    })
    const manualUrl = snippet.match(/https:\/\/\S+\/manual/)?.[0]
    expect(manualUrl, 'the UTCP snippet should give the manual address').toBe(`${gw.address}/manual`)

    // A UTCP client: read the manual, then call through the tool's template.
    const noKey = await fetch(manualUrl!)
    expect(noKey.status, 'a protected manual should refuse a caller without the key').toBe(401)
    const manualRes = await fetch(manualUrl!, { headers: { 'x-api-key': key } })
    expect(manualRes.status).toBe(200)
    const manual = await manualRes.json()
    expect(manual.utcp_version, 'the manual should say which UTCP version it is').toBeTruthy()
    const entry = (manual.tools || []).find((t: any) => t.name === tool.name)
    expect(entry, `the manual should list ${tool.name}`).toBeTruthy()
    expect(entry.inputs?.properties?.pkg, 'the tool\'s input should be in the manual').toBeTruthy()
    const tpl = entry.tool_call_template
    expect(tpl.call_template_type).toBe('http')

    const headers: Record<string, string> = { 'content-type': tpl.content_type || 'application/json', ...(tpl.headers || {}) }
    if (tpl.auth?.auth_type === 'api_key') {
      expect((tpl.auth.location || 'header').toLowerCase()).toBe('header')
      headers[tpl.auth.var_name] = key
    }
    const method = (tpl.http_method || 'POST').toUpperCase()
    const [res, expected] = await Promise.all([
      fetch(method === 'GET' ? `${tpl.url}?pkg=${PKG}` : tpl.url, {
        method,
        headers,
        ...(method === 'GET' ? {} : { body: JSON.stringify({ pkg: PKG }) }),
      }),
      npmLatest(),
    ])
    const body = await res.text()
    expect(res.ok, `the call template should run the tool: ${res.status} ${body.slice(0, 300)}`).toBeTruthy()
    expect(versionIn(body.replace(/\\"/g, '"')), `the tool should return npm's latest ${PKG} (${expected})`).toBe(expected)
  })

  test('J6 Skills gateway: almyty skills install, then the installed skill\'s call', async ({ page, browser, gate, qa }) => {
    const tool = await makeNpmTool(page, gate, 'skill_npm')
    await createGateway(page, gate, { protocol: 'Skills', toolId: tool.id, toolName: tool.name, name: gate.name('skills') })
    // The page's command: `almyty skills install @<org>/<path>`.
    const snippet = await page.getByTestId('snippet-skills').innerText()
    const ref = snippet.match(/almyty skills install (\S+)/)?.[1]
    expect(ref, 'the Skills gateway page should show the install command').toBeTruthy()

    const cli = await cliSession(browser, gate, qa, 'skills')
    const dir = throwawayHome(gate, 'skills-dir')
    const installed = await cli.run(['skills', 'install', ref!, '--path', dir], { cwd: dir })
    expect(installed.code, `skills install should succeed: ${installed.stdout}\n${installed.stderr}`).toBe(0)
    const files = filesUnder(dir)
    const skillFile = files.find((f) => /SKILL\.md$/.test(f) && f.includes(tool.name.replace(/_/g, '-')))
      || files.find((f) => /SKILL\.md$/.test(f))
    expect(skillFile, `a SKILL.md should be installed (got ${files.join(', ')})`).toBeTruthy()
    const skill = readFileSync(join(dir, skillFile!), 'utf-8')
    expect(skill, 'the skill should describe the tool').toContain('Latest published version of an npm package')
    expect(skill).toMatch(/`pkg` \(string, \*\*required\*\*\)/)

    // The call the skill documents, done the recommended way it says:
    // `npm i -g @almyty/skills` once, then its `almyty-skills run` line.
    const install = skill.match(/^npm i -g (@almyty\/skills)\b/m)
    const line = skill.match(/^almyty-skills run (\S+)((?: --\w+ '<\w+>')*)\s*$/m)
    expect(install && line, `the skill should document how to call it:\n${skill.slice(0, 1200)}`).toBeTruthy()
    const prefix = throwawayHome(gate, 'skills-prefix')
    const npm = spawnSync('npm', ['i', '-g', '--prefix', prefix, '--no-audit', '--no-fund', install![1]], { encoding: 'utf-8', timeout: 300_000 })
    expect(npm.status, `npm i -g ${install![1]}: ${(npm.stderr || '').slice(-300)}`).toBe(0)
    const args = ['run', line![1]]
    for (const m of line![2].matchAll(/--(\w+) '<\w+>'/g)) {
      expect(m[1], 'the documented call should take the tool\'s one parameter').toBe('pkg')
      args.push(`--${m[1]}`, PKG)
    }
    const [res, expected] = await Promise.all([
      runCli(join(prefix, 'bin', 'almyty-skills'), args, cli.env, { cwd: dir }),
      npmLatest(),
    ])
    expect(res.code, `the skill's call should succeed: ${res.stdout.slice(0, 300)}\n${res.stderr.slice(0, 300)}`).toBe(0)
    expect(versionIn(res.stdout.replace(/\\"/g, '"')), `the skill should return npm's latest ${PKG} (${expected})`).toBe(expected)
  })
})
