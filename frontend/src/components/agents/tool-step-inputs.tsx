/**
 * What a tool step gives its tool: one row per parameter the tool declares
 * (its JSON Schema `parameters`), each answered one of three ways:
 *
 *   Ask the user           `{{input.<name>}}`, and the input step gains the field
 *   From an earlier step   a value picked from the steps before this one
 *   Fixed value            the text as typed
 *
 * Stored in `parameterMapping` as before, in whichever shape the node
 * already had (a list of { key, value } or an object), entries in their
 * original order; a parameter nobody touched is not written. Values the
 * tool does not declare are kept, and edited under Advanced.
 */
import { useState } from 'react'
import type { Node } from '@xyflow/react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StepValueField, StepValueSelect } from './step-value-field'
import { refTemplate, singleRef } from './step-values'

export interface MappingEntry {
  key: string
  value: unknown
}

export type ParamSource = 'ask' | 'step' | 'fixed' | 'none'

/** A tool's declared inputs: its `parameters` schema, as the function-calling APIs send it. */
export function toolParameters(tool: any): { properties: Record<string, any>; required: string[] } | null {
  const schema = tool?.parameters ?? tool?.schema?.input ?? tool?.metadata?.inputSchema
  if (!schema || typeof schema !== 'object' || !schema.properties || typeof schema.properties !== 'object') return null
  return { properties: schema.properties, required: Array.isArray(schema.required) ? schema.required : [] }
}

/** The mapping as ordered entries, whichever shape it was saved in. */
export function mappingEntries(mapping: unknown): MappingEntry[] {
  if (Array.isArray(mapping)) return mapping.map((m: any) => ({ key: String(m?.key ?? ''), value: m?.value }))
  if (mapping && typeof mapping === 'object') return Object.entries(mapping as Record<string, unknown>).map(([key, value]) => ({ key, value }))
  return []
}

/** Entries back in the shape the node had; a list stays a list, an object an object. */
export function toMapping(entries: MappingEntry[], like: unknown): unknown {
  if (like && typeof like === 'object' && !Array.isArray(like)) return Object.fromEntries(entries.map((e) => [e.key, e.value]))
  return entries.map((e) => ({ key: e.key, value: e.value }))
}

/** Where a saved value comes from. */
export function sourceOf(key: string, value: unknown): ParamSource {
  if (value === undefined) return 'none'
  if (typeof value === 'string') {
    if (singleRef(value) === `input.${key}`) return 'ask'
    if (value.includes('{{')) return 'step'
  }
  return 'fixed'
}

const SOURCE_LABELS: Record<Exclude<ParamSource, 'none'>, string> = {
  ask: 'Ask the user',
  step: 'From an earlier step',
  fixed: 'Fixed value',
}

export interface ToolStepInputsProps {
  node: Node
  nodes: Node[]
  tool: any
  onUpdateNode: (nodeId: string, data: Record<string, unknown>) => void
}

