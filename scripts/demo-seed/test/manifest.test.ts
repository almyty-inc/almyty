import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkCoverage, readManifest, type ManifestEntry } from '../engine/manifest.ts'
import { load } from '../engine/load.ts'
import { ROOT } from '../engine/env.ts'
import { FAMILIES } from '../walks/index.ts'
import type { Walk } from '../engine/schema.ts'

const entry = (path: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({ id: path, path, title: 'T', status: 'current', source: { kind: 'browser', environment: 'local-demo' }, sources: ['x'], ...over })
const walkWith = (id: string, shots: Record<string, { path: string; title?: string; sources?: string[] }>) => ({
  id, shots: Object.fromEntries(Object.entries(shots).map(([k, s]) => [k, { title: 'T', sources: ['x'], ...s }])),
}) as unknown as Walk

test('every local-demo screenshot is taken by exactly one walk step', () => {
  assert.deepEqual(checkCoverage([walkWith('w', { a: { path: 'screenshots/a.png' } })], [entry('screenshots/a.png')]), [])
  assert.match(checkCoverage([], [entry('screenshots/a.png')]).join(), /no walk takes it/)
  assert.match(checkCoverage([walkWith('w', { a: { path: 'screenshots/a.png' } }), walkWith('v', { b: { path: 'screenshots/a.png' } })], [entry('screenshots/a.png')]).join(), /taken by 2 walk steps/)
})

test('every walk screenshot is in the manifest, under the same title and sources', () => {
  assert.match(checkCoverage([walkWith('w', { a: { path: 'screenshots/a.png' } })], []).join(), /not in the manifest/)
  assert.match(checkCoverage([walkWith('w', { a: { path: 'screenshots/a.png', title: 'Other' } })], [entry('screenshots/a.png')]).join(), /title "Other" differs/)
  assert.match(checkCoverage([walkWith('w', { a: { path: 'screenshots/a.png', sources: ['y'] } })], [entry('screenshots/a.png')]).join(), /sources differ/)
})

test('screenshots from elsewhere (published CLIs, repository files) are not the walks\' business', () => {
  assert.deepEqual(checkCoverage([], [entry('screenshots/cli/a.png', { source: { kind: 'published-cli' } }), entry('screenshots/old.png', { status: 'historical', source: undefined })]), [])
})

test('the walks and the published manifest agree', () => {
  const problems = checkCoverage(load(FAMILIES).walks, readManifest(ROOT))
  assert.deepEqual(problems, [])
})
