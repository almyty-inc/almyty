// Runs one walk: signs its people in, does each step, takes its
// screenshots. A step that cannot be done stops the walk with the walk id,
// the step and a screenshot of the page as it was.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page, Route, Locator as PwLocator } from '@playwright/test'
import type { Account, Condition, Locator, Step, Walk } from './schema.ts'
import { type Env, sql as runSql } from './env.ts'
import { request, rows, at } from './http.ts'
import { matches } from './match.ts'
import { locate, locateAll, describe } from './locate.ts'
import { render, assign, type Vars } from './template.ts'
import { renderPage, type Template } from './render.ts'

export interface Capture { file: string; route: string; at: string }

export interface Person { account: Account; orgId: string; slug: string; userId: string; token: string }

export interface Session { context: BrowserContext; page: Page; inflight: Map<unknown, number>; person?: Person; signedIn?: Awaited<ReturnType<BrowserContext['storageState']>> }

/** What a step and an action can reach. */
export interface Run {
  walk: Walk
  env: Env
  vars: Vars
  out: string
  person?: Person
  people: Record<string, Person>
  session?: Session
  sessions: Record<string, Session>
  browser?: Browser
  captures: Record<string, Capture>
  templates: Record<string, Template>
  timeout: number
  log: (...args: unknown[]) => void
}

export type Action = (run: Run, args: Record<string, unknown>) => Promise<unknown>

export class WalkError extends Error {
  readonly walk: string
  readonly step: string
  readonly screenshot?: string
  constructor(walk: string, where: string, step: string, cause: unknown, screenshot?: string) {
    const why = cause instanceof Error ? cause.message.split('\n')[0] : String(cause)
    super(`walk ${walk}, step ${where} ${step}: ${why}${screenshot ? `\n  page as it was: ${screenshot}` : ''}`)
    this.walk = walk; this.step = `${where} ${step}`; this.screenshot = screenshot
  }
}

// The dev build's query devtools, and toasts that have said their piece, stay out of the picture.
const HIDE = '.tsqd-parent-container, .tsqd-open-btn-container, [role=region][aria-label^="Notifications"] { display: none !important; }'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

/** A step as one line, for logs and errors. */
export function stepLabel(step: Step): string {
  return JSON.stringify(step, (_k, v) => (v instanceof RegExp ? String(v) : v), 0)
    .replace(/"(\w+)":/g, '$1:').slice(0, 220)
}

// ---------- people ----------

/** Whether the engine signs this person in with their password; signIn: 'none' is a person a step signs in (SSO, a visitor). */
export const byPassword = (account: Account): boolean => account.signIn !== 'none'

