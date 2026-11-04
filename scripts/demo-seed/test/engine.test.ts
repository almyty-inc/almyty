import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expand, MACROS } from '../engine/macros.ts'
import { load, plan, type Family } from '../engine/load.ts'
import { byPassword, forwardTo, fromShot, kindOf, stepLabel, WalkError } from '../engine/run.ts'
import { noteFor } from '../engine/register.ts'
import { matches } from '../engine/match.ts'
import { describe as say } from '../engine/locate.ts'
import { rows, unwrap } from '../engine/http.ts'
import type { Step } from '../engine/schema.ts'

const account = { email: 'a@b.example', password: 'password-1', firstName: 'A', lastName: 'B', organizationName: 'Org' }
const walk = (id: string, steps: unknown[], over: Record<string, unknown> = {}) => ({ id, title: id, profile: 'p', account, shots: {}, steps, ...over })

test('macros expand in place, all the way down', () => {
  const steps = expand([{ if: { url: '/x' }, then: [{ use: 'pickTools', with: { tools: ['a', 'b'] } }] }], MACROS)
  const inner = (steps[0] as { then: Step[] }).then
  assert.equal(inner.filter((s) => 'check' in s).length, 2)
  assert.throws(() => expand([{ use: 'nope' }], MACROS), /no macro called nope/)
  assert.throws(() => expand([{ use: 'pickTools', with: {} }], MACROS), /macro pickTools: needs tools/)
  assert.throws(() => expand([{ use: 'loop' }], { loop: () => [{ use: 'loop' }] }), /uses itself/)
})

test('a macro\'s screenshots are counted once it is expanded', () => {
  const family: Family = { name: 'f', walks: [walk('w', [{ use: 'tryIt', with: { message: 'hi', answer: 'ok', shot: 's' } }], { shots: { s: { path: 'screenshots/s.png', title: 'S', sources: ['x'] } } })] }
  assert.equal(load([family]).walks[0].steps.filter((s) => 'shot' in s).length, 1)
})

test('loading reports every broken walk at once', () => {
  const family: Family = { name: 'f', walks: [walk('a', [{ goto: '/' }]), walk('b', [{ clik: 1 }]), walk('a', [{ goto: '/' }]), walk('c', [{ goto: '/' }], { after: ['zz'] })] }
  assert.throws(() => load([family]), (e: Error) => /walk b is invalid/.test(e.message) && /walk a is defined twice/.test(e.message) && /runs after zz, which does not exist/.test(e.message))
})

test('two walks may not publish the same image', () => {
  const shots = { s: { path: 'screenshots/s.png', title: 'S', sources: ['x'] } }
  const family: Family = { name: 'f', walks: [walk('a', [{ shot: 's' }], { shots }), walk('b', [{ shot: 's' }], { shots })] }
  assert.throws(() => load([family]), /also taken by a\/s/)
})

test('plan orders walks after the ones they need, and finds cycles', () => {
  const family: Family = { name: 'f', walks: [walk('a', [{ goto: '/' }], { after: ['b'] }), walk('b', [{ goto: '/' }])] }
  const loaded = load([family])
  assert.deepEqual(plan(loaded, ['a']).map((w) => w.id), ['b', 'a'])
  const loop: Family = { name: 'g', walks: [walk('x', [{ goto: '/' }], { after: ['y'] }), walk('y', [{ goto: '/' }], { after: ['x'] })] }
  assert.throws(() => plan(load([loop]), ['x']), /need each other/)
})

test('a step\'s kind is its leading key, overlapping kinds first', () => {
  assert.equal(kindOf({ render: 'email', with: {}, shot: 's' }), 'render')
  assert.equal(kindOf({ each: 'xs', as: 'x', do: [{ goto: '/' }] }), 'each')
  assert.equal(kindOf({ as: 'tom', do: [{ goto: '/' }] }), 'as')
  assert.equal(kindOf({ press: { label: 'x' }, key: 'Enter' }), 'press')
  assert.equal(kindOf({ key: 'Escape' }), 'key')
})

