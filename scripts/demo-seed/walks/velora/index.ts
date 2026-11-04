// Velora Energy: the governance example guides (walks/velora/guides.ts),
// with the steps, actions and pages only they use.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Family } from '../../engine/load.ts'
import type { Step } from '../../engine/schema.ts'
import { escapeHtml } from '../../engine/render.ts'
import { guides, EVA, TOM } from './guides.ts'

const need = (a: Record<string, unknown>, key: string): string => {
  const v = a[key]
  if (typeof v !== 'string' || !v) throw new Error(`needs ${key}`)
  return v
}

// The visibility picker's Team select has no accessible name; it is found by the team it shows.
const TEAM_PICK = /^(Finance|Customer support|Everyone|Pick a team)/

// ---------- pages for what a fake received ----------

/** { events }: the audit events the Splunk HEC fake received, as a Splunk search shows them. */
function splunkPage(d: Record<string, unknown>): string {
  const events = (d.events as any[]) ?? []
  const shown = events.filter((e) => ['run_start', 'tool_execute'].includes(e.body?.event?.action))
  const rows = shown.slice(-10).reverse().map((e) => {
    const ev = e.body?.event || {}
    const params = ev.details?.parameters ? JSON.stringify(ev.details.parameters) : ''
    return `<tr><td>${escapeHtml(new Date(ev.createdAt || e.at).toISOString().replace('T', ' ').slice(0, 19))}</td><td><code>${escapeHtml(ev.action)}</code></td><td>${escapeHtml(ev.userEmail || '')}</td><td>${escapeHtml(ev.resourceName || '')}</td><td>${escapeHtml(ev.status || '')}</td><td class="j">${escapeHtml(params.slice(0, 220))}</td></tr>`
  }).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}
