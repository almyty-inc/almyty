import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, basename } from 'path'

const SRC = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const files = walk(SRC)
const isTest = (f: string) => /(__tests__|\.test\.|\.spec\.)/.test(f)

/**
 * A component nobody renders is not a component, it is a liability.
 *
 * Three of them were found at once: a 716-line provider sheet superseded
 * by a real detail page, a 522-line API dialog whose `open` state was
 * never set true, and a 314-line protocol monitor subscribing to an SSE
 * feed the backend does not publish. All three compiled, two had passing
 * tests, and no user could reach any of them. The tests were the worst
 * part -- they made dead screens look maintained.
 *
 * A file exporting a component must be imported from somewhere that is
 * not its own test. Being reachable from a route is a separate question;
 * this only catches code that is not referenced at all.
 */
describe('every component file is imported by something real', () => {
  it('has no orphans', () => {
    const sources = files.filter(f => !isTest(f))

    // Read every file ONCE, up front, and refuse to guess about one that
    // will not read.
    //
    // This walks the filesystem while the rest of the suite is running.
    // Reading lazily meant a single transient failure silently dropped
    // that file's imports out of the graph, and whatever it was the only
    // importer of then looked orphaned -- a flake that accuses innocent
    // code. A file that genuinely cannot be read is a real problem and
    // says so, rather than becoming a wrong answer about a different
    // file.
    const contents = new Map<string, string>()
    const unreadable: string[] = []
    for (const f of sources) {
      try {
        contents.set(f, readFileSync(f, 'utf8'))
      } catch {
        unreadable.push(relative(SRC, f))
      }
    }
    expect(unreadable).toEqual([])

    const importGraph = [...contents.values()].join('\n')

    const orphans = sources
      .filter(f => f.includes(`${'/'}components${'/'}`) || f.includes(`${'/'}pages${'/'}`))
      .filter(f => /export (function|const|default) [A-Z]/.test(contents.get(f) ?? ''))
      .filter(f => {
        // Match on the module specifier's last segment, which is how every
        // import in this codebase ends regardless of alias or relative form.
        // Bare quotes rather than `from`, because routes are pulled in as
        // `lazy(() => import('@/pages/x'))`.
        const stem = basename(f).replace(/\.tsx?$/, '')
        const referenced = new RegExp(`['"][^'"]*/${stem}['"]`).test(importGraph)
        return !referenced
      })
      .map(f => relative(SRC, f))

    expect(orphans).toEqual([])
  })
})
