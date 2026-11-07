import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { decide } from '../fakes/models/tidewater.ts'
import { tidewater, tidewaterOutbox, searchIssues, soap, newLines, reset } from '../fakes/services/tidewater.ts'
import { serve } from '../fakes/server.ts'
import { load } from '../engine/load.ts'
import { FAMILIES } from '../walks/index.ts'

const fn = (name: string) => ({ type: 'function', function: { name, parameters: {} } })
const basic = 'Basic ' + Buffer.from('svc-almyty:Harbor-2009!').toString('base64')

test('the triage model reads the labels first, then the new issues', () => {
  const tools = ['github_issues_list_labels_for_repo', 'github_issues_list_for_repo', 'github_search_issues_and_pull_requests', 'github_issues_add_labels', 'github_issues_create_comment'].map(fn)
  const system = { role: 'system', content: 'You triage new issues in the GitHub repository tidewater-labs/ledgerly.' }
  const first = decide({ messages: [system, { role: 'user', content: 'Triage the new issues in tidewater-labs/ledgerly.' }], tools })
  assert.equal(first.toolCalls?.[0].name, 'github_issues_list_labels_for_repo')
  assert.match(first.toolCalls![0].id!, /^call_labels_/)
  const id = first.toolCalls![0].id
  const second = decide({ messages: [system, { role: 'user', content: 'Triage the new issues in tidewater-labs/ledgerly.' },
    { role: 'assistant', tool_calls: [{ id, function: { name: 'github_issues_list_labels_for_repo', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: JSON.stringify([{ name: 'bug' }]) }], tools })
  assert.equal(second.toolCalls?.[0].name, 'github_issues_list_for_repo')
  assert.deepEqual({ ...second.toolCalls![0].args as object, since: undefined }, { owner: 'tidewater-labs', repo: 'ledgerly', state: 'open', since: undefined, sort: 'created', direction: 'asc', per_page: 50 })
})

test('the stock model reserves only when the warehouse has enough', () => {
  const tools = ['harbor_stock_system_get_stock_level', 'harbor_stock_system_reserve_stock'].map(fn)
  const ask = (q: string, level: string) => decide({ messages: [
    { role: 'system', content: 'You answer the sales team\'s questions about stock at Harbor Supply, from the stock system.' },
    { role: 'user', content: q },
    { role: 'assistant', tool_calls: [{ id: 'call_level_1', function: { name: 'harbor_stock_system_get_stock_level', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_level_1', content: level },
  ], tools })
  const [, enough] = soap('<GetStockLevel><Sku>HS-10442</Sku><WarehouseCode>RTM</WarehouseCode></GetStockLevel>', basic)
  assert.deepEqual(ask('Do we have 600 rolls of HS-10442 in Rotterdam? Reserve them for order SO-55120.', enough).toolCalls?.[0].args,
    { Sku: 'HS-10442', WarehouseCode: 'RTM', Quantity: 600, OrderReference: 'SO-55120' })
  const short = ask('Do we have 600 rolls of HS-10442 in Antwerp? Reserve them for order SO-55120.', soap('<GetStockLevel><Sku>HS-10442</Sku><WarehouseCode>ANR</WarehouseCode></GetStockLevel>', basic)[1])
  assert.match(short.content ?? '', /Not enough in Antwerp for 600/)
})

test('the SOAP service wants its service account and keeps stock', () => {
  reset()
  assert.match(soap('<ListWarehouses/>', undefined)[1], /Access denied/)
  const [ok, xml] = soap('<ReserveStock><Sku>HS-10442</Sku><WarehouseCode>RTM</WarehouseCode><Quantity>600</Quantity><OrderReference>SO-1</OrderReference></ReserveStock>', basic)
  assert.equal(ok, 200)
  assert.match(xml, /<ReservationId>RSV-70411<\/ReservationId>.*<RemainingOnHand>1240</)
  assert.match(soap('<ReserveStock><Sku>HS-10442</Sku><WarehouseCode>HAM</WarehouseCode><Quantity>1</Quantity><OrderReference>SO-2</OrderReference></ReserveStock>', basic)[1], /Not enough stock: 0 on hand in HAM/)
  reset()
  assert.match(soap('<GetStockLevel><Sku>HS-10442</Sku><WarehouseCode>RTM</WarehouseCode></GetStockLevel>', basic)[1], /<OnHand>1840</)
})

test('issue search matches free words and ignores qualifiers; the diff lines are numbered', () => {
  assert.deepEqual(searchIssues('repo:tidewater-labs/ledgerly is:issue pdf export').map((i) => i.number), [431, 482])
  assert.equal(newLines()['src/billing/late-fees.ts'][10], '  return Math.floor(days / 30)')
})

test('GitHub refuses a call without a token; the outbox keeps Slack posts until reset', async (t) => {
  // On one port here (the outbox first, as its own port would answer); two ports on a stack.
  const [server, v6] = serve([tidewaterOutbox, tidewater], { port: 0 })
  await new Promise((r) => server.once('listening', r))
  t.after(() => { server.close(); v6.close() })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  assert.equal((await fetch(`${url}/repos/tidewater-labs/ledgerly/issues`)).status, 401)
  const list = await (await fetch(`${url}/repos/tidewater-labs/ledgerly/issues?per_page=3`, { headers: { authorization: 'Bearer github_pat_x' } })).json()
  assert.deepEqual(list.map((i: any) => i.number), [486, 485, 484])
  await fetch(`${url}/_ext/slack.com/api/chat.postMessage`, { method: 'POST', body: JSON.stringify({ channel: 'C07INCIDNTS', text: '#1187' }) })
  const info = await (await fetch(`${url}/_ext/slack.com/api/users.info?user=U0MAYA`)).json()
  assert.equal(info.user.real_name, 'Maya Chen')
  // users.info and the post: both kept, in order.
  assert.equal((await (await fetch(`${url}/_admin/state`)).json()).outbox.length, 2)
})

test('the tidewater walks load', () => {
  const ids = load(FAMILIES).walks.filter((w) => w.profile === 'tidewater').map((w) => w.id)
  assert.deepEqual(ids, ['example-issue-triage', 'example-pr-review', 'example-oncall', 'example-legacy-soap', 'example-coding-fleet'])
})

test('the coding fleet gives its run the time a real coding task takes, and waits on the run for it', async () => {
  const { FLEET_RUN } = await import('../walks/tidewater/guides.ts')
  const fleet = load(FAMILIES).walks.find((w) => w.id === 'example-coding-fleet')!
  const steps = fleet.steps as any[]
  // The agent's own run timeout, set in the builder, is the walk's.
  const timeout = steps.find((s) => s.fill?.label === 'Timeout (seconds)')
  assert.equal(timeout?.value, String(FLEET_RUN.minutes * 60))
  assert.ok(FLEET_RUN.minutes > 15, 'longer than a run gets by default')
  // The walk waits on the run in the database, as long as the run may take; then briefly on Try it's answer.
  const i = steps.findIndex((s) => s.until?.sql?.includes('FROM agent_runs'))
  assert.ok(i > 0)
  assert.equal(steps[i].timeout, FLEET_RUN.minutes * 60_000)
  assert.equal(steps[i + 1].waitFor?.role, 'status')
  assert.ok(steps[i + 1].timeout <= 300_000)
  // Only git's own summary counts as an answer: a run whose commands failed has none.
  assert.ok(steps[i + 1].waitFor.hasText.test(' 3 files changed, 42 insertions(+)'))
  assert.ok(!steps[i + 1].waitFor.hasText.test('**Changed files:**\nError: workspace_unavailable'))
})
