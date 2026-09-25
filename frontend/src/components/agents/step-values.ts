/**
 * Values a workflow step reads from earlier steps.
 *
 * A step's text fields are stored as templates: `{{input.message}}`,
 * `{{nodes.llm_1.output}}`. That format is what the engine resolves and it
 * stays exactly as it is. What changes is what a person sees: the panel
 * shows each reference as a chip named after the step and the field
 * ("Input › message", "Model call › Answer"), and picks new ones from a
 * list of the earlier steps instead of asking for the syntax.
 *
 * Everything here is pure, so a template can be split and put back
 * together byte for byte: opening a panel never rewrites what was saved.
 */
import type { Edge, Node } from '@xyflow/react'

/** A step type's name as the panels say it (the palette, the canvas and the builder's checks say it the same way). */
export const STEP_NAMES: Record<string, string> = {
  input: 'Input',
  output: 'Output',
  llm_call: 'Model call',
  tool_call: 'Tool call',
  condition: 'Condition',
  loop: 'Loop',
  transform: 'Transform',
  merge: 'Merge',
  parallel: 'Parallel',
  sub_agent: 'Sub-agent',
  verify: 'Verify',
  extract_context: 'Extract context',
  decision: 'Decision',
}

export type TemplateSegment = { kind: 'text'; text: string } | { kind: 'ref'; path: string; raw: string }

const REF = /\{\{([^}]+)\}\}/g

/** Split a template into text and references. `joinTemplate(parseTemplate(t)) === t` for every string. */
export function parseTemplate(template: string): TemplateSegment[] {
  const out: TemplateSegment[] = []
  let last = 0
  for (const m of template.matchAll(REF)) {
    const at = m.index ?? 0
    if (at > last) out.push({ kind: 'text', text: template.slice(last, at) })
    out.push({ kind: 'ref', path: m[1].trim(), raw: m[0] })
    last = at + m[0].length
  }
  if (last < template.length) out.push({ kind: 'text', text: template.slice(last) })
  return out
}

export function joinTemplate(segments: TemplateSegment[]): string {
  return segments.map((s) => (s.kind === 'text' ? s.text : s.raw)).join('')
}

/** The template for a reference path. */
export function refTemplate(path: string): string {
  return `{{${path}}}`
}

/** The one reference a value is, when it is exactly one and nothing else. */
export function singleRef(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const segments = parseTemplate(value)
  return segments.length === 1 && segments[0].kind === 'ref' ? segments[0].path : null
}

export interface StepField {
  label: string
  /** The reference path, e.g. `nodes.llm_1.output` or `input.message`. */
  path: string
}

export interface StepEntry {
  nodeId: string
  name: string
  fields: StepField[]
}

type ToolLike = { id: string; schema?: { output?: any } | null }

/** What a step is called in the panel: its own label, else its type, numbered when there are several. */
export function stepName(node: Node, nodes: Node[]): string {
  const own = typeof node.data?.label === 'string' ? (node.data.label as string).trim() : ''
  if (own) return own
  const base = STEP_NAMES[node.type ?? ''] ?? node.type ?? 'Step'
  const same = nodes.filter((n) => n.type === node.type)
  if (same.length <= 1) return base
  return `${base} ${same.findIndex((n) => n.id === node.id) + 1}`
}

/** The fields the input step starts with; a message when it declares none. */
export function inputFields(node: Node | undefined): StepField[] {
  const props = (node?.data?.schema as any)?.properties
  const keys = props && typeof props === 'object' ? Object.keys(props) : []
  if (keys.length === 0) return [{ label: 'message', path: 'input.message' }]
  return keys.map((key) => ({ label: (props[key]?.title as string) || key, path: `input.${key}` }))
}

function outputFields(node: Node, tools: ToolLike[]): StepField[] {
  const out = `nodes.${node.id}.output`
  switch (node.type) {
    case 'input':
      return inputFields(node)
    case 'llm_call':
    case 'sub_agent':
    case 'decision':
      return [{ label: 'Answer', path: out }]
    case 'tool_call': {
      const tool = tools.find((t) => t.id === node.data?.toolId)
      const props = tool?.schema?.output?.properties
      const extra = props && typeof props === 'object' ? Object.keys(props).map((key) => ({ label: key, path: `${out}.${key}` })) : []
      return [{ label: 'Result', path: out }, ...extra]
    }
    case 'loop':
      return [{ label: 'Items', path: out }]
    case 'extract_context':
      return [{ label: 'Brief', path: out }]
    case 'verify':
      return [
        { label: 'Verdict', path: `${out}.verdict` },
        { label: 'Passed', path: `${out}.passed` },
        { label: 'Failures', path: `${out}.failures` },
      ]
    case 'transform':
    case 'merge':
      return [{ label: 'Result', path: out }]
    default:
      // Output, condition and parallel hand nothing on worth naming.
      return []
  }
}

/** Every node that runs before `nodeId`, following the wires back. */
function ancestors(nodeId: string, edges: Edge[]): Set<string> {
  const seen = new Set<string>()
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const e of edges) {
      if (e.target === current && !seen.has(e.source)) {
        seen.add(e.source)
        queue.push(e.source)
      }
    }
  }
  return seen
}

/**
 * The steps a step can read from, with their fields. With the wires, the
 * steps that run before it; without them, every other step. The input step
 * is always there: a run's input is readable from anywhere.
 */
export function earlierSteps(current: Node | null, nodes: Node[], edges?: Edge[], tools: ToolLike[] = []): StepEntry[] {
  const before = current && edges ? ancestors(current.id, edges) : null
  return nodes
    .filter((n) => !current || n.id !== current.id)
    .filter((n) => n.type === 'input' || !before || before.has(n.id))
    .map((n) => ({ nodeId: n.id, name: stepName(n, nodes), fields: outputFields(n, tools) }))
    .filter((s) => s.fields.length > 0)
}

/** A reference, named for a person: "Model call › Answer". Unknown paths read as themselves. */
export function refLabel(path: string, steps: StepEntry[], nodes: Node[] = []): string {
  for (const s of steps) {
    const field = s.fields.find((f) => f.path === path)
    if (field) return `${s.name} › ${field.label}`
  }
  if (path === 'input') return 'Input'
  if (path.startsWith('input.')) return `Input › ${path.slice('input.'.length)}`
  const m = /^nodes\.([^.]+)\.output(?:\.(.+))?$/.exec(path)
  if (m) {
    const node = nodes.find((n) => n.id === m[1])
    const name = node ? stepName(node, nodes) : m[1]
    return m[2] ? `${name} › ${m[2]}` : `${name} › Result`
  }
  return path
}
