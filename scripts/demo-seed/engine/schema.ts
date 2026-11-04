// The shape of a walk: who signs in, which screenshots it takes, and the
// steps that get there. Walks are data; this schema is what keeps them
// honest. A walk that does not parse fails before a browser starts, with
// the walk id and the path to the bad field.
import { z } from 'zod'

// A name to match: an exact string, or a regular expression.
const Name = z.union([z.string().min(1), z.instanceof(RegExp)])

const ROLES = [
  'alert', 'button', 'cell', 'checkbox', 'columnheader', 'combobox', 'dialog', 'form', 'grid', 'heading', 'img',
  'link', 'list', 'listbox', 'listitem', 'main', 'menu', 'menuitem', 'menuitemcheckbox', 'navigation', 'option',
  'radio', 'region', 'row', 'rowgroup', 'search', 'searchbox', 'slider', 'spinbutton', 'status', 'switch', 'tab',
  'table', 'tablist', 'tabpanel', 'textbox', 'tree', 'treeitem',
] as const

// How a step finds an element. Exactly one of role, label, placeholder,
// testid, title or text. Elements a step acts on are found by role and
// accessible name, label, placeholder, title or data-testid; text is only
// for what a step waits for or scrolls to.
export type Role = (typeof ROLES)[number]
export interface Locator {
  /** A role, or several when it does not matter which (a button that may be a link underneath). */
  role?: Role | Role[]
  name?: string | RegExp
  exact?: boolean
  label?: string | RegExp
  placeholder?: string | RegExp
  testid?: string
  title?: string | RegExp
  text?: string | RegExp
  /** Keep only matches that contain this text. */
  hasText?: string | RegExp
  /** Look inside this element. */
  within?: Locator
  /** Which match: first (default), last, or a zero-based index. */
  nth?: 'first' | 'last' | number
}
const KINDS = ['role', 'label', 'placeholder', 'testid', 'title', 'text'] as const
export const LocatorSchema: z.ZodType<Locator> = z.lazy(() => z.object({
  role: z.union([z.enum(ROLES), z.array(z.enum(ROLES)).min(2)]).optional(),
  name: Name.optional(),
  exact: z.boolean().optional(),
  label: Name.optional(),
  placeholder: Name.optional(),
  testid: z.string().min(1).optional(),
  title: Name.optional(),
  text: Name.optional(),
  hasText: Name.optional(),
  within: LocatorSchema.optional(),
  nth: z.union([z.literal('first'), z.literal('last'), z.number().int()]).optional(),
}).strict().superRefine((l, ctx) => {
  const kinds = KINDS.filter((k) => l[k] !== undefined)
  if (kinds.length !== 1) ctx.addIssue({ code: 'custom', message: `a locator needs exactly one of ${KINDS.join(', ')}; got ${kinds.join(', ') || 'none'}` })
  if (l.name !== undefined && l.role === undefined) ctx.addIssue({ code: 'custom', message: 'name only goes with role' })
}))

// A target a step acts on: never found by its text alone.
const noText = (l: Locator): boolean => l.text === undefined && (!l.within || noText(l.within))
export const TargetSchema = LocatorSchema.refine(noText, { message: 'act on an element by role, label, placeholder, title or testid, not by its text' })

// Up to half an hour: a step may wait on real coding assistants at work.
const Timeout = z.number().int().positive().max(1_800_000)

// A condition a step waits for or branches on.
export type Condition =
  | { visible: Locator }
  | { hidden: Locator }
  | { enabled: Locator }
  | { checked: Locator }
  | { url: string | RegExp }
  | { sql: string; is?: string; not?: string }
  | { value: unknown; is?: Match }
  | { http: Http; where?: Record<string, Match>; at?: string; min?: number }
  | { not: Condition }
export type Match = string | number | boolean | RegExp | { contains: string }
const MatchSchema = z.union([z.string(), z.number(), z.boolean(), z.instanceof(RegExp), z.object({ contains: z.string() }).strict()])

