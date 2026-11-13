/**
 * The real almyty CLI, the way a person gets it: `npm i -g @almyty/cli`
 * (into a gate-owned prefix instead of the machine's global one), then
 * `almyty login` through the browser as the QA user, in a throwaway HOME.
 *
 * Each login mints an API key; `cliSession` revokes it when the test
 * ends. Nothing here prints the key: it stays in the throwaway HOME's
 * credentials file, which is deleted with the HOME.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, type Browser } from '@playwright/test'
import { API_URL, APP_URL, GATE_DIR, QA_ORG_NAME, QA_STATE_FILE } from './env'
import type { Gate } from './fixtures'
import { data, redact } from './qa-api'
import type { APIRequestContext } from '@playwright/test'

/** Where the global setup installs @almyty/cli for this run. */
export const CLI_PREFIX = join(GATE_DIR, 'cli')
export const ALMYTY_BIN = join(CLI_PREFIX, 'bin', 'almyty')

/** `npm i -g @almyty/cli`, into the gate's own prefix. Run once per gate run (global setup). */
export function installCli(version = process.env.GATE_CLI_VERSION || 'latest'): void {
  mkdirSync(CLI_PREFIX, { recursive: true })
  const res = spawnSync('npm', ['i', '-g', '--prefix', CLI_PREFIX, '--no-audit', '--no-fund', `@almyty/cli@${version}`], {
    encoding: 'utf-8',
    timeout: 300_000,
  })
  if (res.status !== 0 || !existsSync(ALMYTY_BIN)) {
    throw new Error(`npm i -g @almyty/cli failed (${res.status}): ${(res.stderr || res.stdout || '').slice(-400)}`)
  }
}

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface CliSession {
  /** The throwaway HOME holding this session's credentials. */
  home: string
  env: NodeJS.ProcessEnv
  /** Run `almyty <args>` to completion. */
  run(args: string[], opts?: { cwd?: string; input?: string; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<CliResult>
  /** Start `almyty <args>` and leave it running (a daemon); killed when the test ends. */
  start(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): { child: ChildProcess; output: () => string }
}

/** A fresh HOME with nothing in it: no credentials, no config. */
export function throwawayHome(gate: Gate, what = 'home'): string {
  const home = mkdtempSync(join(tmpdir(), `gate-${gate.runId}-${what}-`))
  gate.defer(`remove ${what}`, () => rmSync(home, { recursive: true, force: true }))
  return home
}

function cliEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    ALMYTY_TOKEN: '',
    NO_COLOR: '1',
    // Playwright sets FORCE_COLOR for its workers; the CLI's output is read as text.
    FORCE_COLOR: undefined,
    PATH: `${join(CLI_PREFIX, 'bin')}:${process.env.PATH}`,
    ...extra,
  }
}

export function runCli(bin: string, args: string[], env: NodeJS.ProcessEnv, opts: { cwd?: string; input?: string; timeout?: number } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout ?? 180_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: redact(stdout), stderr: redact(stderr) })
    })
  })
}

/**
 * `almyty login [flags] --no-browser` in `home`, approved in a browser
 * signed in as the QA user, choosing the QA organization on the CLI
 * login page. `loginArgs` defaults to `--api <staging> --frontend <staging>`.
 */
export async function cliLogin(browser: Browser, home: string, loginArgs?: string[]): Promise<void> {
  const args = ['login', ...(loginArgs ?? ['--api', API_URL, '--frontend', APP_URL]), '--no-browser']
  const child = spawn(ALMYTY_BIN, args, { env: cliEnv(home), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  try {
    const loginUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`almyty login printed no URL: ${redact(out.slice(0, 300))}`)), 60_000)
      const onData = (d: Buffer) => {
        out += d.toString()
        const m = /Waiting for you/.test(out) && out.match(/https?:\/\/\S+\/cli-login\?\S+/)
        if (m) {
          clearTimeout(timer)
          resolve(m[0])
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
    })
    const context = await browser.newContext({ storageState: QA_STATE_FILE })
    try {
      const page = await context.newPage()
      await page.goto(loginUrl)
      const picker = page.locator('#cli-organization')
      await expect(picker).toBeVisible({ timeout: 30_000 })
      await page.waitForFunction(() => document.querySelectorAll('#cli-organization option').length > 1)
      await picker.selectOption({ label: QA_ORG_NAME })
      await page.getByRole('button', { name: 'Connect CLI' }).click()
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 60_000))])
      if (code !== 0) throw new Error(`almyty login did not finish (${code}): ${redact(out.trim().split('\n').pop() || '')}`)
    } finally {
      await context.close()
    }
  } finally {
    if (child.exitCode === null) child.kill()
  }
}

/** Revoke the `CLI login` API keys minted since `since` (ms epoch). */
export async function revokeCliKeys(qa: APIRequestContext, since: number): Promise<void> {
  const body = await data<any>(await qa.get('/auth/api-keys'))
  const keys = Array.isArray(body) ? body : body?.keys || body?.apiKeys || []
  for (const k of keys) {
    if (/^CLI login/.test(k.name || '') && Date.parse(k.createdAt) >= since - 60_000) {
      const res = await qa.delete(`/auth/api-keys/${k.id}`)
      if (!res.ok() && res.status() !== 404) throw new Error(`revoke CLI key: ${res.status()}`)
    }
  }
}

/**
 * A signed-in CLI for one test: a throwaway HOME, `almyty login` as the
 * QA user, and the key revoked plus every started process killed when
 * the test ends.
 */
export async function cliSession(browser: Browser, gate: Gate, qa: APIRequestContext, what = 'cli'): Promise<CliSession> {
  const home = throwawayHome(gate, what)
  const since = Date.now()
  gate.defer('revoke the CLI login key', () => revokeCliKeys(qa, since))
  await cliLogin(browser, home)
  const env = cliEnv(home)
  return {
    home,
    env,
    run: (args, opts = {}) => runCli(ALMYTY_BIN, args, { ...env, ...(opts.env || {}) }, opts),
    start: (args, opts = {}) => {
      const child = spawn(ALMYTY_BIN, args, { env: { ...env, ...(opts.env || {}) }, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout!.on('data', (d) => (output += d.toString()))
      child.stderr!.on('data', (d) => (output += d.toString()))
      gate.defer(`stop almyty ${args[0]}`, async () => {
        if (child.exitCode !== null) return
        child.kill('SIGTERM')
        await new Promise((r) => setTimeout(r, 3000))
        if (child.exitCode === null) child.kill('SIGKILL')
      })
      return { child, output: () => redact(output) }
    },
  }
}

export { cliEnv }
