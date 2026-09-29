#!/usr/bin/env node
// Register observed evidence; never infer a capture date from Git or file mtime.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { digest, filesBelow, repoRoot, sourceDigest } from './check-screenshots.mjs'

const manifestPath = join(repoRoot, 'docs-site/public/screenshots/manifest.json')
const publicDir = join(repoRoot, 'docs-site/public')
const { values } = parseArgs({ options: {
  init: { type: 'boolean' }, image: { type: 'string' }, path: { type: 'string' },
  title: { type: 'string' }, 'captured-at': { type: 'string' }, route: { type: 'string' },
  sources: { type: 'string', multiple: true },
  package: { type: 'string' }, command: { type: 'string' }, notes: { type: 'string' },
} })
let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (values.init) {
  const previous = new Map(manifest.screenshots.map((entry) => [entry.path, entry]))
  manifest = {
    schemaVersion: 2,
    baseUrl: 'https://app.almyty.com',
    screenshots: filesBelow(join(publicDir, 'screenshots')).filter((file) => /\.(png|jpe?g|webp)$/i.test(file)).map((file) => {
      const path = relative(publicDir, file)
      const entry = previous.get(path)
      if (entry?.status) return entry
      return {
        id: path.replace(/^screenshots\//, '').replace(/\.[^.]+$/, '').replaceAll('/', '-'),
        title: entry?.title || path.split('/').at(-1).replace(/\.[^.]+$/, '').replaceAll('-', ' '),
        path, capturedAt: entry?.capturedAt || null, status: 'needs-recapture',
        reason: 'Legacy image predates the UI refresh; its individual capture time is unknown unless recorded here. Tracked for #675, not verified current.',
        sha256: digest(readFileSync(file)),
      }
    }),
  }
} else {
  if (manifest.schemaVersion !== 2) throw new Error('Run --init once to migrate the manifest')
  if (!/^screenshots\/(?!.*(?:\.\.|\\))[^\s]+\.png$/.test(values.path || '')) throw new Error('Supply a safe screenshots/*.png --path')
  if (!values.title || !values['captured-at'] || !Number.isFinite(Date.parse(values['captured-at']))) throw new Error('Supply --title and observed --captured-at')
  if (!values.route && !(values.package && values.command)) throw new Error('Supply --route or published --package and --command')
  const fingerprint = sourceDigest(repoRoot, values.sources)
  const destination = join(publicDir, values.path)
  if (values.image) {
    if (!existsSync(values.image)) throw new Error('Capture file does not exist')
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(values.image, destination)
  }
  const entry = {
    id: values.path.replace(/^screenshots\//, '').replace(/\.png$/, '').replaceAll('/', '-'),
    title: values.title, path: values.path,
    capturedAt: new Date(values['captured-at']).toISOString(), status: 'current',
    sha256: digest(readFileSync(destination)),
    source: values.package
      ? { kind: 'published-cli', package: values.package, command: values.command }
      : { kind: 'browser', environment: 'staging', route: values.route },
    sources: values.sources, sourceDigest: fingerprint,
    ...(values.notes ? { notes: values.notes } : {}),
  }
  manifest.screenshots = manifest.screenshots.filter((old) => old.path !== entry.path).concat(entry)
}
manifest.screenshots.sort((a, b) => a.path.localeCompare(b.path))
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Registered ${values.path || `${manifest.screenshots.length} existing images (legacy dates preserved, never invented)`}`)