export interface Http {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** A full URL, or a path on the almyty API. Templated. */
  url: string
  body?: unknown
  headers?: Record<string, string>
  /** Sign in as the walk's account (default for API paths). */
  auth?: boolean
  /** Status codes that count as success (default 2xx). */
  ok?: number[]
}
export const HttpSchema: z.ZodType<Http> = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  url: z.string().min(1),
  body: z.unknown().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  auth: z.boolean().optional(),
  ok: z.array(z.number().int()).optional(),
}).strict()

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ visible: LocatorSchema }).strict(),
  z.object({ hidden: LocatorSchema }).strict(),
  z.object({ enabled: LocatorSchema }).strict(),
  z.object({ checked: LocatorSchema }).strict(),
  z.object({ url: z.union([z.string(), z.instanceof(RegExp)]) }).strict(),
  z.object({ sql: z.string().min(1), is: z.string().optional(), not: z.string().optional() }).strict(),
  z.object({ value: z.unknown(), is: MatchSchema.optional() }).strict(),
  z.object({ http: HttpSchema, at: z.string().optional(), where: z.record(z.string(), MatchSchema).optional(), min: z.number().int().positive().optional() }).strict(),
  z.object({ not: ConditionSchema }).strict(),
]))

// One step. Each kind is an object with one leading key naming it.
export type Step =
  | { goto: string }
  | { reload: true }
  | { click: Locator; force?: boolean }
  | { fill: Locator; value: string }
  | { press: Locator; key: string }
  | { key: string }
  | { check: Locator; all?: boolean }
  | { uncheck: Locator; all?: boolean }
  | { select: Locator; option: string | RegExp; search?: string }
  | { upload: Locator; file: string }
  | { expand: Locator }
  | { setChecks: Locator; on: string | RegExp; by?: 'name' | 'label' }
  | { waitFor: Locator; state?: 'visible' | 'hidden' | 'attached'; timeout?: number }
  | { waitForUrl: string | RegExp; timeout?: number }
  | { until: Condition; timeout?: number; every?: number; what?: string; save?: string }
  | { scrollTo: Locator; offset?: number; block?: 'start' | 'center' | 'end' | 'nearest'; inner?: Locator }
  | { scrollTop: true }
  | { scrollBy: number }
  | { viewport: { width: number; height: number } }
  | { shot: string; clip?: Locator; pad?: number }
  | { remember: string; fromUrl?: RegExp; fromInput?: Locator; value?: unknown }
  | { http: Http; save?: string }
  | { sql: string; save?: string }
  | { if: Condition; then: Step[]; else?: Step[] }
  | { repeat: Step[]; while?: Condition; max: number }
  | { each: string; as: string; do: Step[] }
  | { use: string; with?: Record<string, unknown> }
  | { action: string; with?: Record<string, unknown>; save?: string }
  | { as: string; do: Step[] }
  | { render: string; with: Record<string, unknown>; shot: string; clip?: Locator; pad?: number }
  | { download: Locator; save: string }
  | { settle: true; quiet?: number }
  | { restart: true }
  | { ensure: { list: string; at?: string; where: Record<string, Match> }; create?: Http; pick?: string; save?: string }

