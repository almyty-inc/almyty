import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { serve } from '../fakes/server.ts'
import { larkspur as service, bigquery, xeroWhere } from '../fakes/services/larkspur.ts'
import { decide } from '../fakes/models/larkspur.ts'
import { load } from '../engine/load.ts'
import { larkspur } from '../walks/larkspur/index.ts'

async function start() {
  const [server, v6] = serve([service], { port: 0 })
  await new Promise((r) => server.once('listening', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => { server.close(); v6.close() } }
}

const fn = (name: string) => ({ type: 'function', function: { name, parameters: {} } })
const PAYOUT_SYSTEM = "You check Larkspur Home's Stripe payouts against Xero every morning. In Xero, list the bank transactions with xero-tenant-id 7a3c51e2-0d4b-4c7e-9a52-6f1e8b2d4c90."

test('the payout check calls Stripe, then Xero, and finds the wrong and the missing booking', async (t) => {
  const s = await start()
  t.after(s.close)
  const tools = ['stripe_get_payouts', 'stripe_get_balance_transactions', 'xero_accounting_get_bank_transactions'].map(fn)
  const messages: any[] = [{ role: 'system', content: PAYOUT_SYSTEM }, { role: 'user', content: "Check yesterday's payouts." }]
  // Run each tool call against the fake, the way the platform would.
  const run = async (c: any) => {
    const a = c.args
    if (c.name === 'stripe_get_payouts') return fetch(`${s.url}/stripe/v1/payouts?arrival_date=${a.arrival_date}&status=${a.status}&limit=${a.limit}`)
    if (c.name === 'stripe_get_balance_transactions') return fetch(`${s.url}/stripe/v1/balance_transactions?payout=${a.payout}&limit=${a.limit}`)
    return fetch(`${s.url}/xero/api.xro/2.0/BankTransactions?where=${encodeURIComponent(a.where)}`, { headers: { 'xero-tenant-id': a['xero-tenant-id'] } })
  }
  const called: string[] = []
  let answer = ''
  for (let i = 0; i < 10 && !answer; i++) {
    const d = decide({ messages, tools })
    if (d.content) { answer = d.content; break }
    const c = d.toolCalls![0]
    assert.match(c.id!, /^call_[a-z]+_\d+/)
    called.push(c.name)
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] })
    messages.push({ role: 'tool', tool_call_id: c.id, content: await (await run(c)).text() })
  }
  assert.deepEqual(called, ['stripe_get_payouts', 'stripe_get_balance_transactions', 'stripe_get_balance_transactions', 'stripe_get_balance_transactions', 'xero_accounting_get_bank_transactions'])
  assert.match(answer, /3 payouts, 1 match Xero, 2 need a look/)
  assert.match(answer, /\*\*Xero has £6,921\.10\*\*/)
  assert.match(answer, /USD \$2,310\.00\*\* \(`po_1QLk7oF4aRhG2xYzUSD0921`\): \*\*not in Xero/)
  assert.match(answer, /€1,480\.00: Refund for order LH-20931/)
})

test('BigQuery runs SELECTs over the shop tables and refuses writes', () => {
  const [status, out] = bigquery({ query: "SELECT COUNT(*) AS orders FROM orders WHERE shipping_country = 'DE' AND DATE(created_at) = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)", defaultDataset: { projectId: 'larkspur-analytics', datasetId: 'shop' } }) as [number, any]
  assert.equal(status, 200)
  assert.equal(out.schema.fields[0].name, 'orders')
  assert.ok(Number(out.rows[0].f[0].v) > 100)
  const [fresh, tables] = bigquery({ query: 'SELECT table_id, TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(last_modified_time), HOUR) AS h FROM shop.__TABLES__ ORDER BY table_id' }) as [number, any]
  assert.equal(fresh, 200)
  const hours = Object.fromEntries(tables.rows.map((r: any) => [r.f[0].v, Number(r.f[1].v)]))
  assert.equal(hours.web_sessions, 31)
  assert.equal(hours.orders, 0)
  assert.equal(bigquery({ query: 'DELETE FROM orders WHERE 1=1' })[0], 403)
})