.wrap{max-width:1360px;margin:28px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
.q{padding:14px 20px;border-bottom:1px solid #e4e4e7;font-family:Menlo,monospace;font-size:13px;background:#fafafa}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #f1f1f3;vertical-align:top}
th{font-weight:600;color:#52525b;background:#fafafa}code{font-family:Menlo,monospace;font-size:12px;color:#7c3aed}.j{font-family:Menlo,monospace;font-size:11.5px;color:#52525b;word-break:break-all}
.note{max-width:1360px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body>
<div class="wrap"><div class="q">index=almyty_audit sourcetype="almyty:audit" action IN (run_start, tool_execute)</div>
<table><tr><th>_time (UTC)</th><th>action</th><th>userEmail</th><th>resourceName</th><th>status</th><th>details.parameters</th></tr>${rows}</table></div>
<div class="note">The events exactly as almyty sent them to the Splunk HTTP Event Collector, newest first, laid out as a table (local demo; Splunk itself was not used).</div></body></html>`
}

/** { md }: the downloaded technical documentation, sections 1 to 4, as a Markdown viewer shows it. */
function techDocPage(d: Record<string, unknown>): string {
  // Sections 1 to 4 fit one picture; the rest of the file is the same kind of list.
  const shown = String(d.md ?? '').split(/^## 5\./m)[0]
  const table = (block: string) => {
    const rows = block.trim().split('\n').filter((l) => !/^\|[-| ]+\|$/.test(l)).map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    return `<table>${rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join('')}</tr>`).join('')}</table>`
  }
  // The file's entities (&lt;p&gt; in an imported API's description) read as the characters they stand for.
  const viewed = shown.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const mdHtml = escapeHtml(viewed)
    .replace(/(?:^\|.*\|$\n?)+/gm, (b) => table(b))
    .replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^_(.*)_$/gm, '<i>$1</i>')
    .replace(/^- (.*)$/gm, '<li>$1</li>').replace(/\n{2,}/g, '\n')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}
.doc{max-width:1000px;margin:28px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px 40px;white-space:pre-wrap;font-size:14px;line-height:1.5}
h1{font-size:24px;margin:0}h2{font-size:18px;margin:14px 0 4px}h3{font-size:15px;margin:6px 0 0}li{margin-left:18px}code{font-family:Menlo,monospace;font-size:12.5px}
table{border-collapse:collapse;white-space:normal;font-size:12.5px;margin:4px 0}th,td{border:1px solid #e4e4e7;padding:4px 8px;text-align:left;vertical-align:top}th{background:#fafafa}
.note{max-width:1000px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body><div class="doc">${mdHtml}</div>
<div class="note">billing-assistant-technical-documentation.md, as the Tech doc button downloaded it, shown formatted. Sections 1 to 4; the file goes on with 5. Data governance, 6. Logging and traceability and 7. Change history.</div></body></html>`
}

// ---------- Entra ID's provisioning service ----------

type Claims = typeof EVA
const scimUser = (p: Claims, nick: string) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
  externalId: nick, userName: p.email, active: true, displayName: `${p.given_name} ${p.family_name}`,
  emails: [{ primary: true, type: 'work', value: p.email }], name: { formatted: `${p.given_name} ${p.family_name}`, familyName: p.family_name, givenName: p.given_name },
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Field service' },
})

export const velora: Family = {
  name: 'velora',
  walks: guides,
  macros: {
    /** "Who can use it": One team, then the team: { team }. */
    chooseTeam: (a): Step[] => [
      { if: { visible: { role: 'button', name: 'Change', exact: true, within: { testid: 'who-can-use' } } }, then: [
        { click: { role: 'button', name: 'Change', exact: true, within: { testid: 'who-can-use' } } },
      ] },
      { click: { role: 'radio', name: /One team/ } },
      { select: { role: 'combobox', hasText: TEAM_PICK }, option: need(a, 'team') },
    ],

    /** Connect an OpenAPI description from its link for one team, at the fake's address: { link, name, address, team, shot? }. */
    connectApiFor: (a): Step[] => [
      { goto: '/apis/new/openapi' },
      { fill: { label: 'Link to the description' }, value: need(a, 'link') },
      { click: { role: 'button', name: 'Advanced' } },
      { fill: { label: 'Name', exact: true }, value: need(a, 'name') },
      // The local fake, not the real service.
      { fill: { label: 'Address', exact: true }, value: need(a, 'address') },
      { use: 'chooseTeam', with: { team: need(a, 'team') } },
      ...(typeof a.shot === 'string' ? [{ scrollTop: true }, { shot: a.shot }] as Step[] : []),
      { click: { role: 'button', name: 'Connect API' } },
      { waitForUrl: /\/setup/, timeout: 180000 },
      { waitFor: { text: /Found \d+ operation/ }, timeout: 300000 },
    ],

    /** A new approval policy: { name, description, team?, conditions: [attr, op, value][], steps: [name, role, min][], priority?, shot? }. */
    policy: (a): Step[] => {
      const conditions = a.conditions as [string, string, string][]
      const steps = a.steps as [string, string, number][]
      return [
        { goto: '/settings/approvals/policies/new' },
        { fill: { label: 'Name', exact: true }, value: need(a, 'name') },
        { fill: { label: 'Description', exact: true }, value: need(a, 'description') },
        ...(typeof a.team === 'string' ? [{ use: 'chooseTeam', with: { team: a.team } }] as Step[] : []),
        ...conditions.flatMap(([attr, op, value], i): Step[] => [
          { click: { role: 'button', name: 'Add condition' } },
          { fill: { label: `Condition ${i + 1} attribute` }, value: attr },
          { select: { label: `Condition ${i + 1} operator` }, option: op },
          { fill: { label: `Condition ${i + 1} value` }, value },
        ]),
        ...steps.flatMap(([name, role, min], i): Step[] => [
          ...(i > 0 ? [{ click: { role: 'button', name: 'Add step' } }] as Step[] : []),
          { fill: { label: `Step ${i + 1} name` }, value: name },
          { fill: { label: `Step ${i + 1} approver role` }, value: role },
          { fill: { label: `Step ${i + 1} minimum approvals` }, value: String(min) },
        ]),
        ...(a.priority ? [
          { click: { role: 'button', name: /^Advanced/ } },
          { fill: { label: 'Priority' }, value: String(a.priority) },
        ] as Step[] : []),
        ...(typeof a.shot === 'string' ? [{ scrollTo: { text: 'When it applies' }, offset: 140 }, { shot: a.shot }] as Step[] : []),
        { click: { role: 'button', name: 'Create policy' } },
        { waitForUrl: /\/settings\/approvals$/, timeout: 20000 },
      ]
    },

    /** Turn the nth switch on the page on or off: { nth, on }. The SSO switches have no name of their own. */
    setSwitch: (a): Step[] => {
      const sw = { role: 'switch', nth: Number(a.nth) } as const
      return [{ if: a.on ? { not: { checked: sw } } : { checked: sw }, then: [{ click: sw }] }]
    },
  },
  actions: {
    /**
     * The walks sign people in many times within minutes; the local stack's
     * sign-in rate limit (kept in its Redis) would refuse them. Demo stack only.
     */
    unthrottle: async () => {
      const redis = process.env.REDIS_NAME || 'almyty-demo-redis'
      const cli = (args: string[]) => execFileSync('docker', ['exec', '-i', redis, 'redis-cli', ...args], { encoding: 'utf8' })
      let n = 0
      for (const pattern of ['*throttle*', '*:default}*']) {
        const keys = cli(['--scan', '--pattern', pattern]).split('\n').filter(Boolean)
        if (keys.length) { cli(['del', ...keys]); n += keys.length }
      }
      return n
    },

    /** A colleague accepts the invitation the way the in-app notification does: { email, password }. */
    acceptInvite: async (run, a) => {
      const login = await fetch(`${run.env.api}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: need(a, 'email'), password: need(a, 'password') }) })
      if (!login.ok) throw new Error(`login ${a.email} ${login.status}`)
      const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
      const orgId = (run.vars.org as { id: string }).id
      const q = (s: string) => `'${s.replace(/'/g, "''")}'`
      const row = execFileSync('docker', ['exec', '-i', run.env.pgContainer, 'psql', '-U', 'postgres', '-d', run.env.database, '-tA'], {
        input: `SELECT uo.id || '|' || uo."inviteAccepted" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = ${q(need(a, 'email'))} AND uo."organizationId" = '${orgId}'`, encoding: 'utf8',
      }).trim()
      if (!row) throw new Error(`no invitation for ${a.email}`)
      const [membership, accepted] = row.split('|')
      if (accepted === 't') return membership
      const r = await fetch(`${run.env.api}/invites/membership/${membership}/accept`, { method: 'POST', headers: { cookie } })
      if (!r.ok) throw new Error(`accept ${a.email} ${r.status} ${await r.text()}`)
      return membership
    },

    /** The requests Microsoft Entra's provisioning service sends, in its order: { token, ops: ('test' | 'users' | 'leaver')[] }. */
    entraProvisioning: async (run, a) => {
      const token = need(a, 'token')
      const ops = (a.ops as string[]) ?? []
      const scim = (path: string, method = 'GET', body?: unknown) => fetch(`${run.env.api}/scim/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' }, body: body ? JSON.stringify(body) : undefined })
        .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }))
      const log: [string, { status: number }][] = []
      const find = async (p: Claims) => (await scim(`/Users?filter=${encodeURIComponent(`userName eq "${p.email}"`)}`)).body?.Resources?.[0]
      if (ops.includes('test')) log.push(['Test Connection', await scim(`/Users?filter=${encodeURIComponent('userName eq "f3b8c1d2-0000-4000-8000-000000000000"')}`)])
      if (ops.includes('users')) {
        for (const [p, nick] of [[EVA, 'eva.degroot'], [TOM, 'tom.hendriks']] as const) {
          if (!(await find(p))) log.push([`Create ${p.email}`, await scim('/Users', 'POST', scimUser(p, nick))])
        }
        const groups = (await scim(`/Groups?filter=${encodeURIComponent('displayName eq "Field service"')}`)).body?.Resources || []
        let group = groups.find((g: any) => g.displayName === 'Field service')
        if (!group) group = (await scim('/Groups', 'POST', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], externalId: 'a91f0c3e-field-service', displayName: 'Field service', members: [] })).body
        const ids = [(await find(EVA)).id, (await find(TOM)).id]
        log.push(['Add members to Field service', await scim(`/Groups/${group.id}`, 'PATCH', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Add', path: 'members', value: ids.map((value) => ({ value })) }] })])
      }
      if (ops.includes('leaver')) {
        const tom = await find(TOM)
        log.push(['Disable tom.hendriks', await scim(`/Users/${tom.id}`, 'PATCH', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] })])
      }
      for (const [what, r] of log) run.log(`    scim ${what} ${r.status}`)
      const bad = log.filter(([, r]) => r.status >= 400)
      if (bad.length) throw new Error(`SCIM refused: ${bad.map(([w, r]) => `${w} ${r.status}`).join(', ')}`)
      return log.map(([w, r]) => `${w} ${r.status}`)
    },

    /** A file's text, such as a download: { file }. */
    readFile: async (_run, a) => readFileSync(need(a, 'file'), 'utf8'),
  },
  templates: { 'velora-splunk': splunkPage, 'velora-techdoc': techDocPage },
}
