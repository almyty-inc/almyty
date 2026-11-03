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
import { formatDateTime } from '@/lib/utils'

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

/** A full date and time (2026-10-23T10:30:00Z), as an approver reads one. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

function isDateTime(v: unknown): v is string {
  return typeof v === 'string' && DATE_TIME.test(v) && !Number.isNaN(Date.parse(v))
}

/** A plain value in words: a date and time in the approver's own time zone, anything else as it is. */
function valueText(v: string | number | boolean): string {
  return isDateTime(v) ? formatDateTime(v) : String(v)
}

const START_WORDS = new Set(['start', 'starts', 'begin', 'begins'])
const END_WORDS = new Set(['end', 'ends', 'finish', 'finishes', 'until'])
const wordsOf = (key: string) => humanizeIdentifier(key).toLowerCase().split(' ')
const isStartKey = (key: string) => wordsOf(key).some((w) => START_WORDS.has(w))
const isEndKey = (key: string) => wordsOf(key).some((w) => END_WORDS.has(w))

/**
 * The fields in the order a person reads them: the tool's own parameter
 * order where its schema gives one, then the rest as sent; and a start
 * always before an end, whatever order the call put them in.
 */
function orderedEntries(args: Record<string, unknown>, schema: Schema): Array<[string, unknown]> {
  const props = schema?.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : []
  const keys = [...props.filter((k) => k in args), ...Object.keys(args).filter((k) => !props.includes(k))]
  const firstEnd = keys.findIndex(isEndKey)
  if (firstEnd >= 0) {
    const lateStarts = keys.slice(firstEnd + 1).filter((k) => isStartKey(k) && !isEndKey(k))
    if (lateStarts.length) {
      const rest = keys.filter((k) => !lateStarts.includes(k))
      rest.splice(rest.indexOf(keys[firstEnd]), 0, ...lateStarts)
      return rest.map((k) => [k, args[k]])
    }
  }
  return keys.map((k) => [k, args[k]])
}

function collect(args: Record<string, unknown>, schema: Schema, prefix: string, depth: number, out: ActionDetail[]) {
  for (const [key, value] of orderedEntries(args, schema)) {
    if (isInternal(key) || value === null || value === undefined || value === '') continue
    const sub = propertySchema(schema, key)
    const label = prefix ? `${prefix} › ${labelOf(key, sub)}` : labelOf(key, sub)
    if (isPrimitive(value)) {
      out.push({ label, value: valueText(value) })
    } else if (Array.isArray(value)) {
      if (value.length) out.push({ label, value: arrayText(value) })
    } else if (typeof value === 'object') {
      // `start: { dateTime }` reads as "Start", not "Start › Date time".
      const shown = Object.entries(value as Record<string, unknown>).filter(([k, v]) => !isInternal(k) && v !== null && v !== undefined && v !== '')
      if (shown.length === 1 && isDateTime(shown[0][1])) out.push({ label, value: valueText(shown[0][1]) })
      else if (depth >= MAX_DEPTH) out.push({ label, value: JSON.stringify(withoutInternalFields(value)) })
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

/** Who a step waits for, in words: one of them, or how many more. */
function approverWords(role: string, remaining: number): string {
  const one: Record<string, string> = {
    '*': 'any approver',
    owner: 'an owner',
    admin: 'an admin',
    member: 'a member',
    viewer: 'a viewer',
    team_lead: "the team's lead",
    team_member: 'a team member',
  }
  const many: Record<string, string> = {
    '*': 'approvers',
    owner: 'owners',
    admin: 'admins',
    member: 'members',
    viewer: 'viewers',
    team_lead: 'team leads',
    team_member: 'team members',
  }
  if (remaining <= 1) return one[role] ?? `someone with the “${role}” role`
  return `${remaining} more ${many[role] ?? `people with the “${role}” role`}`
}

/**
 * Where a request under a multi-step approval policy stands, from the
 * server's own score of it (`_policy.progress`): "Step 2 of 3: waiting for
 * an admin". Null for a request no policy governs, or one with a single
 * step that needs one approval (there is nothing to say beyond "pending").
 */
export function policyStepOf(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const progress = (payload as Record<string, any>)._policy?.progress
  const steps: any[] = Array.isArray(progress?.steps) ? progress.steps : []
  if (steps.length === 0 || progress.satisfied) return null
  const index = typeof progress.currentStep === 'number' && progress.currentStep >= 0 ? progress.currentStep : 0
  const step = steps[index]
  if (!step) return null
  const required = Number(step.required) || 1
  if (steps.length === 1 && required <= 1) return null
  const remaining = Math.max(1, required - (Number(step.satisfiedBy) || 0))
  const name = typeof step.name === 'string' && step.name.trim() ? ` (${step.name.trim()})` : ''
  return `Step ${index + 1} of ${steps.length}${name}: waiting for ${approverWords(String(step.approverRole ?? '*'), remaining)}`
}
