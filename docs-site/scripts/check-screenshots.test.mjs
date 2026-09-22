import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkScreenshots, digest, sourceDigest } from './check-screenshots.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'screenshot-check-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, value) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  write('frontend/src/pages/models.tsx', 'Models UI')
  write('docs-site/public/screenshots/models.png', 'image bytes')
  write('docs-site/content/models.mdx', '![Models](/screenshots/models.png)')
  const entry = {
    id: 'models', title: 'Models', path: 'screenshots/models.png',
    capturedAt: '2026-09-22T10:00:00Z', status: 'current',
    sha256: digest(Buffer.from('image bytes')),
    source: { kind: 'browser', environment: 'staging', route: '/models' },
    sources: ['frontend/src/pages/models.tsx'],
    sourceDigest: sourceDigest(root, ['frontend/src/pages/models.tsx']),
  }
  const manifest = { schemaVersion: 2, baseUrl: 'https://app.almyty.com', screenshots: [entry] }
  const check = (options) => {
    write('docs-site/public/screenshots/manifest.json', JSON.stringify(manifest))
    return checkScreenshots(root, options)
  }
  return { root, write, entry, manifest, check }
}

test('accepts a complete current inventory', (t) => {
  assert.deepEqual(fixture(t).check().errors, [])
})
test('rejects the former global capture timestamp', (t) => {
  const f = fixture(t); f.manifest.capturedAt = f.entry.capturedAt
  assert.match(f.check().errors.join('\n'), /global capturedAt/)
})
test('rejects an image not recorded in the manifest', (t) => {
  const f = fixture(t); f.write('docs-site/public/screenshots/new.png', 'new')
  assert.match(f.check().errors.join('\n'), /untracked image.*new.png/)
})
test('rejects a manifest entry whose image disappeared', (t) => {
  const f = fixture(t); f.entry.path = 'screenshots/missing.png'
  assert.match(f.check().errors.join('\n'), /missing image/)
})
test('rejects image replacement without new evidence', (t) => {
  const f = fixture(t); f.write('docs-site/public/screenshots/models.png', 'replacement')
  assert.match(f.check().errors.join('\n'), /image hash/)
})
test('rejects duplicate IDs and paths', (t) => {
  const f = fixture(t); f.manifest.screenshots.push({ ...f.entry })
  assert.match(f.check().errors.join('\n'), /duplicate id/)
  assert.match(f.check().errors.join('\n'), /duplicate path/)
})
test('rejects a broken public documentation reference', (t) => {
  const f = fixture(t); f.write('docs-site/content/missing.mdx', '<img src="/screenshots/lost.png" />')
  assert.match(f.check().errors.join('\n'), /reference.*lost.png/)
})
test('rejects unsafe asset paths', (t) => {
  const f = fixture(t); f.entry.path = '../secret.png'
  assert.match(f.check().errors.join('\n'), /invalid path/)
})
test('rejects a missing or invalid per-asset capture time', (t) => {
  const f = fixture(t); f.entry.capturedAt = null
  assert.match(f.check().errors.join('\n'), /capture time/)
  f.entry.capturedAt = 'yesterday'
  assert.match(f.check().errors.join('\n'), /capture time/)
})
test('does not invent capture times for legacy evidence', (t) => {
  const f = fixture(t)
  Object.assign(f.entry, { status: 'needs-recapture', capturedAt: null, reason: 'Unknown legacy capture date.' })
  assert.deepEqual(f.check().errors, [])
  assert.equal(f.check().pending.length, 1)
  assert.match(f.check({ strict: true }).errors.join('\n'), /needs recapture/)
})
test('rejects a changed UI source even if the image itself did not change', (t) => {
  const f = fixture(t); f.write('frontend/src/pages/models.tsx', 'New models UI')
  assert.match(f.check().errors.join('\n'), /source drift/)
})
test('directory source fingerprints include added files and exclude tests', (t) => {
  const f = fixture(t)
  f.entry.sources = ['frontend/src/pages']
  f.entry.sourceDigest = sourceDigest(f.root, f.entry.sources)
  f.write('frontend/src/pages/__tests__/models.test.tsx', 'test only')
  assert.deepEqual(f.check().errors, [])
  f.write('frontend/src/pages/new-component.tsx', 'new UI')
  assert.match(f.check().errors.join('\n'), /source drift/)
})
test('rejects missing source evidence on a current capture', (t) => {
  const f = fixture(t); f.entry.sources = []
  assert.match(f.check().errors.join('\n'), /source evidence/)
})
test('rejects staging as the public docs base URL', (t) => {
  const f = fixture(t); f.manifest.baseUrl = 'https://app.staging.almyty.com'
  assert.match(f.check().errors.join('\n'), /public baseUrl/)
})
