import * as fs from 'fs'
import * as path from 'path'

/**
 * A route with a parameter must not be declared above a fixed route it
 * swallows. Express matches in registration order and Nest registers a
 * controller's handlers in declaration order, so `@Get(':id')` above
 * `@Get('provider-types')` sends every request for the fixed path to the
 * `:id` handler: with a ParseUUIDPipe that is a 400, without one it is
 * the wrong handler. GET /llm-providers/provider-types answered 400 this
 * way and the connect form lost what it said about each provider.
 *
 * Read from the source, so a new controller is covered the day it lands.
 */
const ROOTS = [path.join(__dirname, '..'), path.join(__dirname, '..', '..', 'ee')]
const ROUTE = /@(Get|Post|Put|Patch|Delete|All)\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?\s*\)/g

interface Route {
  method: string
  path: string
  line: number
}

function controllers(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') controllers(p, out)
    } else if (entry.name.endsWith('.controller.ts')) {
      out.push(p)
    }
  }
  return out
}

function routesOf(source: string): Route[] {
  const routes: Route[] = []
  for (const m of source.matchAll(ROUTE)) {
    routes.push({
      method: m[1],
      path: (m[2] ?? m[3] ?? m[4] ?? '').replace(/^\/+|\/+$/g, ''),
      line: source.slice(0, m.index).split('\n').length,
    })
  }
  return routes
}

/** Does `earlier` match every request meant for `later`, which has a fixed segment where it has a parameter? */
export function shadows(earlier: Route, later: Route): boolean {
  if (earlier.method !== later.method && earlier.method !== 'All') return false
  const a = earlier.path.split('/')
  const b = later.path.split('/')
  if (a.length !== b.length || earlier.path === later.path) return false
  let fixedWhereParam = false
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) {
      if (!b[i].startsWith(':')) fixedWhereParam = true
      continue
    }
    if (a[i] !== b[i]) return false
  }
  return fixedWhereParam
}

export function shadowedRoutes(source: string): string[] {
  const routes = routesOf(source)
  const found: string[] = []
  routes.forEach((later, j) => {
    for (const earlier of routes.slice(0, j)) {
      if (shadows(earlier, later)) {
        found.push(`${later.method} '${later.path}' (line ${later.line}) is swallowed by '${earlier.path}' (line ${earlier.line})`)
      }
    }
  })
  return found
}

describe('no parameter route swallows a fixed route declared after it', () => {
  it('sees the case it guards against', () => {
    const source = `@Get(':providerId')\nget() {}\n@Get('provider-types')\ntypes() {}`
    expect(shadowedRoutes(source)).toHaveLength(1)
    expect(shadowedRoutes(`@Get('provider-types')\ntypes() {}\n@Get(':providerId')\nget() {}`)).toEqual([])
    expect(shadowedRoutes(`@Get(':a/:b')\nx() {}\n@Get('detail/:id')\ny() {}`)).toHaveLength(1)
    expect(shadowedRoutes(`@Post(':id')\nx() {}\n@Get('fixed')\ny() {}`)).toEqual([])
  })

  it('holds for every controller', () => {
    const files = ROOTS.flatMap((root) => controllers(root))
    expect(files.length).toBeGreaterThan(20)
    const problems = files.flatMap((file) =>
      shadowedRoutes(fs.readFileSync(file, 'utf8')).map((p) => `${path.relative(ROOTS[0], file)}: ${p}`),
    )
    expect(problems).toEqual([])
  })
})