export async function preparePerson(env: Env, account: Account): Promise<Person> {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`
  if (account.register !== false && runSql(env, `SELECT count(*) FROM users WHERE email = ${q(account.email)}`) === '0') {
    const { signIn: _s, register: _r, ...body } = account
    await request(env, { method: 'POST', url: '/auth/register', body, auth: false })
  }
  // Nobody can click the verification mail on a local stack. Someone who signs in through a step (SSO) is left as that sign-in leaves them.
  if (byPassword(account)) runSql(env, `UPDATE users SET "isVerified" = true, "verifiedAt" = coalesce("verifiedAt", now()) WHERE email = ${q(account.email)}`)
  const row = runSql(env, `SELECT o.id || '|' || o.slug || '|' || u.id FROM user_organizations uo JOIN users u ON u.id = uo."userId" JOIN organizations o ON o.id = uo."organizationId" WHERE u.email = ${q(account.email)} ORDER BY (o.name = ${q(account.organizationName)}) DESC LIMIT 1`)
  const [orgId = '', slug = '', userId = ''] = row.split('|')
  if (orgId) {
    // The fakes are on localhost: the organization says that host is its own.
    runSql(env, `UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || '{"egressAllowlist":["localhost"]}'::jsonb WHERE id = '${orgId}'`)
  }
  let token = ''
  if (orgId && byPassword(account)) token = ((await request(env, { method: 'POST', url: '/auth/token', body: { email: account.email, password: account.password }, auth: false })) as { accessToken: string }).accessToken
  return { account, orgId, slug, userId, token }
}

// ---------- the browser ----------

const isStream = (r: { resourceType(): string; headers(): Record<string, string> }) =>
  r.resourceType() === 'eventsource' || r.resourceType() === 'websocket' || /text\/event-stream/.test(r.headers().accept ?? '')

export async function openSession(run: Run, person?: Person, signedIn?: Session['signedIn']): Promise<Session> {
  const b = run.walk.browser ?? {}
  const scale = b.scale ?? 2
  const theme = b.theme ?? 'light'
  const context = await run.browser!.newContext({
    baseURL: run.env.web, colorScheme: theme, timezoneId: b.timezone ?? 'UTC', locale: 'en-US', deviceScaleFactor: scale,
    viewport: b.viewport ?? { width: 1440, height: 900 }, acceptDownloads: true, ...(signedIn ? { storageState: signedIn } : {}),
  })
  await context.addInitScript((t) => { try { localStorage.setItem('theme', t) } catch { /* private mode */ } }, theme)
  for (const host of b.block ?? []) {
    await context.route(new RegExp(`^https?://([^/]*\\.)?${host.replace(/\./g, '\\.')}/`), (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Stopped before the real page (local demo).</p>' }))
  }
  for (const [host, base] of Object.entries(b.forward ?? {})) {
    await context.route(new RegExp(`^https?://${host.replace(/\./g, '\\.')}/`), forwardTo(render(base, run.vars) as string))
  }
  const page = await context.newPage()
  page.setDefaultTimeout(b.timeout ?? run.timeout)
  page.on('dialog', (d) => { d.accept().catch(() => {}) })
  const inflight = new Map<unknown, number>()
  page.on('request', (r) => { if (!isStream(r)) inflight.set(r, Date.now()) })
  page.on('requestfinished', (r) => inflight.delete(r))
  page.on('requestfailed', (r) => inflight.delete(r))
  const session: Session = { context, page, inflight }
  session.person = person
  if (signedIn) session.signedIn = signedIn
  else if (person && person.account.signIn !== 'none') { await signIn(session, person.account); session.signedIn = await context.storageState() }
  if (b.providerUrl) {
    const urls = typeof b.providerUrl === 'string' ? { '*': b.providerUrl } : b.providerUrl
    // The provider key goes to the fake vendor instead of the real one.
    await page.route('**/llm-providers/connect', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}')
      const url = urls[body.type] ?? urls['*']
      if (url) body.configuration = { ...(body.configuration || {}), apiUrl: render(url, { ...run.vars, type: body.type }) }
      await route.continue({ postData: JSON.stringify(body) })
    })
  }
  return session
}

/** A route handler that answers from `to` instead; redirects go back to the browser, which follows them (a sign-in hands it on). */
export function forwardTo(to: string) {
  return async (route: Route): Promise<void> => {
    const u = new URL(route.request().url())
    const res = await route.fetch({ url: `${to}${u.pathname}${u.search}`, maxRedirects: 0 })
    await route.fulfill({ response: res })
  }
}