test('--from starts after the shot before, with the steps that lead to the asked one', () => {
  const steps: Step[] = [{ goto: '/a' }, { shot: 'a' }, { goto: '/b' }, { click: { role: 'button', name: 'B' } }, { shot: 'b' }, { shot: 'c' }]
  assert.deepEqual(fromShot(steps, 'b'), steps.slice(2))
  assert.deepEqual(fromShot(steps, 'c'), steps.slice(5))
  assert.deepEqual(fromShot(steps, 'a'), steps)
  assert.throws(() => fromShot(steps, 'z', 'w'), /walk w takes no shot z/)
})

test('a failed step says the walk, the step and where the screenshot is', () => {
  const e = new WalkError('guide-sales', '4', stepLabel({ click: { role: 'button', name: /Save/ } }), new Error('Timeout 30000ms exceeded.\nCall log: ...'), '/tmp/x.png')
  assert.match(e.message, /^walk guide-sales, step 4 \{click:\{role:"button",name:"\/Save\/"\}\}: Timeout 30000ms exceeded\.\n {2}page as it was: \/tmp\/x\.png$/)
})

test('rows match on fields, patterns and contained text', () => {
  const row = { name: 'Petstore', status: 'completed', input: { message: 'NW-10428 is late' }, count: 3 }
  assert.ok(matches(row, { name: 'Petstore', status: /^(completed|failed)$/ }))
  assert.ok(matches(row, { 'input.message': { contains: 'NW-10428' }, count: 3 }))
  assert.ok(matches(row, { input: { contains: 'NW-10428' } }))
  assert.ok(!matches(row, { name: 'Orders' }))
})

test('answers are unwrapped and listed whatever they are wrapped in', () => {
  assert.deepEqual(unwrap({ success: true, data: [1] }), [1])
  assert.deepEqual(rows({ agents: [1, 2] }, 'agents'), [1, 2])
  assert.deepEqual(rows({ items: [3] }), [3])
  assert.deepEqual(rows([4]), [4])
  assert.deepEqual(rows({ apis: [5], total: 1 }), [5])
})

test('locators read as a person would say them', () => {
  assert.equal(say({ role: 'button', name: 'Save', within: { testid: 'form' }, nth: 'last' }), 'testid "form" > button "Save" (last)')
  assert.equal(say({ role: ['button', 'link'], name: /Save/ }), 'button or link /Save/')
})

test('a forwarded request goes to the fake, and a redirect goes back to the browser', async () => {
  const calls: unknown[] = []
  const route = {
    request: () => ({ url: () => 'https://login.example.com/tenant/authorize?state=1' }),
    fetch: async (o: unknown) => { calls.push(o); return 'the answer' },
    fulfill: async (o: unknown) => { calls.push(o) },
  }
  await forwardTo('http://localhost:4291/idp')(route as never)
  assert.deepEqual(calls, [{ url: 'http://localhost:4291/idp/tenant/authorize?state=1', maxRedirects: 0 }, { response: 'the answer' }])
})

test('only people who sign in with a password get the password treatment', () => {
  assert.equal(byPassword(account), true)
  assert.equal(byPassword({ ...account, signIn: 'none' }), false)
})

test('a screenshot\'s own note wins over the walk\'s', () => {
  const w = load([{ name: 'f', walks: [walk('w', [{ shot: 'a' }, { shot: 'b' }], {
    browser: { timezone: 'Europe/Amsterdam' }, notes: 'The walk.',
    shots: { a: { path: 'screenshots/a.png', title: 'A', sources: ['x'] }, b: { path: 'screenshots/b.png', title: 'B', sources: ['x'], notes: 'A rendered page.' } },
  })] }]).walks[0]
  assert.equal(w.browser?.timezone, 'Europe/Amsterdam')
  assert.equal(noteFor(w, 'a'), 'The walk.')
  assert.equal(noteFor(w, 'b'), 'A rendered page.')
})
