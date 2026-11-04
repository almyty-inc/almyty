// The walks and the screenshot manifest must agree: every screenshot the
// manifest says came from the local demo is taken by exactly one walk
// step, and every screenshot a walk takes is in the manifest, under the
// same title and sources.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Walk } from './schema.ts'

export interface ManifestEntry {
  id: string
  path: string
  title: string
  status: string
  source?: { kind?: string; environment?: string; route?: string }
  sources?: string[]
}

export const manifestPath = (root: string) => join(root, 'docs-site/public/screenshots/manifest.json')

export function readManifest(root: string): ManifestEntry[] {
  return JSON.parse(readFileSync(manifestPath(root), 'utf8')).screenshots
}

/** Screenshots the local demo stack produces. */
export const fromDemo = (e: ManifestEntry) => e.source?.kind === 'browser' && e.source.environment === 'local-demo'

export function checkCoverage(walks: Walk[], manifest: ManifestEntry[]): string[] {
  const problems: string[] = []
  const taken = new Map<string, { walk: string; shot: string; title: string; sources: string[] }[]>()
  for (const w of walks) {
    for (const [shot, s] of Object.entries(w.shots)) {
      const list = taken.get(s.path) ?? []
      list.push({ walk: w.id, shot, title: s.title, sources: s.sources })
      taken.set(s.path, list)
    }
  }
  const byPath = new Map(manifest.map((e) => [e.path, e]))
  for (const e of manifest.filter(fromDemo)) {
    const by = taken.get(e.path) ?? []
    if (by.length === 0) problems.push(`${e.path}: in the manifest as a local-demo capture, but no walk takes it`)
    if (by.length > 1) problems.push(`${e.path}: taken by ${by.length} walk steps (${by.map((b) => `${b.walk}/${b.shot}`).join(', ')}); one step per screenshot`)
  }
  for (const [path, by] of taken) {
    const e = byPath.get(path)
    for (const b of by) {
      const at = `${b.walk}/${b.shot}`
      if (!e) { problems.push(`${at}: ${path} is not in the manifest; capture it and register it`); continue }
      if (!fromDemo(e) && e.status === 'current') problems.push(`${at}: ${path} is in the manifest, but not as a local-demo capture`)
      if (e.title !== b.title) problems.push(`${at}: title "${b.title}" differs from the manifest's "${e.title}"`)
      if (JSON.stringify(e.sources ?? []) !== JSON.stringify(b.sources)) problems.push(`${at}: sources differ from the manifest's (${(e.sources ?? []).join(', ')})`)
    }
  }
  return problems
}