test('the data questions agent writes the query, and refuses to delete', () => {
  const system = "You answer questions about Larkspur Home's shop data from BigQuery"
  const d = decide({ messages: [{ role: 'system', content: system }, { role: 'user', content: 'Which five products sold best in Germany last week?' }], tools: [fn('bigquery_v2_bigquery_jobs_query')] })
  assert.equal(d.toolCalls?.[0].name, 'bigquery_v2_bigquery_jobs_query')
  assert.match((d.toolCalls?.[0].args as any).query, /shipping_country = 'DE'[\s\S]*LIMIT 5/)
  const no = decide({ messages: [{ role: 'system', content: system }, { role: 'user', content: 'Please delete the test orders from yesterday.' }], tools: [fn('bigquery_v2_bigquery_jobs_query')] })
  assert.match(no.content ?? '', /only read data/)
})

test('Xero filters by contact and date', () => {
  const y = new Date(Date.now() - 86400000)
  const rows = xeroWhere(`Type=="RECEIVE" AND Contact.Name=="Stripe" AND Date>=DateTime(${y.getUTCFullYear()},${y.getUTCMonth() + 1},${y.getUTCDate()})`)
  assert.deepEqual(rows.map((r) => r.Total), [18240.55, 6921.1])
})

test('Anthropic, streamed: a panelist reads the attached contract', async (t) => {
  const s = await start()
  t.after(s.close)
  const body = {
    model: 'claude-sonnet-4-5', stream: true, system: 'You review supplier contracts. [YOUR ROLE: Northgate side]',
    messages: [{ role: 'user', content: [{ type: 'document', title: 'northgate.pdf', source: { media_type: 'application/pdf', data: 'JVBERi0=' } }, { type: 'text', text: 'Review this.' }] }],
  }
  const res = await (await fetch(`${s.url}/anthropic/v1/messages`, { method: 'POST', body: JSON.stringify(body) })).text()
  const said = res.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === 'content_block_delta').map((e) => e.delta.text).join('')
  assert.match(said, /^\*\*Where Northgate will push back\*\*/)
  const models = await (await fetch(`${s.url}/anthropic/v1/models`)).json()
  assert.equal(models.first_id, 'claude-sonnet-4-5')
})

test('the contract PDF is served as the Slack file once uploaded, and the post is kept', async (t) => {
  const s = await start()
  t.after(s.close)
  const pdfUrl = `${s.url}/_ext/files.slack.com/files-pri/T0LARKSPUR-F0NGF0412/northgate-fulfilment-agreement.pdf`
  assert.equal((await fetch(pdfUrl)).status, 404)
  await fetch(`${s.url}/_admin/contract`, { method: 'POST', body: JSON.stringify({ base64: Buffer.from('%PDF-1.7 demo').toString('base64') }) })
  assert.equal(await (await fetch(pdfUrl)).text(), '%PDF-1.7 demo')
  await fetch(`${s.url}/_ext/slack.com/api/chat.postMessage`, { method: 'POST', body: JSON.stringify({ channel: 'C0LEGAL', text: 'Risk memo' }) })
  const state = await (await fetch(`${s.url}/_admin/state`)).json()
  assert.equal(state.outbox.at(-1).body.text, 'Risk memo')
})

test('the larkspur walks load: five guides, 37 screenshots', () => {
  const loaded = load([larkspur])
  assert.deepEqual(loaded.walks.map((w) => w.id), ['larkspur-payouts', 'larkspur-ask', 'larkspur-quality', 'larkspur-contract', 'larkspur-spend'])
  assert.equal(loaded.walks.reduce((n, w) => n + Object.keys(w.shots).length, 0), 37)
})