const S = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()
export const StepSchema: z.ZodType<Step> = z.lazy(() => z.union([
  S({ goto: z.string().min(1) }),
  S({ reload: z.literal(true) }),
  S({ click: TargetSchema, force: z.boolean().optional() }),
  S({ fill: TargetSchema, value: z.string() }),
  S({ press: TargetSchema, key: z.string().min(1) }),
  S({ key: z.string().min(1) }),
  S({ check: TargetSchema, all: z.boolean().optional() }),
  S({ uncheck: TargetSchema, all: z.boolean().optional() }),
  S({ select: TargetSchema, option: Name, search: z.string().optional() }),
  S({ upload: TargetSchema, file: z.string().min(1) }),
  S({ expand: TargetSchema }),
  S({ setChecks: TargetSchema, on: Name, by: z.enum(['name', 'label']).optional() }),
  S({ waitFor: LocatorSchema, state: z.enum(['visible', 'hidden', 'attached']).optional(), timeout: Timeout.optional() }),
  S({ waitForUrl: z.union([z.string(), z.instanceof(RegExp)]), timeout: Timeout.optional() }),
  S({ until: ConditionSchema, timeout: Timeout.optional(), every: z.number().int().positive().optional(), what: z.string().optional(), save: z.string().optional() }),
  S({ scrollTo: LocatorSchema, offset: z.number().int().optional(), block: z.enum(['start', 'center', 'end', 'nearest']).optional(), inner: LocatorSchema.optional() }),
  S({ scrollTop: z.literal(true) }),
  S({ scrollBy: z.number().int() }),
  S({ viewport: S({ width: z.number().int().positive(), height: z.number().int().positive() }) }),
  S({ shot: z.string().min(1), clip: LocatorSchema.optional(), pad: z.number().int().min(0).optional() }),
  S({ remember: z.string().min(1), fromUrl: z.instanceof(RegExp).optional(), fromInput: TargetSchema.optional(), value: z.unknown().optional() }),
  S({ http: HttpSchema, save: z.string().optional() }),
  S({ sql: z.string().min(1), save: z.string().optional() }),
  S({ if: ConditionSchema, then: z.array(StepSchema), else: z.array(StepSchema).optional() }),
  S({ repeat: z.array(StepSchema).min(1), while: ConditionSchema.optional(), max: z.number().int().positive().max(100) }),
  S({ each: z.string().min(1), as: z.string().min(1), do: z.array(StepSchema).min(1) }),
  S({ use: z.string().min(1), with: z.record(z.string(), z.unknown()).optional() }),
  S({ action: z.string().min(1), with: z.record(z.string(), z.unknown()).optional(), save: z.string().optional() }),
  S({ as: z.string().min(1), do: z.array(StepSchema).min(1) }),
  S({ render: z.string().min(1), with: z.record(z.string(), z.unknown()), shot: z.string().min(1), clip: LocatorSchema.optional(), pad: z.number().int().min(0).optional() }),
  S({ download: TargetSchema, save: z.string().min(1) }),
  S({ settle: z.literal(true), quiet: z.number().int().positive().optional() }),
  S({ restart: z.literal(true) }),
  S({ ensure: S({ list: z.string().min(1), at: z.string().optional(), where: z.record(z.string(), MatchSchema) }), create: HttpSchema.optional(), pick: z.string().optional(), save: z.string().optional() }),
]))

// A screenshot the walk takes, as the manifest records it.
export const ShotSchema = S({
  /** Where it is published, under docs-site/public. */
  path: z.string().regex(/^screenshots\/[a-z0-9][a-z0-9/_-]*\.png$/, 'a screenshots/....png path'),
  title: z.string().min(1),
  /** The UI files it shows; editing one marks the image stale. */
  sources: z.array(z.string().min(1)).min(1),
  /** The route the manifest records, when the page is not the app's own (a rendered message). */
  route: z.string().startsWith('/').optional(),
  /** Take the whole page rather than the viewport. */
  fullPage: z.boolean().optional(),
  /** The manifest note for this screenshot, when it differs from the walk's (a rendered message). */
  notes: z.string().min(1).optional(),
})
export type Shot = z.infer<typeof ShotSchema>

export const AccountSchema = S({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  organizationName: z.string().min(1),
  /** How the browser signs in: with the password (default), or not at all (a step signs in, e.g. through SSO). */
  signIn: z.enum(['password', 'none']).optional(),
  /** Leave the account to a step (an invitation, SSO) instead of registering it up front. */
  register: z.boolean().optional(),
})
export type Account = z.infer<typeof AccountSchema>

