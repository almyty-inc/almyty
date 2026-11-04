// Macros: named runs of steps that several walks share (connect an API
// from its link, tick tools in the picker, approve what waits). A walk says
// { use: 'pickTools', with: { tools: [...] } } and the loader puts the steps
// in its place before the walk is checked, so a macro's steps are validated
// and its screenshots counted like any other.
import type { Step } from './schema.ts'

export type Macro = (args: Record<string, unknown>) => Step[]

const str = (args: Record<string, unknown>, key: string): string => {
  const v = args[key]
  if (typeof v !== 'string' || !v) throw new Error(`needs ${key}`)
  return v
}
const opt = (args: Record<string, unknown>, key: string): string | undefined => (typeof args[key] === 'string' ? (args[key] as string) : undefined)
const shot = (id: string | undefined): Step[] => (id ? [{ shot: id }] : [])

export const MACROS: Record<string, Macro> = {
  /** Tick tools by machine name in the agent builder's picker: { tools: string[] }. */
  pickTools: (a) => {
    const tools = a.tools
    if (!Array.isArray(tools) || !tools.length) throw new Error('needs tools')
    const search = { role: 'textbox', name: 'Search tools' } as const
    return [
      ...tools.flatMap((t): Step[] => [
        { fill: search, value: String(t) },
        { settle: true },
        { expand: { role: 'button', name: /\d+ tools?/ } },
        { check: { role: 'checkbox', name: String(t), exact: true } },
      ]),
      { fill: search, value: '' },
    ]
  },

  /** Connect an OpenAPI description from its link, at a fake's address: { link, name, address, linkShot? }. */
  importApi: (a) => [
    { goto: '/apis/new/openapi' },
    { fill: { label: 'Link to the description' }, value: str(a, 'link') },
    ...shot(opt(a, 'linkShot')),
    { click: { role: 'button', name: 'Advanced' } },
    { fill: { label: 'Name', exact: true }, value: str(a, 'name') },
    // The local fake, not the real service.
    { fill: { label: 'Address', exact: true }, value: str(a, 'address') },
    { click: { role: 'button', name: 'Connect API' } },
    { waitForUrl: /\/setup/, timeout: 90000 },
    { waitFor: { text: /Found \d+ operation/ }, timeout: 180000 },
  ],

  /** Pick a saved sign-in on an API's setup page: { name: string | RegExp }. */
  pickSignIn: (a) => [
    { select: { role: 'combobox', name: 'Sign-in' }, option: a.name as string | RegExp },
    { waitFor: { text: 'Saved. Tools send it with every call.' }, timeout: 15000 },
  ],

  /** On a sign-in form, paste a token instead of signing in with the provider: { name, token, field? }. */
  pasteToken: (a) => [
    { click: { role: 'button', name: 'Paste an access token instead' } },
    { fill: { role: 'textbox', name: 'Name', exact: true, nth: 'last' }, value: str(a, 'name') },
    { fill: { role: 'textbox', name: (a.field as string | RegExp | undefined) ?? 'Access token', nth: 'last' }, value: str(a, 'token') },
  ],

  /** Save the sign-in form and wait for it to stick. */
  saveSignIn: () => [
    { click: { role: 'button', name: 'Save', exact: true, nth: 'first' } },
    { waitFor: { text: 'Saved. Tools send it with every call.' }, timeout: 15000 },
  ],

  /** Connect OpenAI on /models/providers/new: { name?, key, shot? } (the key goes to the fake vendor). */
  connectOpenAI: (a) => [
    { goto: '/models/providers/new' },
    { fill: { label: 'Name', exact: true }, value: opt(a, 'name') ?? 'OpenAI' },
    { select: { role: 'combobox', name: 'Provider' }, search: 'OpenAI', option: 'OpenAI' },
    { fill: { label: /API key/ }, value: str(a, 'key') },
    ...shot(opt(a, 'shot')),
    { click: { role: 'button', name: 'Save', exact: true } },
    { waitForUrl: /\/models\/providers\/[0-9a-f-]{36}/, timeout: 60000 },
  ],

  /** A new autonomous agent: { name, model?, personality?, instructions }. */
  newAgent: (a) => [
    { goto: '/agents/new' },
    { click: { role: 'button', name: 'Autonomous' } },
    { fill: { role: 'textbox', name: 'Agent name' }, value: str(a, 'name') },
    { select: { role: 'combobox', name: 'Model' }, option: (a.model as string | RegExp | undefined) ?? /gpt-4o(?!-mini)/ },
    ...(opt(a, 'personality') ? [{ fill: { role: 'textbox', name: 'Personality and style' }, value: str(a, 'personality') } as Step] : []),
    { fill: { role: 'textbox', name: 'Instructions' }, value: str(a, 'instructions') },
  ],

  /** Save the agent in the builder and remember its id: { as }. */
  saveAgent: (a) => [
    { click: { role: 'button', name: 'Save', exact: true } },
    { waitForUrl: /\/agents\/[0-9a-f-]{36}\/edit/, timeout: 20000 },
    { remember: str(a, 'as') },
  ],

  /** Open an agent and turn it on: { agent } (an id). */
  activate: (a) => [
    { goto: `/agents/${str(a, 'agent')}` },
    { click: { role: 'button', name: 'Activate' } },
  ],

  /** Ask the agent something in Try it and wait for the answer: { message, answer, shot? }. */
  tryIt: (a) => [
    { fill: { placeholder: 'Type a message to test this agent...' }, value: str(a, 'message') },
    { press: { placeholder: 'Type a message to test this agent...' }, key: 'Enter' },
    { waitFor: { role: 'status', hasText: a.answer as string | RegExp }, timeout: 120000 },
    { scrollTo: { text: 'Try it', exact: true }, offset: 90 },
    ...shot(opt(a, 'shot')),
  ],

  /** Approve everything that waits in Approvals, one at a time: { note? }. */
  approveAll: (a) => [
    { goto: '/approvals' },
    {
      repeat: [
        { click: { role: 'button', name: 'Approve', exact: true } },
        ...(opt(a, 'note') ? [{ fill: { role: 'textbox', name: 'Note (optional)' }, value: str(a, 'note') } as Step] : []),
        { click: { role: 'button', name: 'Approve', within: { role: 'form', name: 'Approve this action' } } },
        { waitFor: { role: 'form', name: 'Approve this action' }, state: 'hidden' },
        { goto: '/approvals' },
      ],
      while: { visible: { role: 'button', name: 'Approve', exact: true } },
      max: 12,
    },
  ],
}

/** Put every macro's steps in place of its `use`, all the way down. */
export function expand(steps: Step[], macros: Record<string, Macro>, trail: string[] = []): Step[] {
  return steps.flatMap((s): Step[] => {
    if ('use' in s) {
      const m = macros[s.use]
      if (!m) throw new Error(`no macro called ${s.use}`)
      if (trail.includes(s.use)) throw new Error(`macro ${s.use} uses itself`)
      let made: Step[]
      try { made = m(s.with ?? {}) } catch (e) { throw new Error(`macro ${s.use}: ${(e as Error).message}`) }
      return expand(made, macros, [...trail, s.use])
    }
    const copy = { ...s } as Record<string, unknown>
    for (const key of ['then', 'else', 'do', 'repeat']) {
      if (Array.isArray(copy[key])) copy[key] = expand(copy[key] as Step[], macros, trail)
    }
    return [copy as Step]
  })
}
