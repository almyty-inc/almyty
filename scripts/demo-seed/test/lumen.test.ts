import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { serve } from '../fakes/server.ts'
import { lumenService, gmailFilter, matchFilters, driveQuery } from '../fakes/services/lumen.ts'
import { decide } from '../fakes/models/lumen.ts'
import { load } from '../engine/load.ts'
import { lumen, tomorrow } from '../walks/lumen/index.ts'

process.env.USECASE_MODEL_LOG = '/dev/null'

async function start(persona: string) {
  const [server, v6] = serve([lumenService(persona)], { port: 0 })
  await new Promise((r) => server.once('listening', r))
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  return { url, close: () => { server.close(); v6.close() }, call: async (path: string, init?: RequestInit) => (await fetch(`${url}${path}`, init)).json() }
}
const fn = (name: string) => ({ type: 'function', function: { name, parameters: {} } })

test('the founder\'s associate recalls memory first, then lists calendars, and asks each one for today', () => {
  const tools = ['recall_memory', 'google_calendar_calendar_calendar_list_list', 'google_calendar_calendar_events_list'].map(fn)
  const system = { role: 'system', content: "You are Maya's associate at Lumen." }
  const first = decide({ messages: [system, { role: 'user', content: 'Write my morning brief for today.' }], tools })
  assert.equal(first.toolCalls?.[0].name, 'recall_memory')
  assert.equal(first.toolCalls?.[0].id, 'call_recall_0')
  const turn = [
    { role: 'assistant', tool_calls: [{ id: 'call_recall_0', function: { name: 'recall_memory', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_recall_0', content: '[]' },
  ]
  const second = decide({ messages: [system, { role: 'user', content: 'Write my morning brief for today.' }, ...turn], tools })
  assert.equal(second.toolCalls?.[0].name, 'google_calendar_calendar_calendar_list_list')
  const lists = [
    { role: 'assistant', tool_calls: [{ id: 'call_callist_1', function: { name: 'google_calendar_calendar_calendar_list_list', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_callist_1', content: JSON.stringify({ items: [{ id: 'primary' }, { id: 'team@lumenlabs.example' }] }) },
  ]
  const third = decide({ messages: [system, { role: 'user', content: 'Write my morning brief for today.' }, ...turn, ...lists], tools })
  assert.equal(third.toolCalls?.[0].name, 'google_calendar_calendar_events_list')
  assert.equal((third.toolCalls?.[0].args as any).calendarId, 'primary')
})

test('the biz-dev assistant searches the CRM for leads in logistics and trucking', () => {
  const out = decide({ messages: [{ role: 'system', content: 'You help Maya with business development (outreach to new prospects).' }, { role: 'user', content: 'Find new prospects.' }], tools: [fn('hubspot_companies_post_crm_v3_objects_companies_search_do_search')] })
  const args = out.toolCalls?.[0].args as any
  assert.equal(out.toolCalls?.[0].name, 'hubspot_companies_post_crm_v3_objects_companies_search_do_search')
  assert.equal(args.filterGroups.length, 2)
})

test('HubSpot search: groups are OR, filters in a group AND', () => {
  const kestrel = { properties: { lifecyclestage: 'lead', industry: 'TRANSPORTATION_TRUCKING_RAILROAD', numberofemployees: '320' } }
  const bakery = { properties: { lifecyclestage: 'lead', industry: 'FOOD_PRODUCTION', numberofemployees: '35' } }
  const body = { filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'lead' }, { propertyName: 'numberofemployees', operator: 'GTE', value: '100' }] }] }
  assert.equal(matchFilters(kestrel, body), true)
  assert.equal(matchFilters(bakery, body), false)
  assert.equal(matchFilters(bakery, { query: 'food' }), true)
})

test('Gmail search: in:sent, (to OR from), newer_than', () => {
  const now = new Date().toISOString()
  const mail = [
    { id: 'a', from: 'me@x', to: 'jonas@bluefin.example', subject: 'Hi', body: 'x', date: now, labels: ['SENT'] },
    { id: 'b', from: 'jonas@bluefin.example', to: 'me@x', subject: 'Re: Hi', body: 'y', date: now, labels: ['INBOX'] },
    { id: 'c', from: 'old@x', to: 'me@x', subject: 'Old', body: 'z', date: '2020-01-01T00:00:00Z', labels: ['INBOX'] },
  ]
  assert.deepEqual(gmailFilter(mail, 'in:sent').map((m) => m.id), ['a'])
  assert.deepEqual(gmailFilter(mail, '(to:jonas@bluefin.example OR from:jonas@bluefin.example) newer_than:30d').map((m) => m.id).sort(), ['a', 'b'])
  assert.deepEqual(gmailFilter(mail, 'in:inbox newer_than:7d').map((m) => m.id), ['b'])
})

test('Drive search: by name, or by parent folder', () => {
  const files = [{ id: 'f1', name: "Bluefin Couriers onboarding", parents: ['root'] }, { id: 'f2', name: 'Depots.csv', parents: ['f1'] }]
  assert.deepEqual(driveQuery(files, "name = 'Bluefin Couriers onboarding'").map((f) => f.id), ['f1'])
  assert.deepEqual(driveQuery(files, "'f1' in parents").map((f) => f.id), ['f2'])
})

test('the stand-in serves Maya or Elena, wins a deal, and keeps what the API sent', async (t) => {
  const maya = await start('maya')
  t.after(maya.close)
  assert.equal((await maya.call('/calendar/v3/users/me/calendarList')).items.length, 3)
  await maya.call('/_admin/win?company=Bluefin%20Couriers', { method: 'POST' })
  await maya.call('/_ext/api.resend.com/emails', { method: 'POST', body: JSON.stringify({ to: ['maya@x'] }) })
  const s = await maya.call('/_admin/state')
  assert.equal(s.deals[0].properties.dealstage, 'closedwon')
  assert.equal(s.outbox[0].url, '/api.resend.com/emails')
  await maya.call('/_admin/reset', { method: 'POST' })
  const after = await maya.call('/_admin/state')
  assert.deepEqual([after.deals.length, after.outbox.length], [0, 0])
  const elena = await start('elena')
  t.after(elena.close)
  const cals = (await elena.call('/calendar/v3/users/me/calendarList')).items.map((c: any) => c.summary)
  assert.deepEqual(cals, ['Elena Park', 'Family'])
})

test('the scripted model streams 60-character pieces under its own completion id', async (t) => {
  const s = await start('maya')
  t.after(s.close)
  const res = await (await fetch(`${s.url}/openai/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'hello' }], stream: true }) })).text()
  const pieces = res.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)))
  assert.equal(pieces[0].id, 'chatcmpl-local')
  assert.equal(pieces.map((p) => p.choices[0]?.delta?.content ?? '').join(''), 'Done.')
  assert.equal(pieces.at(-1).usage.completion_tokens, Math.round(('Done.' + '""').length / 4) + 5)
})

test('the lumen walks load, and the airline writes tomorrow as a date', () => {
  const loaded = load([lumen])
  assert.deepEqual(loaded.walks.map((w) => w.id), ['tutorial-founder', 'tutorial-bizdev', 'tutorial-push-wakes', 'tutorial-onboarding-fresh', 'tutorial-onboarding', 'tutorial-personal'])
  assert.equal(loaded.walks.reduce((n, w) => n + Object.keys(w.shots).length, 0), 76)
  assert.match(tomorrow(Date.UTC(2026, 10, 4)), /^Thursday 5 November$/)
})
