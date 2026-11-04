// {{name}} in walk data. A string that is one placeholder and nothing else
// becomes the value itself (an object, a list, a number); placeholders
// inside longer text become text. Filters follow a bar:
//
//   {{agent.id}}                         a value the walk remembered
//   {{env.DEMO_API_URL}}                 the environment
//   {{tools|where:name~^northwind_|map:id}}  filter a list, take one field
//   {{orders|first}} {{orders|last}} {{orders|len}} {{answer|rows:agents}} {{row|get:id}}
//   {{$now|add:2m|hhmm}}                 the time two minutes from now, as 14:05
//   {{$uuid}} {{$ms}}                    a fresh id, the clock in milliseconds
//   {{payload|json}} {{name|sql}} {{payload|sqljson}}   quoted for a body or a query
//   {{!input.days}}                      left as {{input.days}}, for the product's own templates
import { randomUUID } from 'node:crypto'

export type Vars = Record<string, unknown>

const ONE = /^\{\{\s*([^{}]+?)\s*\}\}$/
const ANY = /\{\{\s*([^{}]+?)\s*\}\}/g

export function lookup(vars: Vars, path: string): unknown {
  if (path === '$uuid') return randomUUID()
  if (path === '$ms') return Date.now()
  if (path === '$now') return new Date()
  if (path.startsWith('env.')) return process.env[path.slice(4)]
  let cur: unknown = vars
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

const UNITS: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 }
const pad = (n: number) => String(n).padStart(2, '0')

function field(row: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, k) => (cur == null ? undefined : (cur as Record<string, unknown>)[k]), row)
}

export function applyFilter(value: unknown, filter: string): unknown {
  const [name, ...rest] = filter.split(':')
  const arg = rest.join(':')
  const list = () => {
    if (!Array.isArray(value)) throw new Error(`filter ${name} needs a list, got ${typeof value}`)
    return value as unknown[]
  }
  switch (name) {
    case 'json': return JSON.stringify(value)
    case 'sql': return `'${String(value ?? '').replace(/'/g, "''")}'`
    case 'sqljson': return `'${JSON.stringify(value).replace(/'/g, "''")}'`
    case 'rows': return Array.isArray(value) ? value : (['items', 'data', 'results', arg].filter(Boolean).map((k) => (value as Record<string, unknown>)?.[k]).find(Array.isArray) ?? [])
    case 'get': return field(value, arg)
    case 'first': return list()[0]
    case 'last': return list().at(-1)
    case 'len': return list().length
    case 'map': return list().map((row) => field(row, arg))
    case 'where': {
      const m = arg.match(/^([\w.]+)(~|=|!=)(.*)$/)
      if (!m) throw new Error(`where:${arg} should be field~regex, field=value or field!=value`)
      const [, key, op, want] = m
      const re = op === '~' ? new RegExp(want) : null
      return list().filter((row) => {
        const v = field(row, key)
        if (re) return re.test(String(v ?? ''))
        return op === '=' ? String(v) === want : String(v) !== want
      })
    }
    case 'add': {
      const m = arg.match(/^(-?\d+)([smhd])$/)
      if (!m || !(value instanceof Date)) throw new Error(`add:${arg} needs a time and an amount like 2m`)
      return new Date(value.getTime() + Number(m[1]) * UNITS[m[2]])
    }
    case 'hhmm': {
      if (!(value instanceof Date)) throw new Error('hhmm needs a time')
      return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`
    }
    case 'iso': {
      if (!(value instanceof Date)) throw new Error('iso needs a time')
      return value.toISOString()
    }
    case 'default': return value === undefined || value === null || value === '' ? arg : value
    case 'upper': return String(value).toUpperCase()
    default: throw new Error(`unknown filter ${name}`)
  }
}

function evaluate(expr: string, vars: Vars): unknown {
  // {{!input.days}} is the product's own placeholder, kept as {{input.days}}.
  if (expr.startsWith('!')) return `{{${expr.slice(1)}}}`
  const [path, ...filters] = expr.split('|').map((s) => s.trim())
  let value = lookup(vars, path)
  if (value === undefined && !filters.some((f) => f.startsWith('default'))) throw new Error(`{{${expr}}}: nothing is called ${path}`)
  for (const f of filters) value = applyFilter(value, f)
  return value
}

/** Fill in placeholders anywhere in a value; regular expressions and non-strings pass through. */
export function render<T>(value: T, vars: Vars): T {
  if (typeof value === 'string') {
    const one = value.match(ONE)
    if (one) return evaluate(one[1], vars) as T
    return value.replace(ANY, (_, expr: string) => {
      const v = evaluate(expr, vars)
      return typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : JSON.stringify(v)
    }) as T
  }
  if (Array.isArray(value)) return value.map((v) => render(v, vars)) as T
  if (value && typeof value === 'object' && !(value instanceof RegExp) && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, vars)])) as T
  }
  return value
}

/** Set a dotted name: remember('apis.orders', row). */
export function assign(vars: Vars, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = vars as Record<string, unknown>
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>
  cur[parts.at(-1)!] = value
}
