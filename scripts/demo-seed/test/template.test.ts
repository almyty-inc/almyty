import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, assign, applyFilter } from '../engine/template.ts'

const vars = { agent: { id: 'a1', name: "O'Neil" }, tools: [{ name: 'petstore_get', id: 't1' }, { name: 'orders_get', id: 't2' }], n: 3 }

test('one placeholder becomes the value itself', () => {
  assert.deepEqual(render('{{tools}}', vars), vars.tools)
  assert.equal(render('{{n}}', vars), 3)
})

test('placeholders in text become text', () => {
  assert.equal(render('/agents/{{agent.id}}/edit', vars), '/agents/a1/edit')
  assert.equal(render('n={{n}}', vars), 'n=3')
})

test('filters select, pick and quote', () => {
  assert.deepEqual(render('{{tools|where:name~^petstore_|map:id}}', vars), ['t1'])
  assert.equal(render('{{tools|where:name=orders_get|first|get:id}}', vars), 't2')
  assert.equal(render('{{tools|len}}', vars), 2)
  assert.equal(render('{{agent.name|sql}}', vars), "'O''Neil'")
  assert.equal(render('{{agent|sqljson}}', vars), `'{"id":"a1","name":"O''Neil"}'`)
  assert.deepEqual(applyFilter({ agents: [1, 2] }, 'rows:agents'), [1, 2])
  assert.equal(render('{{missing|default:x}}', vars), 'x')
})

test('a bar inside a filter argument is escaped', () => {
  assert.deepEqual(render('{{tools|where:name~^(petstore\\|orders)_get$|map:id}}', vars), ['t1', 't2'])
})

test('time filters', () => {
  const at = applyFilter(new Date('2026-01-01T10:58:00Z'), 'add:2m') as Date
  assert.equal(applyFilter(at, 'hhmm'), '11:00')
  assert.equal(applyFilter(at, 'iso'), '2026-01-01T11:00:00.000Z')
})

test('the product\'s own placeholders pass through', () => {
  assert.equal(render('days: {{!input.days}}', vars), 'days: {{input.days}}')
  assert.equal(render('{{!nodes.tool.output}}', vars), '{{nodes.tool.output}}')
})

test('a missing name is an error, not an empty string', () => {
  assert.throws(() => render('/agents/{{nobody.id}}', vars), /nothing is called nobody\.id/)
})

test('rendering walks objects and lists, and leaves regular expressions alone', () => {
  const re = /x/
  assert.deepEqual(render({ a: ['{{agent.id}}'], re }, vars), { a: ['a1'], re })
})

test('assign sets dotted names', () => {
  const v: Record<string, unknown> = {}
  assign(v, 'apis.orders', 'id-1')
  assert.deepEqual(v, { apis: { orders: 'id-1' } })
})