export function ToolStepInputs({ node, nodes, tool, onUpdateNode }: ToolStepInputsProps) {
  const mapping = node.data.parameterMapping
  const entries = mappingEntries(mapping)
  const params = toolParameters(tool)
  // A source picked but not yet filled (an empty step or fixed value)
  // still shows as picked.
  const [picked, setPicked] = useState<Record<string, ParamSource>>({})

  const write = (next: MappingEntry[]) => onUpdateNode(node.id, { ...node.data, parameterMapping: toMapping(next, mapping) })

  const setValue = (key: string, value: unknown) => {
    const at = entries.findIndex((e) => e.key === key)
    if (at === -1) write([...entries, { key, value }])
    else write(entries.map((e, i) => (i === at ? { ...e, value } : e)))
  }

  const clear = (key: string) => write(entries.filter((e) => e.key !== key))

  /** "Ask the user" asks at the start of the run, so the input step gains the field. */
  const addInputField = (key: string, prop: any) => {
    const input = nodes.find((n) => n.type === 'input')
    if (!input) return
    const schema = (input.data.schema as Record<string, any>) || {}
    const props = (schema.properties as Record<string, any>) || {}
    if (props[key]) return
    const field = { type: typeof prop?.type === 'string' ? prop.type : 'string', ...(prop?.description ? { description: prop.description } : {}) }
    // A step with no fields took a message; it keeps it next to the new one.
    const nextProps = Object.keys(props).length === 0 ? { message: { type: 'string' }, [key]: field } : { ...props, [key]: field }
    onUpdateNode(input.id, { ...input.data, schema: { ...schema, type: schema.type ?? 'object', properties: nextProps } })
  }

  const choose = (key: string, source: ParamSource, prop: any) => {
    setPicked((prev) => ({ ...prev, [key]: source }))
    if (source === 'none') clear(key)
    else if (source === 'ask') {
      // The input step first: the builder selects whichever step was written
      // last, and this step is the one being edited.
      addInputField(key, prop)
      setValue(key, refTemplate(`input.${key}`))
    } else setValue(key, '')
  }

  if (!params) {
    return (
      <OtherValues
        title="What it gets"
        node={node}
        entries={entries}
        known={[]}
        write={write}
        hint="This tool does not say what it takes. Name each value and where it comes from."
      />
    )
  }

  const names = Object.keys(params.properties)
  return (
    <div className="space-y-3" data-testid="tool-step-inputs">
      <div>
        <p className="text-sm font-medium">What it needs</p>
        {names.length === 0 && <p className="mt-1 text-xs text-muted-foreground">This tool takes nothing.</p>}
      </div>
      {names.map((key) => {
        const prop = params.properties[key] ?? {}
        const required = params.required.includes(key)
        const entry = entries.find((e) => e.key === key)
        const source = picked[key] && picked[key] !== 'none' && entry ? picked[key] : sourceOf(key, entry?.value)
        const title = (prop.title as string) || key
        const id = `tool-param-${node.id}-${key}`
        return (
          <div key={key} className="space-y-2 rounded-lg border bg-background p-2" data-testid={`tool-param-${key}`}>
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={`${id}-source`} className="text-xs">
                {title}
                {required ? '' : ' (optional)'}
              </Label>
              {prop.type && <span className="text-[10px] text-muted-foreground">{String(prop.type)}</span>}
            </div>
            {prop.description && <p className="text-[11px] text-muted-foreground">{prop.description}</p>}
            <Select value={source === 'none' ? '' : source} onValueChange={(v) => choose(key, v as ParamSource, prop)}>
              <SelectTrigger id={`${id}-source`} aria-label={`Where ${title} comes from`} className="h-8 text-xs">
                <SelectValue placeholder="Choose where it comes from" />
              </SelectTrigger>
              <SelectContent>
                {(['ask', 'step', 'fixed'] as const).map((s) => (
                  <SelectItem key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </SelectItem>
                ))}
                {!required && <SelectItem value="none">Leave it out</SelectItem>}
              </SelectContent>
            </Select>
            {source === 'ask' && <p className="text-[11px] text-muted-foreground">Asked when the run starts, as &ldquo;{key}&rdquo;.</p>}
            {source === 'step' && (
              <StepValueSelect id={`${id}-value`} label={`${title} from`} hideLabel value={typeof entry?.value === 'string' ? entry.value : ''} onChange={(v) => setValue(key, v)} />
            )}
            {source === 'fixed' && (
              <Input
                id={`${id}-value`}
                aria-label={`${title} value`}
                className="h-8 text-xs"
                value={entry?.value === undefined || entry?.value === null ? '' : typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)}
                onChange={(e) => setValue(key, e.target.value)}
              />
            )}
            {source === 'none' && required && <p className="text-[11px] text-amber-700 dark:text-amber-400">The tool needs this.</p>}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Values the tool does not declare (or all of them, for a tool that
 * declares nothing): a name and a value each. Kept so a saved mapping is
 * never dropped.
 */
export function OtherValues({ title, node, entries, known, write, hint }: { title: string; node: Node; entries: MappingEntry[]; known: string[]; write: (next: MappingEntry[]) => void; hint?: string }) {
  const rows = entries.map((e, index) => ({ ...e, index })).filter((e) => !known.includes(e.key))
  const patch = (index: number, next: Partial<MappingEntry>) => write(entries.map((e, i) => (i === index ? { ...e, ...next } : e)))
  return (
    <div className="space-y-2" data-testid="tool-other-values">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {rows.map((row) => (
        <div key={row.index} className="space-y-1 rounded-lg border bg-background p-2">
          <div className="flex items-center gap-1">
            <Input className="h-8 text-xs" aria-label={`Value ${row.index + 1} name`} placeholder="name" value={row.key} onChange={(e) => patch(row.index, { key: e.target.value })} />
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`Remove value ${row.index + 1}`} onClick={() => write(entries.filter((_, i) => i !== row.index))}>
              <X className="h-3 w-3" />
            </Button>
          </div>
          <StepValueField
            id={`other-value-${node.id}-${row.index}`}
            label={`Value ${row.index + 1}`}
            hideLabel
            value={typeof row.value === 'string' ? row.value : row.value === undefined ? '' : JSON.stringify(row.value)}
            onChange={(v) => patch(row.index, { value: v })}
          />
        </div>
      ))}
      <Button variant="outline" size="sm" className="w-full" onClick={() => write([...entries, { key: '', value: '' }])}>
        Add a value
      </Button>
    </div>
  )
}