export const BrowserSchema = S({
  /** Device pixels per CSS pixel (default 2). */
  scale: z.union([z.literal(1), z.literal(2)]).optional(),
  viewport: S({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  /** Not signed in: what a visitor sees. */
  anonymous: z.boolean().optional(),
  theme: z.enum(['light', 'dark']).optional(),
  /** Hosts whose pages are answered with a stub instead of opened (real sign-in pages). */
  block: z.array(z.string().min(1)).optional(),
  /** Send a connected model provider's key to this fake vendor (templated, may use {type}). */
  providerUrl: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  /** Requests to these hosts go to a fake instead (host -> base URL, templated). */
  forward: z.record(z.string(), z.string()).optional(),
  /** Default step timeout, ms. */
  timeout: Timeout.optional(),
})

export const WalkSchema = S({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  title: z.string().min(1),
  /** The stack profile it needs (stack.sh PROFILE=...): which fake upstream answers. */
  profile: z.string().min(1),
  /** Who it signs in as; leave out for a walk that only seeds through the API. */
  account: AccountSchema.optional(),
  /** Extra people, for steps under { as: name }. */
  people: z.record(z.string(), AccountSchema).optional(),
  /** Walks that must have run before this one, in order. */
  after: z.array(z.string()).optional(),
  browser: BrowserSchema.optional(),
  /** No browser: a seed that only calls the API. */
  headless: z.boolean().optional(),
  /** The manifest note for its screenshots. */
  notes: z.string().min(1).optional(),
  /** Values steps can use as {{name}}. */
  vars: z.record(z.string(), z.unknown()).optional(),
  shots: z.record(z.string(), ShotSchema),
  steps: z.array(StepSchema).min(1),
}).superRefine((w, ctx) => {
  const issues = checkShots(w.steps, w.shots)
  for (const issue of issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  if (w.headless && Object.keys(w.shots).length) ctx.addIssue({ code: 'custom', path: ['shots'], message: 'a headless walk takes no screenshots' })
})
export type Walk = z.infer<typeof WalkSchema>

/** Every step that takes a screenshot, with where it sits; repeat and each bodies may not take one. */
export function shotSteps(steps: Step[], path: (string | number)[] = ['steps'], inLoop = false): { id: string; path: (string | number)[]; inLoop: boolean }[] {
  return steps.flatMap((s, i) => {
    const at = [...path, i]
    const own = 'shot' in s && typeof s.shot === 'string' ? [{ id: s.shot, path: at, inLoop }] : []
    const nested = (['then', 'else', 'do', 'repeat'] as const).flatMap((key) => {
      const inner = (s as Record<string, unknown>)[key]
      return Array.isArray(inner) ? shotSteps(inner as Step[], [...at, key], inLoop || key === 'repeat' || 'each' in s) : []
    })
    return [...own, ...nested]
  })
}

/** One step per declared shot, and no step taking an undeclared one. Unexpanded `use` steps are not looked into. */
export function checkShots(steps: Step[], shots: Record<string, unknown>): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = []
  const taken = new Map<string, number>()
  for (const s of shotSteps(steps)) {
    if (!shots[s.id]) issues.push({ path: s.path, message: `shot ${s.id} is not declared in shots` })
    if (s.inLoop) issues.push({ path: s.path, message: `shot ${s.id} is inside a repeat or each, so it could be taken more than once` })
    taken.set(s.id, (taken.get(s.id) ?? 0) + 1)
  }
  const expanded = !JSON.stringify(steps, (_k, v) => (v instanceof RegExp ? String(v) : v)).includes('"use":')
  for (const id of Object.keys(shots)) {
    const n = taken.get(id) ?? 0
    if (n === 0 && expanded) issues.push({ path: ['shots', id], message: `shot ${id} is declared but no step takes it` })
    if (n > 1) issues.push({ path: ['shots', id], message: `shot ${id} is taken by ${n} steps; one step per screenshot` })
  }
  return issues
}

/** Parse a walk, or throw one error naming the walk and every bad field. */
export function parseWalk(input: unknown): Walk {
  const r = WalkSchema.safeParse(input)
  if (r.success) return r.data
  const id = (input as { id?: unknown })?.id
  const lines = r.error.issues.map((i) => `  ${i.path.join('.') || '(walk)'}: ${i.message}`)
  throw new Error(`walk ${typeof id === 'string' ? id : '(no id)'} is invalid:\n${lines.join('\n')}`)
}
