// Tidewater Labs: the engineering example guides (GitHub issue triage, pull
// request review, on-call summaries from PagerDuty, an old SOAP service, a
// fleet of coding assistants on a runner), walked as Ines Duarte.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Family } from '../../engine/load.ts'
import { ROOT, sql } from '../../engine/env.ts'
import { request } from '../../engine/http.ts'
import { signIn } from '../../engine/run.ts'
import { escapeHtml as esc } from '../../engine/render.ts'
import { PROFILES } from '../profiles.ts'
import { guides } from './guides.ts'

const q = (s: string) => `'${s.replace(/'/g, "''")}'`

// ---------- the runner, as Ines would start it on her laptop ----------

let runner: ChildProcess | undefined
const stopRunner = () => { runner?.kill(); runner = undefined }
process.on('exit', stopRunner)

// ---------- what a stand-in received, laid out the way its service shows it ----------

// The box the screenshot keeps: the card and the note under it, with a margin.
const CLIP = `<div data-testid="clip" style="position:absolute;pointer-events:none"></div><script>
const a = document.querySelector('.wrap').getBoundingClientRect(), b = document.querySelector('.note').getBoundingClientRect(), c = document.querySelector('[data-testid=clip]')
Object.assign(c.style, { left: (a.x - 24 + scrollX) + 'px', top: (Math.max(0, a.y - 24) + scrollY) + 'px', width: (a.width + 48) + 'px', height: (b.bottom - a.y + 40) + 'px' })
</script>`
const PAGE = (title: string, body: string, note: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;background:#f6f8fa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328}
.wrap{max-width:900px;margin:28px auto;background:#fff;border:1px solid #d0d7de;border-radius:8px;overflow:hidden}
.head{padding:16px 20px;border-bottom:1px solid #d0d7de;background:#f6f8fa;font-size:14px}.head b{font-size:15px}
.body{padding:16px 20px;font-size:14px;line-height:1.55;white-space:pre-wrap}
.file{margin:0 20px 16px;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}.path{padding:8px 12px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font:12px ui-monospace,Menlo,monospace}
.code{font:12px ui-monospace,Menlo,monospace;background:#e6ffec;padding:4px 12px;white-space:pre}.ln{color:#59636e;display:inline-block;width:34px}
.cmt{padding:10px 12px;font-size:14px;line-height:1.5;border-top:1px solid #d0d7de}.who{font-weight:600;margin-bottom:4px}.who span{font-weight:400;color:#59636e}
.chan{padding:14px 24px;border-bottom:1px solid #e4e4e7;font-weight:600}.msg{padding:14px 24px}.text{white-space:pre-wrap;font-size:15px;line-height:1.5}
.note{max-width:900px;margin:0 auto 24px;font-size:12px;color:#59636e}</style></head><body>${body}<div class="note">${esc(note)}</div>${CLIP}</body></html>`
const md = (t: unknown) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
const slackText = (t: unknown) => esc(t).replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+?)&gt;/g, '<a href="$1">$2</a>').replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/gm, '$1<b>$2</b>').replace(/`([^`]+)`/g, '<code>$1</code>')

export const tidewater: Family = {
  name: 'tidewater',
  walks: guides,
  actions: {
    /**
     * Each guide starts where a new customer starts: her organization goes,
     * and she makes a new one, as a signed-in user can. Then the browser
     * signs in. Answers where the fakes are.
     */
    tidewaterStart: async (run) => {
      const account = run.walk.account!
      const person = run.person!
      sql(run.env, `DELETE FROM organizations WHERE id IN (SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = ${q(account.email)})`)
      await request(run.env, { method: 'POST', url: '/organizations', body: { name: account.organizationName, slug: 'tidewater-labs' } }, person.token)
      const [orgId = '', slug = ''] = sql(run.env, `SELECT o.id || '|' || o.slug FROM user_organizations uo JOIN users u ON u.id = uo."userId" JOIN organizations o ON o.id = uo."organizationId" WHERE u.email = ${q(account.email)} AND o.name = ${q(account.organizationName)} LIMIT 1`).split('|')
      if (!orgId) throw new Error('the new organization is not there')
      // The fakes are on localhost: the organization says that host is its own.
      sql(run.env, `UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || '{"egressAllowlist":["localhost"]}'::jsonb WHERE id = '${orgId}'`)
      Object.assign(person, { orgId, slug })
      Object.assign(run.vars, { org: { id: orgId, slug } })
      if (run.session) {
        await run.session.context.clearCookies()
        await signIn(run.session, account)
      }
      // The fakes start over too: issues unlabelled, no review, no note, nothing in Slack.
      const url = `http://localhost:${PROFILES.tidewater.fakes[0].port + Number(process.env.DEMO_PORT_OFFSET || 0)}`
      for (const base of [url, run.env.upstream]) await request(run.env, { method: 'POST', url: `${base}/_admin/reset` })
      return {
        url,
        githubFile: join(ROOT, 'docs-site/public/files/github-issues-and-pulls.openapi.json'),
      }
    },

    /** Try it's whole card, answer included, marked for a clipped screenshot (the card has no handle of its own). */
    tryItCard: async (run) => {
      await run.session!.page.getByRole('heading', { name: 'Try it' }).first().evaluate((el) => {
        el.scrollIntoView({ block: 'start' })
        let card = el as HTMLElement
        while (card.parentElement && card.getBoundingClientRect().height < 300) card = card.parentElement
        // The answer scrolls inside the card; show all of it for the picture.
        for (const d of card.querySelectorAll<HTMLElement>('*')) {
          const s = getComputedStyle(d)
          if (/(auto|scroll)/.test(s.overflowY) || s.maxHeight !== 'none') { d.style.maxHeight = 'none'; d.style.overflow = 'visible'; d.style.height = 'auto' }
        }
        card.setAttribute('data-testid', 'demo-clip')
      })
    },

    /** The library the coding assistants work on: a few lines of Ledgerly's helpers, in /tmp/tidewater/ledgerly-utils. */
    sampleLibrary: async () => {
      const dir = '/tmp/tidewater/ledgerly-utils'
      mkdirSync(join(dir, 'src'), { recursive: true }); mkdirSync(join(dir, 'test'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@tidewater/ledgerly-utils', version: '0.4.0', description: 'Small helpers shared by the Ledgerly apps', type: 'module', main: 'src/index.js', scripts: { test: 'node --test' } }, null, 2) + '\n')
      writeFileSync(join(dir, 'src/index.js'), "export { formatMoney } from './money.js'\n")
      writeFileSync(join(dir, 'src/money.js'), "// Format an amount in cents, e.g. formatMoney(418000, 'EUR') -> \"4,180.00 EUR\"\nexport function formatMoney(cents, currency) {\n  const value = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })\n  return `${value} ${currency}`\n}\n")
      writeFileSync(join(dir, 'test/money.test.js'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { formatMoney } from '../src/index.js'\n\ntest('formats cents with two decimals and the currency', () => {\n  assert.equal(formatMoney(418000, 'EUR'), '4,180.00 EUR')\n})\n")
      return dir
    },

    /**
     * Start @almyty/runner (ALMYTY_RUNNER_BIN or almyty-runner on PATH) as Ines,
     * in /tmp/tidewater: { name }. Her API token stands in for "almyty login".
     */
    startRunner: async (run, a) => {
      // A coding assistant started from inside another one's session refuses to run; this one starts clean.
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)))
      const state = join(run.out, 'runner-state')
      mkdirSync(state, { recursive: true })
      stopRunner()
      runner = spawn(process.env.ALMYTY_RUNNER_BIN || 'almyty-runner', ['start', '--name', String(a.name), '--org', run.person!.orgId, '--url', run.env.api], {
        cwd: '/tmp/tidewater', env: { ...env, ALMYTY_TOKEN: run.person!.token, ALMYTY_URL: run.env.api, ALMYTY_RUNNER_STATE_DIR: state }, stdio: ['ignore', 'inherit', 'inherit'],
      })
      runner.on('error', (e) => run.log(`    runner: ${e.message}`))
    },
    stopRunner: async () => { stopRunner() },
  },
  templates: {
    /** { review, patch }: a review as the GitHub API received it, laid out the way GitHub shows one. */
    githubReview: (d) => {
      const r = d.review as any
      const patch = (d.patch ?? {}) as Record<string, Record<string, string>>
      const files: Record<string, any[]> = {}
      for (const c of r.comments) (files[c.path] ||= []).push(c)
      return PAGE('Review on #212', `<div class="wrap"><div class="head"><b>ledgerly-review[bot]</b> reviewed <b>#212 Add late fees to overdue invoices</b> · commented</div><div class="body">${md(r.body)}</div>
${Object.entries(files).map(([p, cs]) => `<div class="file"><div class="path">${esc(p)}</div>${cs.map((c) => `<div class="code"><span class="ln">${c.line}</span>+${esc(patch[p]?.[c.line] ?? '')}</div><div class="cmt"><div class="who">ledgerly-review[bot] <span>commented</span></div>${md(c.body)}</div>`).join('')}</div>`).join('')}</div>`,
      'The review exactly as almyty sent it to the GitHub API, laid out the way GitHub shows a review (local demo; GitHub itself was not used).')
    },
    /** { text }: the on-call report as Slack received it, in #incidents. */
    slackIncident: (d) => PAGE('Slack', `<div class="wrap"><div class="chan"># incidents</div><div class="msg"><div class="who">On-call summaries <span>APP</span></div><div class="text">${slackText(d.text)}</div></div></div>`,
      'The message exactly as almyty posted it to Slack, shown the way Slack formats it (local demo; Slack itself was not used).'),
  },
}