export async function signIn(session: Session, account: Account): Promise<void> {
  const { page } = session
  await page.goto('/auth/login')
  await page.getByLabel('Email address').fill(account.email)
  await page.getByLabel('Password', { exact: true }).fill(account.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
}

/** Wait until the page has nothing in flight (open event streams aside) for `quiet` ms. */
const LONG = 5000

export async function settle(session: Session, quiet = 500, limit = 15000): Promise<void> {
  const end = Date.now() + limit
  let since = Date.now()
  while (Date.now() < end) {
    // A request open for longer than LONG is a long poll or a stream, not the page loading.
    const now = Date.now()
    if ([...session.inflight.values()].some((started) => now - started < LONG)) since = now
    else if (Date.now() - since >= quiet) break
    await new Promise((r) => setTimeout(r, 50))
  }
  await session.page.waitForLoadState('domcontentloaded')
}

async function beforeShot(session: Session): Promise<void> {
  const { page } = session
  await settle(session)
  await page.addStyleTag({ content: HIDE })
  await page.evaluate(async () => {
    await document.fonts.ready
    const deadline = Date.now() + 10000
    while (document.querySelector('[aria-busy="true"]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
  await page.mouse.move(0, 0)
}

// ---------- conditions ----------

async function holds(run: Run, c: Condition): Promise<{ ok: boolean; value?: unknown }> {
  const page = () => { if (!run.session) throw new Error('this condition needs a browser'); return run.session.page }
  if ('visible' in c) return { ok: await locate(page(), c.visible).isVisible().catch(() => false) }
  if ('hidden' in c) return { ok: !(await locate(page(), c.hidden).isVisible().catch(() => false)) }
  if ('enabled' in c) { const l = locate(page(), c.enabled); return { ok: (await l.isVisible().catch(() => false)) && await l.isEnabled().catch(() => false) } }
  if ('checked' in c) return { ok: await locate(page(), c.checked).isChecked().catch(() => false) }
  if ('url' in c) { const u = page().url(); return { ok: typeof c.url === 'string' ? u.includes(c.url) : c.url.test(u) } }
  if ('sql' in c) {
    const v = runSql(run.env, render(c.sql, run.vars))
    const ok = c.is !== undefined ? v === c.is : c.not !== undefined ? v !== c.not : v !== '' && v !== '0' && v !== 'f'
    return { ok, value: v }
  }
  if ('http' in c) {
    const body = await request(run.env, render(c.http, run.vars), run.person?.token).catch(() => undefined)
    if (body === undefined) return { ok: false }
    const value = at(body, c.at)
    const listed = Array.isArray(value) ? value : value && typeof value === 'object' && rows(value).length ? rows(value) : undefined
    if (!c.where && c.min === undefined) return { ok: listed ? listed.length > 0 : Boolean(value) && !(value && typeof value === 'object' && !Object.keys(value).length), value }
    const list = (listed ?? (value === null || value === undefined ? [] : [value])).filter((row) => matches(row, render(c.where ?? {}, run.vars)))
    return { ok: list.length >= (c.min ?? 1), value: list }
  }
  if ('value' in c) {
    const v = render(c.value, run.vars)
    return { ok: c.is === undefined ? Boolean(v) && !(Array.isArray(v) && !v.length) : matches({ v }, { v: render(c.is, run.vars) }), value: v }
  }
  if ('not' in c) return { ok: !(await holds(run, c.not)).ok }
  throw new Error('unknown condition')
}

// ---------- steps ----------

const NESTED = new Set(['then', 'else', 'do', 'repeat'])
/** Fill in a step's placeholders, but not those of the steps inside it: they run later. */
function prepare(step: Step, vars: Vars): Step {
  return Object.fromEntries(Object.entries(step).map(([k, v]) => [k, NESTED.has(k) || (k === 'while' || k === 'if') ? v : render(v, vars)])) as Step
}

export async function runSteps(run: Run, steps: Step[], where: string, actions: Record<string, Action>): Promise<void> {
  for (const [i, raw] of steps.entries()) {
    const here = `${where}${i + 1}`
    const step = prepare(raw, run.vars)
    try {
      await runStep(run, step, here, actions)
    } catch (e) {
      if (e instanceof WalkError) throw e
      let screenshot: string | undefined
      if (run.session) {
        const dir = join(run.out, 'failures')
        mkdirSync(dir, { recursive: true })
        screenshot = join(dir, `${run.walk.id}-step-${here.replace(/\./g, '-')}.png`)
        await run.session.page.screenshot({ path: screenshot }).catch(() => { screenshot = undefined })
      }
      throw new WalkError(run.walk.id, here, stepLabel(raw), e, screenshot)
    }
  }
}

function pageOf(run: Run): Page {
  if (!run.session) throw new Error('this step needs a browser, and the walk is headless')
  return run.session.page
}

async function scrollIntoView(target: PwLocator, block: 'start' | 'center' | 'end' | 'nearest', offset: number): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  if (block === 'nearest') return
  await target.evaluate((e, [b, o]) => {
    e.scrollIntoView({ block: b as ScrollLogicalPosition })
    if (o) { const m = document.querySelector('main'); if (m) m.scrollBy(0, -o); window.scrollBy(0, -o) }
  }, [block, offset] as const)
}

// The kind of a step is its leading key. Kinds whose other keys overlap
// another kind's (a render takes a shot, each names what it is `as`) come first.
const KINDS = ['render', 'each', 'press', 'goto', 'reload', 'click', 'fill', 'key', 'check', 'uncheck', 'select', 'upload', 'expand',
  'setChecks', 'waitFor', 'waitForUrl', 'until', 'scrollTo', 'scrollTop', 'scrollBy', 'viewport', 'shot', 'remember', 'http', 'sql',
  'ensure', 'if', 'repeat', 'use', 'action', 'as', 'download', 'settle', 'restart'] as const
type Kind = (typeof KINDS)[number]
type Of<K extends Kind> = Extract<Step, Record<K, unknown>>

export function kindOf(step: Step): Kind {
  const k = KINDS.find((kind) => kind in step)
  if (!k) throw new Error(`unknown step ${Object.keys(step).join(', ')}`)
  return k
}

async function runStep(run: Run, step: Step, here: string, actions: Record<string, Action>): Promise<void> {
  run.log(`  ${here} ${stepLabel(step).slice(0, 140)}`)
  const kind = kindOf(step)
  const page = () => pageOf(run)
  const quiet = () => settle(run.session!)
  switch (kind) {
    case 'goto': await page().goto((step as Of<'goto'>).goto); return quiet()
    case 'reload': await page().reload(); return quiet()
    case 'click': { const s = step as Of<'click'>; await locate(page(), s.click).click({ force: s.force }); return quiet() }
    case 'fill': { const s = step as Of<'fill'>; await locate(page(), s.fill).fill(s.value); return }
    case 'press': { const s = step as Of<'press'>; await locate(page(), s.press).press(s.key); return quiet() }
    case 'key': await page().keyboard.press((step as Of<'key'>).key); return quiet()
    case 'check': {
      const s = step as Of<'check'>
      if (s.all) { for (const el of await locateAll(page(), s.check).all()) if (!(await el.isChecked())) await el.check() }
      else await locate(page(), s.check).check()
      return
    }
    case 'uncheck': {
      const s = step as Of<'uncheck'>
      if (s.all) { for (const el of await locateAll(page(), s.uncheck).all()) if (await el.isChecked()) await el.uncheck() }
      else await locate(page(), s.uncheck).uncheck()
      return
    }
    case 'select': {
      const s = step as Of<'select'>
      await locate(page(), s.select).click()
      if (s.search !== undefined) await page().getByRole('combobox').or(page().getByRole('searchbox')).or(page().getByRole('textbox')).filter({ visible: true }).last().fill(s.search)
      await page().getByRole('option', { name: s.option, exact: typeof s.option === 'string' }).first().click()
      return quiet()
    }
    case 'upload': { const s = step as Of<'upload'>; await locate(page(), s.upload).setInputFiles(s.file); return quiet() }
    case 'expand': {
      for (const el of await locateAll(page(), (step as Of<'expand'>).expand).all()) if ((await el.getAttribute('aria-expanded')) !== 'true') await el.click()
      return quiet()
    }
    case 'setChecks': {
      const s = step as Of<'setChecks'>
      for (const el of await locateAll(page(), s.setChecks).all()) {
        const name = (await el.getAttribute('aria-label')) ?? ''
        if (typeof s.on === 'string' ? name === s.on : s.on.test(name)) await el.check(); else await el.uncheck()
      }
      return
    }
    case 'waitFor': { const s = step as Of<'waitFor'>; await locate(page(), s.waitFor).waitFor({ state: s.state ?? 'visible', timeout: s.timeout }); return }
    case 'waitForUrl': {
      const s = step as Of<'waitForUrl'>
      const p = s.waitForUrl
      await page().waitForURL(typeof p === 'string' ? (u) => u.href.includes(p) : p, { timeout: s.timeout })
      return quiet()
    }
    case 'until': {
      const s = step as Of<'until'>
      const end = Date.now() + (s.timeout ?? 120000)
      for (;;) {
        const r = await holds(run, s.until)
        if (r.ok) { if (s.save) assign(run.vars, s.save, r.value); return }
        if (Date.now() > end) throw new Error(`timed out waiting for ${s.what ?? 'the condition'}`)
        await new Promise((res) => setTimeout(res, s.every ?? 2000))
      }
    }
    case 'scrollTo': {
      const s = step as Of<'scrollTo'>
      if (s.inner) await locate(page(), s.inner).evaluate((e) => { e.scrollTop = 0 })
      await scrollIntoView(locate(page(), s.scrollTo), s.block ?? 'start', s.offset ?? 0)
      return
    }
    case 'scrollTop': await page().evaluate(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0) }); return
    case 'scrollBy': await page().evaluate((y) => { const m = document.querySelector('main'); if (m) m.scrollBy(0, y); window.scrollBy(0, y) }, (step as Of<'scrollBy'>).scrollBy); return
    case 'viewport': await page().setViewportSize((step as Of<'viewport'>).viewport); return
    case 'render': {
      const s = step as Of<'render'>
      const file = join(run.out, `${s.shot}.html`)
      writeFileSync(file, renderPage(run.templates, s.render, s.with))
      const height = typeof s.with.height === 'number' ? s.with.height : undefined
      const before = page().viewportSize()
      if (height && before) await page().setViewportSize({ width: before.width, height })
      await page().goto(`file://${file}`)
      await takeShot(run, s.shot, { fullPage: true, clip: s.clip, pad: s.pad })
      if (height && before) await page().setViewportSize(before)
      return
    }
    case 'shot': { const s = step as Of<'shot'>; await takeShot(run, s.shot, { clip: s.clip, pad: s.pad }); return }
    case 'remember': {
      const s = step as Of<'remember'>
      let value: unknown = s.value
      if (s.fromUrl || (value === undefined && !s.fromInput)) {
        const m = page().url().match(s.fromUrl ?? UUID)
        if (!m) throw new Error(`nothing in ${page().url()} matches ${s.fromUrl ?? 'an id'}`)
        value = m[1] ?? m[0]
      }
      if (s.fromInput) value = await locate(page(), s.fromInput).inputValue()
      assign(run.vars, s.remember, value)
      return
    }
    case 'http': { const s = step as Of<'http'>; const body = await request(run.env, s.http, run.person?.token); if (s.save) assign(run.vars, s.save, body); return }
    case 'sql': { const s = step as Of<'sql'>; const v = runSql(run.env, s.sql); if (s.save) assign(run.vars, s.save, v); return }
    case 'ensure': {
      const s = step as Of<'ensure'>
      const list = rows(await request(run.env, { url: s.ensure.list }, run.person?.token), s.ensure.at)
      let row = list.find((r) => matches(r, s.ensure.where))
      if (!row && s.create) {
        const made = await request(run.env, s.create, run.person?.token)
        row = s.pick ? at(made, s.pick) : made
        run.log(`    made ${JSON.stringify(s.ensure.where).slice(0, 80)}`)
      }
      if (s.save) assign(run.vars, s.save, row)
      return
    }
    case 'if': {
      const s = step as Of<'if'>
      return runSteps(run, (await holds(run, s.if)).ok ? s.then : s.else ?? [], `${here}.`, actions)
    }
    case 'repeat': {
      const s = step as Of<'repeat'>
      for (let n = 0; n < s.max; n++) {
        if (s.while && !(await holds(run, s.while)).ok) return
        await runSteps(run, s.repeat, `${here}.${n + 1}.`, actions)
      }
      if (s.while && (await holds(run, s.while)).ok) throw new Error(`still going after ${s.max} rounds`)
      return
    }
    case 'each': {
      const s = step as Of<'each'>
      const list = render(`{{${s.each}}}`, run.vars)
      if (!Array.isArray(list)) throw new Error(`${s.each} is not a list`)
      for (const [n, item] of list.entries()) {
        assign(run.vars, s.as, item)
        await runSteps(run, s.do, `${here}.${n + 1}.`, actions)
      }
      return
    }
    case 'action': {
      const s = step as Of<'action'>
      const fn = actions[s.action]
      if (!fn) throw new Error(`no action called ${s.action}`)
      const value = await fn(run, s.with ?? {})
      if (s.save) assign(run.vars, s.save, value)
      return
    }
    case 'as': {
      const s = step as Of<'as'>
      const before = { session: run.session, person: run.person }
      if (!run.sessions[s.as]) {
        const account = run.walk.people?.[s.as]
        if (!account) throw new Error(`nobody called ${s.as} in people`)
        run.people[s.as] ??= await preparePerson(run.env, account)
        run.sessions[s.as] = await openSession(run, run.people[s.as])
      }
      run.session = run.sessions[s.as]; run.person = run.people[s.as]
      try { await runSteps(run, s.do, `${here}.`, actions) } finally { run.session = before.session; run.person = before.person }
      return
    }
    case 'download': {
      const s = step as Of<'download'>
      const [download] = await Promise.all([page().waitForEvent('download'), locate(page(), s.download).click()])
      const dir = join(run.out, 'downloads')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, download.suggestedFilename())
      await download.saveAs(file)
      assign(run.vars, s.save, file)
      return
    }
    case 'settle': return settle(run.session!, (step as Of<'settle'>).quiet ?? 500)
    case 'restart': {
      // A new browser context: what a fresh tab of the same person (or a new visitor) starts with.
      const old = run.session!
      const name = Object.entries(run.sessions).find(([, s]) => s === old)?.[0] ?? 'me'
      const viewport = old.page.viewportSize()
      await old.context.close()
      const fresh = await openSession(run, old.person, old.signedIn)
      if (viewport) await fresh.page.setViewportSize(viewport)
      run.sessions[name] = fresh
      run.session = fresh
      return
    }
    case 'use': throw new Error(`macro ${(step as Of<'use'>).use} was not expanded`)
  }
}

async function takeShot(run: Run, id: string, how: { fullPage?: boolean; clip?: Locator; pad?: number } = {}): Promise<void> {
  const shot = run.walk.shots[id]
  const session = run.session!
  await beforeShot(session)
  const file = join(run.out, `${id}.png`)
  let clip: { x: number; y: number; width: number; height: number } | undefined
  if (how.clip) {
    const box = await locate(session.page, how.clip).boundingBox()
    if (!box) throw new Error(`nothing to clip to: ${describe(how.clip)} is not on screen`)
    const pad = how.pad ?? 0
    clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad }
  }
  await session.page.screenshot({ path: file, fullPage: how.fullPage || shot.fullPage, clip, animations: 'disabled', caret: 'hide' })
  const url = new URL(session.page.url())
  const route = shot.route ?? (url.protocol === 'file:' ? '/' : url.pathname + url.search).replace(new RegExp(UUID.source, 'g'), ':id')
  run.captures[id] = { file, route, at: new Date().toISOString() }
  run.log(`  shot ${id} ${route}`)
}

