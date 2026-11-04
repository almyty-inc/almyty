import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWalk, checkShots, type Step } from '../engine/schema.ts'

const walk = (over: Record<string, unknown> = {}) => ({
  id: 'demo', title: 'Demo', profile: 'northwind',
  account: { email: 'a@b.example', password: 'password-1', firstName: 'A', lastName: 'B', organizationName: 'Org' },
  shots: { one: { path: 'screenshots/demo/one.png', title: 'One', sources: ['frontend/src/pages/x.tsx'] } },
  steps: [{ goto: '/agents' }, { shot: 'one' }],
  ...over,
})

test('a valid walk parses', () => {
  assert.equal(parseWalk(walk()).id, 'demo')
})

test('a shot may carry its own manifest note, and only a non-empty one', () => {
  const shots = (notes: string) => ({ one: { path: 'screenshots/demo/one.png', title: 'One', sources: ['frontend/src/pages/x.tsx'], notes } })
  assert.equal(parseWalk(walk({ shots: shots('Rendered from what the fake received.') })).shots.one.notes, 'Rendered from what the fake received.')
  assert.throws(() => parseWalk(walk({ shots: shots('') })), /shots\.one\.notes/)
})

test('a broken entry names the walk and the field', () => {
  assert.throws(() => parseWalk(walk({ steps: [{ goto: '/x' }, { shot: 'one' }, { clik: { role: 'button' } }] })), /walk demo is invalid:\n {2}steps\.2/)
  assert.throws(() => parseWalk(walk({ id: 'Bad Id' })), /walk Bad Id is invalid:\n {2}id: lowercase/)
})

test('a click or a fill never finds its target by text', () => {
  assert.throws(() => parseWalk(walk({ steps: [{ click: { text: 'Save' } }, { shot: 'one' }] })), /not by its text/)
  assert.throws(() => parseWalk(walk({ steps: [{ fill: { label: 'x', within: { text: 'Form' } }, value: 'v' }, { shot: 'one' }] })), /not by its text/)
  // Waiting for text, or scrolling to it, is fine.
  assert.doesNotThrow(() => parseWalk(walk({ steps: [{ waitFor: { text: /Saved/ } }, { scrollTo: { text: 'Keys' } }, { shot: 'one' }] })))
})

test('a locator has exactly one way to find', () => {
  assert.throws(() => parseWalk(walk({ steps: [{ click: { role: 'button', label: 'x' } }, { shot: 'one' }] })), /exactly one of/)
  assert.throws(() => parseWalk(walk({ steps: [{ click: { name: 'Save' } }, { shot: 'one' }] })), /exactly one of/)
  assert.throws(() => parseWalk(walk({ steps: [{ click: { label: 'x', name: 'Save' } }, { shot: 'one' }] })), /name only goes with role/)
})

test('every declared shot is taken by exactly one step', () => {
  assert.throws(() => parseWalk(walk({ steps: [{ goto: '/x' }] })), /shot one is declared but no step takes it/)
  assert.throws(() => parseWalk(walk({ steps: [{ shot: 'one' }, { shot: 'one' }] })), /taken by 2 steps/)
  assert.throws(() => parseWalk(walk({ steps: [{ shot: 'one' }, { shot: 'two' }] })), /shot two is not declared/)
  assert.throws(() => parseWalk(walk({ steps: [{ repeat: [{ shot: 'one' }], max: 2 }] })), /inside a repeat or each/)
})

test('a shot inside a branch counts once; a macro is looked into only after it is expanded', () => {
  const steps: Step[] = [{ if: { url: '/x' }, then: [{ shot: 'one' }] }]
  assert.deepEqual(checkShots(steps, { one: {} }), [])
  assert.deepEqual(checkShots([{ use: 'm' }], { one: {} }), [])
})

test('paths, timeouts and headless walks are checked', () => {
  assert.throws(() => parseWalk(walk({ shots: { one: { path: 'public/one.png', title: 'One', sources: ['x'] } } })), /screenshots/)
  assert.throws(() => parseWalk(walk({ steps: [{ waitFor: { text: 'x' }, timeout: -1 }, { shot: 'one' }] })), /steps\.0/)
  // Up to half an hour, for real coding assistants at work; no longer.
  assert.doesNotThrow(() => parseWalk(walk({ steps: [{ waitFor: { text: 'x' }, timeout: 1_500_000 }, { shot: 'one' }] })))
  assert.throws(() => parseWalk(walk({ steps: [{ waitFor: { text: 'x' }, timeout: 1_800_001 }, { shot: 'one' }] })), /steps\.0\.timeout/)
  assert.throws(() => parseWalk(walk({ headless: true })), /headless walk takes no screenshots/)
})
