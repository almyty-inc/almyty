import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { serve } from '../fakes/server.ts'
import { velora } from '../fakes/services/velora.ts'
import { decide, usage } from '../fakes/models/velora.ts'
import { load } from '../engine/load.ts'
import { velora as family } from '../walks/velora/index.ts'

async function start() {
  const [server, v6] = serve([velora], { port: 0 })
  await new Promise((r) => server.once('listening', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => { server.close(); v6.close() } }
}

const SYSTEM = { role: 'system', content: "You help Velora Energy's finance team with customers' bills." }
const TOOLS = ['stripe_get_customers', 'stripe_get_charges', 'stripe_post_refunds', 'request_approval'].map((name) => ({ type: 'function', function: { name } }))
const result = (id: string, content: unknown) => [
  { role: 'assistant', tool_calls: [{ id, function: { name: 'x', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: id, content: JSON.stringify({ success: true, data: content }) },
]

test('the billing assistant looks the customer up, then the charges, then asks before a big refund', async (t) => {
  const s = await start()
  t.after(s.close)
  const user = { role: 'user', content: 'Bakkerij De Zon B.V. (administratie@bakkerijdezon.example) was charged twice for their September bill. Please refund the duplicate.' }
  const first = decide({ messages: [SYSTEM, user], tools: TOOLS })
  assert.equal(first.toolCalls?.[0].name, 'stripe_get_customers')
  assert.deepEqual(first.toolCalls?.[0].args, { email: 'administratie@bakkerijdezon.example', limit: 3 })
  const customers = await (await fetch(`${s.url}/stripe/v1/customers?email=administratie@bakkerijdezon.example`)).json()
  const charges = await (await fetch(`${s.url}/stripe/v1/charges?customer=${customers.data[0].id}`)).json()
  assert.equal(charges.data.length, 3)
  const msgs = [SYSTEM, user, ...result('call_customer_1', customers), ...result('call_charges_2', charges)]
  const ask = decide({ messages: msgs, tools: TOOLS })
  assert.equal(ask.toolCalls?.[0].name, 'request_approval')
  assert.equal((ask.toolCalls?.[0].args as any).payload.amount_eur, 6240)
  assert.equal((ask.toolCalls?.[0].args as any).payload.charge, 'ch_3QvC1bBakkerijSep02')
})

test('a small refund goes straight to Stripe, which takes it as a form and refuses too much', async (t) => {
  const s = await start()
  t.after(s.close)
  const refund = (amount: number) => fetch(`${s.url}/stripe/v1/refunds`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `charge=ch_3QvC3dDeVriesSep01&amount=${amount}&reason=requested_by_customer` })
  const ok = await refund(13650)
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).object, 'refund')
  const again = await refund(100)
  assert.equal(again.status, 400)
  const state = await (await fetch(`${s.url}/_admin/state`)).json()
  assert.equal(state.refunds.length, 1)
  await fetch(`${s.url}/_admin/reset`, { method: 'POST' })
})

test('Splunk checks its token, and DNS answers what was put there', async (t) => {
  const s = await start()
  t.after(s.close)
  const hec = (auth: string) => fetch(`${s.url}/splunk/x.splunkcloud.com/services/collector/event`, { method: 'POST', headers: { authorization: auth }, body: JSON.stringify({ event: { action: 'run_start' } }) })
  assert.equal((await hec('Splunk nope')).status, 403)
  assert.equal((await hec('Splunk 7c2e9a41-5b1d-4f6a-9e03-8d4b2c1f6a70')).status, 200)
  await fetch(`${s.url}/_dns/txt`, { method: 'POST', body: JSON.stringify({ name: '_almyty.VeloraEnergy.example', value: 'v=1' }) })
  assert.deepEqual(await (await fetch(`${s.url}/_dns/txt?name=_almyty.veloraenergy.example`)).json(), ['v=1'])
})

test('Entra signs the named person in: authorize redirects back with a code, the token endpoint takes a form', async (t) => {
  const s = await start()
  t.after(s.close)
  const tenant = '4f9c2b17-8e3a-4d61-b5a2-0c7e91d3f846'
  const back = 'http://localhost:4210/sso/org/oidc/callback'
  const r = await fetch(`${s.url}/entra/${tenant}/oauth2/v2.0/authorize?client_id=c1&redirect_uri=${encodeURIComponent(back)}&state=s1&nonce=n1`, { redirect: 'manual' })
  assert.equal(r.status, 302)
  const code = new URL(r.headers.get('location')!).searchParams.get('code')
  const tok = await (await fetch(`${s.url}/entra/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=authorization_code&code=${code}&client_id=c1&redirect_uri=${encodeURIComponent(back)}` })).json()
  const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString())
  assert.equal(claims.email, 'eva.degroot@veloraenergy.example')
  assert.equal(claims.nonce, 'n1')
})

test('the website assistant answers the tariff question; token counts follow the old formula', () => {
  const body = { messages: [{ role: 'system', content: 'You answer Velora Energy\'s customers on our website about tariffs.' }, { role: 'user', content: 'Can I switch to the dynamic tariff from next month?' }] }
  const d = decide(body)
  assert.match(d.content ?? '', /first day of the next month/)
  assert.deepEqual(usage(body, d), { prompt: Math.round(JSON.stringify(body.messages).length / 4) + 200, completion: Math.round(((d.content ?? '') + '""').length / 4) + 5 })
})

test('the velora walks load and take 31 screenshots', () => {
  const loaded = load([family])
  assert.equal(loaded.walks.length, 5)
  assert.equal(loaded.walks.reduce((n, w) => n + Object.keys(w.shots).length, 0), 31)
})