// ---------- a whole walk ----------

export interface WalkOptions {
  env: Env
  browser?: Browser
  actions: Record<string, Action>
  templates: Record<string, Template>
  /** Start at this shot; steps before it are skipped. */
  from?: string
  vars?: Vars
  log?: (...args: unknown[]) => void
  timeout?: number
}

/** Where the captures of every walk are listed, so register finds them. */
export const capturesFile = (out: string) => join(out, 'captures.json')

export const varsFile = (out: string, walk: string) => join(out, walk, 'vars.json')

/** What a walk remembered last time it ran, or nothing. */
export function readVars(out: string, walk: string): Vars | undefined {
  const f = varsFile(out, walk)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined
}

export function readCaptures(out: string): Record<string, Record<string, Capture>> {
  const f = capturesFile(out)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
}

const takes = (s: Step, id?: string) => JSON.stringify(s).includes(id ? `"shot":"${id}"` : '"shot":"')

/** The steps from just after the shot before `id` on: the ones that lead to that shot. */
export function fromShot(steps: Step[], id: string, walkId = 'walk'): Step[] {
  const at = steps.findIndex((s) => takes(s, id))
  if (at < 0) throw new Error(`walk ${walkId} takes no shot ${id}`)
  let start = at
  while (start > 0 && !takes(steps[start - 1])) start--
  return steps.slice(start)
}

