/**
 * J12: a runner on this machine, set up with exactly the commands the
 * Start a runner page shows (install, log in, start), in a throwaway HOME
 * and a throwaway npm prefix. A workflow sends its shell tool a command
 * and must get this machine's answer back. Then the runner is stopped
 * with `almyty runner stop` and deleted from its page, and the CLI's
 * login key is revoked.
 *
 * It runs as a fresh @test.almyty.com account with its own organization,
 * never the QA user: an account has one runner, and starting the daemon as
 * the QA user reconnected (and the test then deleted) the QA user's own
 * seeded runner. The runner is named `gate-<run>-runner`; the fresh
 * account's organization, and with it the runner, the workflow and the
 * tools, is deleted when the test ends. The workflow needs no model: it is
 * Input, the shell tool, Output.
 */
import { spawn, spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { request, type APIRequestContext, type Page } from '@playwright/test'
import { test, expect, screenshotThis, type FreshUser, type Gate } from './support/fixtures'
import { cliEnv, revokeCliKeys, runCli } from './support/cli'
import { API_URL } from './support/env'
import { data, redact } from './support/qa-api'
import { connect, deleteStep, editAsText, newWorkflow, openStep, pickTool, runFromTestPanel, saveNewAgent, step, toolInput } from './support/workflow'

/** The three commands on the Start a runner page, as shown. */
async function documentedCommands(page: Page): Promise<{ install: string; login: string; start: string }> {
  await page.goto('/runners/new')
  await expect(page.getByRole('heading', { name: 'Start a runner', level: 1 })).toBeVisible()
  const command = async (label: string) => {
    const block = page.getByText(label, { exact: true }).locator('xpath=..')
    return (await block.locator('code').first().innerText()).trim()
  }
  return { install: await command('Install once'), login: await command('Log in'), start: await command('Start the runner') }
}

/** `almyty login …` from the page, approved in the fresh account's own browser session. */
async function approveLogin(user: FreshUser, bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(bin, [...args, '--no-browser'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  try {
    const url = await new Promise<string>((resolve, reject) => {
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
    const page = await user.page.context().newPage()
    try {
      await page.goto(url)
      const picker = page.locator('#cli-organization')
      await expect(picker).toBeVisible({ timeout: 30_000 })
      await page.waitForFunction(() => document.querySelectorAll('#cli-organization option').length > 1)
      await picker.selectOption({ label: user.organizationName })
      await page.getByRole('button', { name: 'Connect CLI' }).click()
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 60_000))])
      expect(code, `almyty login should finish: ${redact(out.trim().split('\n').pop() || '')}`).toBe(0)
    } finally {
      await page.close()
    }
  } finally {
    if (child.exitCode === null) child.kill()
  }
}

/** The fresh account's API session in its own organization (its cookies, not the QA user's). */
async function freshApi(user: FreshUser): Promise<{ api: APIRequestContext; orgId: string }> {
  const storageState = await user.page.context().storageState()
  const signedIn = await request.newContext({ baseURL: API_URL, storageState })
  const profile = await data<any>(await signedIn.get('/auth/profile'))
  const org = (profile.organizations || []).find((o: any) => o.name === user.organizationName)
  await signedIn.dispose()
  if (!org) throw new Error(`the fresh account has no organization named ${user.organizationName}`)
  const api = await request.newContext({ baseURL: API_URL, storageState, extraHTTPHeaders: { 'X-Organization-Id': org.id } })
  return { api, orgId: org.id }
}

/** Split a shown command into words (the page's commands have no quoting). */
function words(command: string): string[] {
  return command.trim().split(/\s+/)
}

test.describe('J12 runner on this machine', () => {
  test('J12 runner set up with the documented commands runs a shell tool here, then stops and is deleted', async ({ gate, freshUser }) => {
    test.setTimeout(20 * 60_000)
    const page = freshUser.page
    screenshotThis(page)
    const { api, orgId } = await freshApi(freshUser)
    gate.defer('close the fresh account API session', () => api.dispose())
    // Everything this test makes lives in the fresh organization, which the
    // freshUser fixture deletes; the QA user's cleanup must not try it.
    const inFreshOrg: Gate = { ...gate, track: () => {} }

    const shown = await documentedCommands(page)
    expect(shown.install).toBe('npm i -g @almyty/cli')
    expect(shown.login, 'the page names staging, so the CLI does not log in to production').toMatch(/^almyty login --api https:\/\/\S+ --frontend https:\/\/\S+$/)
    expect(shown.start).toMatch(/^almyty runner start --url https:\/\/\S+$/)

    // Install once, into a throwaway prefix instead of the machine's global one.
    const prefix = mkdtempSync(join(tmpdir(), `gate-${gate.runId}-runner-prefix-`))
    gate.defer('remove the runner npm prefix', () => rmSync(prefix, { recursive: true, force: true }))
    const [npm, ...installArgs] = words(shown.install)
    const installed = spawnSync(npm, [...installArgs, '--prefix', prefix, '--no-audit', '--no-fund'], { encoding: 'utf-8', timeout: 300_000 })
    expect(installed.status, `${shown.install} failed: ${(installed.stderr || '').slice(-300)}`).toBe(0)
    const bin = join(prefix, 'bin', 'almyty')

    // Log in, in a throwaway HOME, as the fresh account.
    const home = mkdtempSync(join(tmpdir(), `gate-${gate.runId}-runner-home-`))
    gate.defer('remove the runner HOME', () => rmSync(home, { recursive: true, force: true }))
    const env = { ...cliEnv(home), PATH: `${join(prefix, 'bin')}:${process.env.PATH}` }
    const since = Date.now()
    gate.defer('revoke the runner login key', () => revokeCliKeys(api, since))
    await approveLogin(freshUser, bin, words(shown.login).slice(1), env)

    // Start the runner, named so the gate's own sweep recognises it, and leave it running.
    const runnerName = gate.name('runner')
    const daemon = spawn(bin, [...words(shown.start).slice(1), '--name', runnerName], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    daemon.stdout.on('data', (d) => (log += d.toString()))
    daemon.stderr.on('data', (d) => (log += d.toString()))
    gate.defer('stop the runner daemon', async () => {
      if (daemon.exitCode !== null) return
      daemon.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 3000))
      if (daemon.exitCode === null) daemon.kill('SIGKILL')
    })

    // The setup page now names this account's runner; its page shows it online.
    let runnerId = ''
    await expect(async () => {
      expect(daemon.exitCode, `the runner exited: ${redact(log.slice(-400))}`).toBeNull()
      await page.goto('/runners/new')
      const yours = page.getByRole('main').locator('p').filter({ hasText: /^Your runner/, has: page.getByRole('link') })
      await expect(yours, `the runner should come online; it said: ${redact(log.slice(-800))}`).toContainText(/is online/, { timeout: 5_000 })
      await expect(yours.getByRole('link')).toHaveText(runnerName)
      await yours.getByRole('link').click()
      await expect(page).toHaveURL(/\/runners\/[0-9a-f-]{36}/)
      runnerId = page.url().match(/[0-9a-f-]{36}/)![0]
    }).toPass({ timeout: 180_000, intervals: [5_000] })
    await expect(page.getByRole('heading', { name: runnerName, level: 1 })).toBeVisible()
    await expect(page.getByRole('main').getByText(/^online$/).first(), 'the runner page should show it online').toBeVisible()

    // A workflow that hands the runner's shell tool a command.
    const nonce = `gate-${gate.runId}-${randomBytes(4).toString('hex')}`
    const command = `echo ${nonce} && uname -s`
    const expectedOs = spawnSync('uname', ['-s'], { encoding: 'utf-8' }).stdout.trim()
    await newWorkflow(page, gate.name('runner-shell'))
    await deleteStep(page, step(page, 'llm_call'))
    const pane = page.locator('.react-flow__pane')
    const box = (await pane.boundingBox())!
    await page.locator('div[draggable="true"]').filter({ hasText: /^Tool call/ }).dragTo(pane, { targetPosition: { x: box.width * 0.4, y: box.height * 0.25 } })
    // Rewire Input → Tool call → Output.
    await connect(page, step(page, 'input'), step(page, 'tool_call'))
    await connect(page, step(page, 'tool_call'), step(page, 'output'))
    const toolStep = await openStep(page, step(page, 'tool_call'))
    await pickTool(page, { name: `runner.${runnerName}.shell.exec` })
    await toolInput(page, 'command', 'Fixed value', command)
    await openStep(page, step(page, 'output'))
    await editAsText(page)
    await page.locator('#output-mapping').fill(`{{nodes.${toolStep}.output}}`)
    await page.getByRole('button', { name: 'Close step settings' }).click()
    await saveNewAgent(page, inFreshOrg)

    const run = await runFromTestPanel(page, { message: 'run it' })
    const said = typeof run.output === 'string' ? run.output : JSON.stringify(run.output ?? run)
    expect(run.status, `the run should complete: ${redact(String(run.error ?? JSON.stringify(run.nodeResults?.[toolStep] ?? said))).slice(0, 500)}`).toBe('completed')
    expect(said, 'the command ran on this machine and its output came back').toContain(nonce)
    expect(said).toContain(expectedOs)

    // Stop it the documented way; it goes offline and can then be deleted from its page.
    const stopped = await runCli(bin, ['runner', 'stop'], env, { timeout: 30_000 })
    expect(stopped.code, `almyty runner stop: ${stopped.stdout} ${stopped.stderr}`).toBe(0)
    await expect.poll(() => daemon.exitCode, { timeout: 60_000, message: 'the daemon should exit after stop' }).not.toBeNull()
    await page.goto(`/runners/${runnerId}`)
    // A stopped runner drains, then reads offline once the grace period is over.
    await expect(async () => {
      await page.reload()
      await expect(page.getByRole('main').getByText(/^offline$/).first()).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 10 * 60_000, intervals: [20_000] })
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    const deleted = page.waitForResponse((r) => r.url().endsWith(`/runners/${runnerId}`) && r.request().method() === 'DELETE', { timeout: 180_000 })
    const askedAt = Date.now()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
    const answer = await deleted
    test.info().annotations.push({ type: 'timing', description: `DELETE /runners/:id answered ${answer.status()} after ${Date.now() - askedAt} ms` })
    expect(answer.ok(), `deleting the runner answered ${answer.status()}`).toBeTruthy()
    await expect(page, 'deleting the runner goes back to the runner list').toHaveURL(/\/runners$/)
    expect((await api.get(`/runners/${runnerId}`)).status(), 'the deleted runner is gone').toBe(404)
    // Its published tools went with it.
    const tools = await api.get(`/organizations/${orgId}/tools?search=runner.${runnerName}.`)
    const left = ((await tools.json()).data?.tools || []).filter((t: any) => t.name?.startsWith(`runner.${runnerName}.`))
    expect(left.map((t: any) => t.name), 'a deleted runner leaves no tools behind').toEqual([])
  })
})