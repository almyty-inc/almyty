#!/usr/bin/env node
// No dependencies or Git history required: evidence is tied to content, not mtimes.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(import.meta.dirname, '../..')
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const safePath = (path) => typeof path === 'string' && path.length > 0 &&
  !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((s) => s === '..' || s === '.' || !s)
const imagePath = (path) => safePath(path) && /^screenshots\/.+\.(png|jpe?g|webp)$/i.test(path)

export function filesBelow(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesBelow(path) : entry.isFile() ? [path] : []
  }).sort()
}

export function sourceDigest(root, selectors) {
  if (!Array.isArray(selectors) || !selectors.length) throw new Error('missing source evidence')
  const files = new Set()
  for (const selector of selectors) {
    if (!safePath(selector)) throw new Error('invalid source path')
    const path = join(root, selector)
    if (!existsSync(path)) throw new Error(`missing source ${selector}`)
    for (const file of statSync(path).isDirectory() ? filesBelow(path) : [path]) {
      if (!/(^|\/)(__tests__|node_modules)(\/|$)|\.(test|spec)\.[^.]+$/.test(file)) files.add(file)
    }
  }
  if (!files.size) throw new Error('empty source evidence')
  return digest([...files].sort().map((file) => `${relative(root, file)}\0${digest(readFileSync(file))}\n`).join(''))
}

export function checkScreenshots(root = repoRoot, { strict = false } = {}) {
  const errors = [], pending = []
  const publicDir = join(root, 'docs-site/public')
  let manifest
  try { manifest = JSON.parse(readFileSync(join(publicDir, 'screenshots/manifest.json'), 'utf8')) }
  catch (error) { return { errors: [`invalid screenshot manifest: ${error.message}`], pending } }
  if (manifest.schemaVersion !== 2) errors.push('schemaVersion must be 2')
  if ('capturedAt' in manifest) errors.push('global capturedAt is not per-asset evidence')
  if (manifest.baseUrl !== 'https://app.almyty.com') errors.push('public baseUrl must be https://app.almyty.com')
  if (!Array.isArray(manifest.screenshots)) return { errors: [...errors, 'screenshots must be an array'], pending }
  const ids = new Set(), paths = new Set()
  for (const entry of manifest.screenshots) {
    if (!entry || typeof entry !== 'object') { errors.push('invalid entry'); continue }
    const label = entry.path || entry.id || 'entry'
    if (!entry.id || typeof entry.id !== 'string' || ids.has(entry.id)) errors.push(`${label}: missing or duplicate id`)
    if (paths.has(entry.path)) errors.push(`${label}: duplicate path`)
    ids.add(entry.id)
    if (!imagePath(entry.path)) { errors.push(`${label}: invalid path`); continue }
    paths.add(entry.path)
    const file = join(publicDir, entry.path)
    if (!existsSync(file)) errors.push(`${label}: missing image`)
    else if (entry.sha256 !== digest(readFileSync(file))) errors.push(`${label}: image hash does not match; register the new capture`)
    if (!entry.title || typeof entry.title !== 'string') errors.push(`${label}: missing title`)
    if (!['current', 'needs-recapture', 'historical'].includes(entry.status)) errors.push(`${label}: invalid status`)
    if (entry.status === 'current') {
      if (typeof entry.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(entry.capturedAt) || !Number.isFinite(Date.parse(entry.capturedAt))) errors.push(`${label}: invalid capture time`)
      if (!['browser', 'published-cli'].includes(entry.source?.kind)) errors.push(`${label}: missing capture source`)
      try {
        if (entry.sourceDigest !== sourceDigest(root, entry.sources)) errors.push(`${label}: source drift; review and recapture the changed UI`)
      } catch (error) { errors.push(`${label}: ${error.message}`) }
    } else {
      if (!entry.reason || typeof entry.reason !== 'string') errors.push(`${label}: legacy/historical evidence needs a reason`)
      if (entry.capturedAt !== null && !Number.isFinite(Date.parse(entry.capturedAt))) errors.push(`${label}: invalid capture time`)
      if (entry.status === 'needs-recapture') {
        pending.push(entry.path)
        if (strict) errors.push(`${label}: needs recapture`)
      }
    }
  }
  for (const file of filesBelow(join(publicDir, 'screenshots'))) {
    const path = relative(publicDir, file)
    if (imagePath(path) && !paths.has(path)) errors.push(`untracked image: ${path}`)
  }
  for (const file of filesBelow(join(root, 'docs-site/content'))) {
    if (!/\.(mdx?|tsx?)$/.test(file)) continue
    for (const match of readFileSync(file, 'utf8').matchAll(/\/screenshots\/[^\s)"'<>]+\.(?:png|jpe?g|webp)/gi)) {
      const path = match[0].slice(1)
      if (!paths.has(path) || !existsSync(join(publicDir, path))) errors.push(`${relative(root, file)}: broken screenshot reference ${path}`)
    }
  }
  return { errors, pending, total: paths.size }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkScreenshots(repoRoot, { strict: process.argv.includes('--strict') })
  for (const error of result.errors) console.error(error)
  console.log(`screenshots: ${result.total ?? 0} tracked, ${result.pending.length} explicitly awaiting recapture, ${result.errors.length} errors`)
  process.exitCode = result.errors.length ? 1 : 0
}
