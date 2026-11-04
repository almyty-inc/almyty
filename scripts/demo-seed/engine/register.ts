// Registers reviewed captures in the screenshot manifest through
// docs-site/scripts/record-screenshot.mjs: the image, its route, when it
// was taken and the sources it shows.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { Walk } from './schema.ts'
import type { Capture } from './run.ts'
import { ROOT } from './env.ts'

const DEFAULT_NOTE = 'Local seeded demo stack (scripts/demo-seed), fake model vendors and company APIs; not staging or production data.'

export function register(walk: Walk, captures: Record<string, Capture>, shots: string[]): string[] {
  const done: string[] = []
  for (const id of shots.length ? shots : Object.keys(walk.shots)) {
    const shot = walk.shots[id]
    if (!shot) throw new Error(`walk ${walk.id} takes no shot ${id}`)
    const c = captures[id]
    if (!c) { console.log(`not captured: ${walk.id}/${id}`); continue }
    execFileSync(process.execPath, [
      join(ROOT, 'docs-site/scripts/record-screenshot.mjs'),
      '--image', c.file, '--path', shot.path, '--title', shot.title, '--captured-at', c.at,
      '--route', c.route, '--environment', 'local-demo', '--notes', shot.notes ?? walk.notes ?? DEFAULT_NOTE,
      ...shot.sources.flatMap((s) => ['--sources', s]),
    ], { stdio: 'inherit' })
    done.push(id)
  }
  return done
}
