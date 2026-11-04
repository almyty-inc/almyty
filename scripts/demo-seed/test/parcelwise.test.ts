import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crmMatches, driveQuery, searchArticles } from '../fakes/services/parcelwise.ts'
import { decide } from '../fakes/models/parcelwise.ts'
import { load } from '../engine/load.ts'
import { parcelwise } from '../walks/parcelwise/index.ts'

const tool = (name: string) => ({ type: 'function', function: { name } })

test('the help center finds bulk return labels and nothing for a rate limit', () => {
  assert.equal(searchArticles('print dhl return labels bulk')[0].title, 'Create return labels in bulk')
  assert.deepEqual(searchArticles('rate limit rest api'), [])
})

test('HubSpot search keeps the new leads that have no score yet', () => {
  const lead = { properties: { lifecyclestage: 'lead', fit_score: '' } }
  const scored = { properties: { lifecyclestage: 'lead', fit_score: '80' } }
  const body = { filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'lead' }, { propertyName: 'fit_score', operator: 'NOT_HAS_PROPERTY' }] }] }
  assert.equal(crmMatches(lead, body), true)
  assert.equal(crmMatches(scored, body), false)
  assert.equal(crmMatches({ properties: { dealname: 'Kaffeewerk - Business plan' } }, { query: 'kaffeewerk' }), true)
})

test('Drive full-text search finds the discount documents, newest first', () => {
  assert.deepEqual(driveQuery("fullText contains 'discount'").map((f) => f.name), ['Kaffeewerk - proposal draft', 'Pricing and discounts 2026'])
})

test('the docs assistant searches the help center, then answers with the source', () => {
  const system = { role: 'system', content: 'You answer questions ... using only the Parcelwise help center in Intercom.' }
  const user = { role: 'user', content: 'Can customers print DHL return labels in bulk?' }
  const first = decide({ messages: [system, user], tools: [tool('intercom_search_articles')] })
  assert.equal(first.toolCalls?.[0].name, 'intercom_search_articles')
  assert.deepEqual(first.toolCalls?.[0].args, { phrase: 'print dhl return labels bulk', state: 'published' })
  const id = first.toolCalls![0].id!
  assert.match(id, /^call_search_\d+$/)
  const result = { data: { articles: searchArticles('print dhl return labels bulk') } }
  const second = decide({ messages: [system, user, { role: 'assistant', tool_calls: [{ id, function: { name: 'intercom_search_articles', arguments: '{}' } }] }, { role: 'tool', tool_call_id: id, content: JSON.stringify({ type: 'list', ...result }) }], tools: [tool('intercom_search_articles')] })
  assert.match(second.content ?? '', /^Yes\. Make return labels/)
  assert.match(second.content ?? '', /Source: \[Create return labels in bulk\]\(https:\/\/help\.parcelwise\.example\/en\/articles\/9100231-create-return-labels-in-bulk\)/)
})

test('the lead scorer starts with the contact search', () => {
  const d = decide({ messages: [{ role: 'system', content: 'You score new leads in HubSpot' }, { role: 'user', content: 'Score the new leads.' }], tools: [tool('hubspot_contacts_post_crm_v3_objects_contacts_search_do_search')] })
  assert.equal(d.toolCalls?.[0].name, 'hubspot_contacts_post_crm_v3_objects_contacts_search_do_search')
})

test('the Parcelwise walks load, with their macros, actions and templates', () => {
  const loaded = load([parcelwise])
  assert.deepEqual(loaded.walks.map((w) => w.id), ['docs-deflection-bot', 'lead-enrichment-routing', 'meeting-notes-to-crm', 'agent-that-remembers', 'connect-google-sharepoint'])
  assert.equal(loaded.walks.reduce((n, w) => n + Object.keys(w.shots).length, 0), 43)
  const html = loaded.templates.parcelwiseSlackPost({ channel: '# sales-leads', bot: 'Lead scorer', botColor: '#0891b2', post: '*2 hot leads* out of 3', note: 'n' })
  assert.match(html, /<b>2 hot leads<\/b>/)
})
