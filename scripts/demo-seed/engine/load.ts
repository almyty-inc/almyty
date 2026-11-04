// Loads every walk family, puts macros in place and checks each walk
// against the schema, so a broken entry fails before anything runs.
import { parseWalk, type Walk } from './schema.ts'
import { MACROS, expand, type Macro } from './macros.ts'
import { TEMPLATES, type Template } from './render.ts'
import type { Action } from './run.ts'
import { ACTIONS } from './actions.ts'

/** A family: walks that share a stack profile, with the macros, actions and page templates only they use. */
export interface Family {
  name: string
  walks: unknown[]
  macros?: Record<string, Macro>
  actions?: Record<string, Action>
  templates?: Record<string, Template>
}

export interface Loaded {
  walks: Walk[]
  byId: Map<string, Walk>
  actions: Record<string, Action>
  templates: Record<string, Template>
}

function merge<T>(kind: string, base: Record<string, T>, families: Family[], pick: (f: Family) => Record<string, T> | undefined): Record<string, T> {
  const out = { ...base }
  for (const f of families) {
    for (const [k, v] of Object.entries(pick(f) ?? {})) {
      if (k in out) throw new Error(`${kind} ${k} is defined twice (family ${f.name})`)
      out[k] = v
    }
  }
  return out
}

export function load(families: Family[]): Loaded {
  const macros = merge('macro', MACROS, families, (f) => f.macros)
  const actions = merge('action', ACTIONS, families, (f) => f.actions)
  const templates = merge('page template', TEMPLATES, families, (f) => f.templates)
  const errors: string[] = []
  const walks: Walk[] = []
  for (const f of families) {
    for (const raw of f.walks) {
      try {
        const shallow = parseWalk(raw)
        walks.push(parseWalk({ ...shallow, steps: expand(shallow.steps, macros) }))
      } catch (e) { errors.push((e as Error).message) }
    }
  }
  const byId = new Map<string, Walk>()
  const paths = new Map<string, string>()
  for (const w of walks) {
    if (byId.has(w.id)) errors.push(`walk ${w.id} is defined twice`)
    byId.set(w.id, w)
    for (const [id, s] of Object.entries(w.shots)) {
      const other = paths.get(s.path)
      if (other) errors.push(`walk ${w.id}, shot ${id}: ${s.path} is also taken by ${other}`)
      paths.set(s.path, `${w.id}/${id}`)
    }
  }
  for (const w of walks) {
    for (const a of w.after ?? []) {
      const dep = byId.get(a)
      if (!dep) errors.push(`walk ${w.id} runs after ${a}, which does not exist`)
      else if (dep.profile !== w.profile) errors.push(`walk ${w.id} runs after ${a}, which needs another stack profile (${dep.profile})`)
    }
  }
  if (errors.length) throw new Error(errors.join('\n'))
  return { walks, byId, actions, templates }
}

/** The walks to run for these ids, with the walks they need first, in order. */
export function plan(loaded: Loaded, ids: string[]): Walk[] {
  const out: Walk[] = []
  const seen = new Set<string>()
  const visit = (id: string, chain: string[]) => {
    if (seen.has(id)) return
    if (chain.includes(id)) throw new Error(`walks ${[...chain, id].join(' -> ')} need each other`)
    const w = loaded.byId.get(id)
    if (!w) throw new Error(`no walk called ${id}`)
    for (const a of w.after ?? []) visit(a, [...chain, id])
    seen.add(id)
    out.push(w)
  }
  for (const id of ids) visit(id, [])
  return out
}