export async function runWalk(walk: Walk, opts: WalkOptions): Promise<Run> {
  const out = join(opts.env.out, walk.id)
  mkdirSync(out, { recursive: true })
  const run: Run = {
    walk, env: opts.env, out, people: {}, sessions: {}, captures: {}, browser: opts.browser, templates: opts.templates,
    vars: { ...(opts.vars ?? {}), out, stack: { web: opts.env.web, api: opts.env.api, fake: opts.env.fake, upstream: opts.env.upstream } },
    timeout: opts.timeout ?? walk.browser?.timeout ?? 30000,
    log: opts.log ?? ((...a) => console.log(...a)),
  }
  if (walk.account) {
    run.person = await preparePerson(opts.env, walk.account)
    run.people.me = run.person
    Object.assign(run.vars, { org: { id: run.person.orgId, slug: run.person.slug }, me: { id: run.person.userId, email: walk.account.email } })
  }
  Object.assign(run.vars, render(walk.vars ?? {}, run.vars))
  if (!walk.headless) {
    if (!opts.browser) throw new Error(`walk ${walk.id} needs a browser`)
    run.session = await openSession(run, walk.browser?.anonymous ? undefined : run.person)
    run.sessions.me = run.session
  }
  let steps = walk.steps
  if (opts.from) {
    steps = fromShot(steps, opts.from, walk.id)
  }
  try {
    await runSteps(run, steps, '', opts.actions)
  } finally {
    const all = readCaptures(opts.env.out)
    all[walk.id] = { ...(all[walk.id] ?? {}), ...run.captures }
    writeFileSync(capturesFile(opts.env.out), JSON.stringify(all, null, 2))
    // What it remembered, for walks that run after it and for a rerun --from a later shot.
    const { out: _o, stack: _s, ...keep } = run.vars
    writeFileSync(varsFile(opts.env.out, walk.id), JSON.stringify(keep, (_k, v) => (v instanceof RegExp ? String(v) : v), 2))
    for (const s of Object.values(run.sessions)) await s.context.close().catch(() => {})
  }
  return run
}
