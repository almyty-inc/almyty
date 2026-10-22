/**
 * What a held tool call would do, readable.
 *
 * An approval's payload is the tool, the arguments it would run with, and
 * the fields the server keeps for itself (`_gate`: the rule that held it,
 * a fingerprint of the call, who made it). The approver needs the first
 * two in words, not a JSON dump with the bookkeeping in it. Internal
 * fields are the ones whose name starts with an underscore; they are never
 * shown, not even in the raw view.
 */
import { humanizeIdentifier } from '@/lib/tool-names'

export interface ActionDetail {
  label: string
  value: string
}

type Schema = Record<string, any> | null | undefined

const MAX_DEPTH = 3

function isInternal(key: string): boolean {
  return key.startsWith('_')
}

/** The payload without any internal (`_`-prefixed) field, at any depth. */
export function withoutInternalFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInternalFields)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isInternal(k)) out[k] = withoutInternalFields(v)
  }
  return out
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

function propertySchema(schema: Schema, key: string): Schema {
  const props = schema?.properties
  return props && typeof props === 'object' ? (props as Record<string, any>)[key] : undefined
}

function labelOf(key: string, schema: Schema): string {
  const title = typeof schema?.title === 'string' ? schema.title.trim() : ''
  return title || humanizeIdentifier(key)
}

/** An array as one line: plain values joined, objects by their plain values. */
function arrayText(items: unknown[]): string {
  return items
    .map((item) => {
      if (isPrimitive(item)) return String(item)
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const parts = Object.entries(item as Record<string, unknown>)
          .filter(([k, v]) => !isInternal(k) && isPrimitive(v) && v !== '')
          .map(([, v]) => String(v))
        return parts.length ? parts.join(' ') : JSON.stringify(withoutInternalFields(item))
      }
      return JSON.stringify(withoutInternalFields(item))
    })
    .filter((s) => s !== '')
    .join(', ')
}

function collect(args: Record<string, unknown>, schema: Schema, prefix: string, depth: number, out: ActionDetail[]) {
  for (const [key, value] of Object.entries(args)) {
    if (isInternal(key) || value === null || value === undefined || value === '') continue
    const sub = propertySchema(schema, key)
    const label = prefix ? `${prefix} › ${labelOf(key, sub)}` : labelOf(key, sub)
    if (isPrimitive(value)) {
      out.push({ label, value: String(value) })
    } else if (Array.isArray(value)) {
      if (value.length) out.push({ label, value: arrayText(value) })
    } else if (typeof value === 'object') {
      if (depth >= MAX_DEPTH) out.push({ label, value: JSON.stringify(withoutInternalFields(value)) })
      else collect(value as Record<string, unknown>, sub, label, depth + 1, out)
    }
  }
}

/** The arguments of the call: `parameters` (a held tool call), else the payload itself. */
function argumentsOf(payload: Record<string, any>): Record<string, unknown> {
  if (payload.parameters && typeof payload.parameters === 'object' && !Array.isArray(payload.parameters)) {
    return payload.parameters
  }
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (k !== 'tool' && k !== 'kind' && k !== 'changeSet') rest[k] = v
  }
  return rest
}

/**
 * The call's arguments as label/value rows, labelled with the tool's own
 * parameter titles where its schema has them and in words otherwise.
 * Nested objects read as "Start › Date time".
 */
export function actionDetailsOf(payload: unknown, schema?: Schema): ActionDetail[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const out: ActionDetail[] = []
  collect(argumentsOf(payload as Record<string, any>), schema, '', 1, out)
  return out
}
