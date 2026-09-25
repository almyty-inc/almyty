import React, { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Edge, Node } from '@xyflow/react'
import { X, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Disclosure } from '@/components/ui/disclosure'
import { CodeEditor } from '@/components/ui/code-editor'
import { JsonSchemaBuilder } from '@/components/JsonSchemaBuilder'

import { agentsApi } from '@/lib/api'
import { toolsQuery } from '@/lib/list-queries'
import { useOrganizationStore } from '@/store/organization'
import { NODE_TYPE_CONFIG, type PipelineNodeType } from './nodes'
import { ModelPicker, type ModelSelection, type ProviderOption } from '@/components/model-picker'
import type { Tool, Agent } from '@/types'
import type { RoutingPolicy } from '@/types/models'
import { STEP_NAMES, earlierSteps } from './step-values'
import { StepCatalog, StepTextMode, StepValueField, StepValueSelect } from './step-value-field'
import { OtherValues, ToolStepInputs, mappingEntries, toMapping, toolParameters, type MappingEntry } from './tool-step-inputs'

// ─── Shared types ────────────────────────────────────────────────────────────

type NodeData = Record<string, unknown>

type UpdateDataFn = (key: string, value: unknown) => void

interface NodeConfigPanelProps {
  node: Node | null
  nodes: Node[]
  /** The wires, so a step offers the values of the steps before it. Without them every other step is offered. */
  edges?: Edge[]
  onUpdateNode: (nodeId: string, data: NodeData) => void
  onDeleteNode: (nodeId: string) => void
  onClose: () => void
}

interface ParameterMapping {
  key: string
  value: string
}

// ─── Model fields shared by every node that calls a model ────────────────────

/** What a node's data says about its model, in the picker's terms. */
function nodeModelSelection(node: Node): ModelSelection {
  const routing = node.data.routing
  return {
    providerId: (node.data.providerId as string) || undefined,
    model: (node.data.model as string) || undefined,
    routing: routing && typeof routing === 'object' ? (routing as RoutingPolicy) : undefined,
  }
}

/**
 * The node's data with a new model selection. A pinned provider and a
 * routing policy are exclusive on the node: choosing one removes the other,
 * and choosing neither leaves the organization default to answer. Other
 * fields, a `roleKey` included, are kept.
 */
function withModelSelection(data: NodeData, next: ModelSelection, provider?: ProviderOption): NodeData {
  const { routing: _r, providerId: _p, providerName: _pn, providerType: _pt, model: _m, ...rest } = data
  if (next.routing) return { ...rest, routing: next.routing }
  if (next.providerId) {
    return { ...rest, providerId: next.providerId, providerName: provider?.name || '', providerType: provider?.type || '', model: next.model || '' }
  }
  return rest
}

/** Provider, model or policy for a node whose provider may be left to the org default. */
function NodeModelField({ node, idPrefix, onUpdateNode }: { node: Node; idPrefix: string; onUpdateNode: (nodeId: string, data: NodeData) => void }) {
  const roleKey = node.data.roleKey as string | undefined
  const selection = nodeModelSelection(node)
  if (roleKey && !selection.providerId && !selection.routing) {
    return (
      <div>
        <Label>Model</Label>
        <p className="text-xs text-muted-foreground mt-1">
          Filled at run time by role <code>{roleKey}</code>.
        </p>
      </div>
    )
  }
  return (
    <ModelPicker
      idPrefix={idPrefix}
      layout="stack"
      allowRouting
      providerOptionalLabel="Organization default routing policy"
      value={selection}
      onChange={(next, provider) => onUpdateNode(node.id, withModelSelection(node.data, next, provider))}
    />
  )
}

/**
 * The bottom of every step: what a first pass does not need. Each step
 * passes its own extras; the step's id and "Edit values as text" are here
 * for all of them.
 */
function StepAdvanced({ node, children }: { node: Node; children?: React.ReactNode }) {
  const { asText, setAsText } = React.useContext(StepTextMode)
  return (
    <Disclosure title="Advanced" testId="step-advanced">
      {children}
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`step-as-text-${node.id}`} className="text-xs font-normal">
          Edit values as text
        </Label>
        <Switch id={`step-as-text-${node.id}`} checked={asText} onCheckedChange={setAsText} />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Step id</Label>
        <div className="mt-0.5 font-mono text-xs" data-testid="step-id">
          {node.id}
        </div>
      </div>
    </Disclosure>
  )
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export function NodeConfigPanel(props: NodeConfigPanelProps) {
  if (!props.node) return null
  // Keyed by node id: "Edit values as text" and every per-step picker start
  // fresh on each step rather than carrying over from the last one.
  return <StepPanel key={props.node.id} {...props} node={props.node} />
}

function StepPanel({ node, nodes, edges, onUpdateNode, onDeleteNode, onClose }: NodeConfigPanelProps & { node: Node }) {
  const { currentOrganization } = useOrganizationStore()
  const [asText, setAsText] = useState(false)
  const { data: toolsPage } = useQuery({ ...toolsQuery(currentOrganization?.id), enabled: !!currentOrganization })
  const tools = (toolsPage?.items ?? []) as any[]
  const steps = useMemo(() => earlierSteps(node, nodes, edges, tools), [node, nodes, edges, tools])

  const nodeType = node.type as PipelineNodeType
  const config = NODE_TYPE_CONFIG[nodeType]

  const updateData: UpdateDataFn = (key, value) => {
    try {
      onUpdateNode(node.id, { ...node.data, [key]: value })
    } catch (err) {
      console.error('[NodeConfigPanel] Failed to update node data:', err)
    }
  }

  return (
    <StepTextMode.Provider value={{ asText, setAsText }}>
      <StepCatalog.Provider value={{ steps, nodes }}>
        <div className="w-full lg:w-[320px] border-l bg-muted/30 flex flex-col overflow-hidden h-full">
          {/* Header */}
          <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full ${config?.color || 'bg-zinc-500'}`} />
              <span className="text-sm font-semibold">{STEP_NAMES[nodeType] || nodeType}</span>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close step settings" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {nodeType === 'input' && <InputConfig node={node} updateData={updateData} />}
            {nodeType === 'output' && <OutputConfig node={node} updateData={updateData} />}
            {nodeType === 'llm_call' && <LlmCallConfig node={node} tools={tools} updateData={updateData} onUpdateNode={onUpdateNode} />}
            {nodeType === 'tool_call' && <ToolCallConfig node={node} nodes={nodes} tools={tools} onUpdateNode={onUpdateNode} />}
            {nodeType === 'condition' && <ConditionConfig node={node} updateData={updateData} />}
            {nodeType === 'transform' && <TransformConfig node={node} updateData={updateData} />}
            {nodeType === 'merge' && <MergeConfig node={node} updateData={updateData} onUpdateNode={onUpdateNode} />}
            {nodeType === 'parallel' && <ParallelConfig node={node} />}
            {nodeType === 'sub_agent' && <SubAgentConfig node={node} updateData={updateData} onUpdateNode={onUpdateNode} />}
            {nodeType === 'loop' && <LoopConfig node={node} updateData={updateData} />}
            {nodeType === 'verify' && <VerifyConfig node={node} updateData={updateData} />}
            {nodeType === 'extract_context' && <ExtractContextConfig node={node} updateData={updateData} onUpdateNode={onUpdateNode} />}
            {nodeType === 'decision' && <DecisionConfig node={node} updateData={updateData} onUpdateNode={onUpdateNode} />}
          </div>

          {/* Footer: delete */}
          <div className="px-4 py-3 border-t shrink-0">
            <Button variant="destructive" size="sm" className="w-full" onClick={() => onDeleteNode(node.id)}>
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Delete step
            </Button>
          </div>
        </div>
      </StepCatalog.Provider>
    </StepTextMode.Provider>
  )
}

// --- Input ---

const FIELD_TYPES = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Whole number' },
  { value: 'boolean', label: 'Yes or no' },
  { value: 'array', label: 'List' },
  { value: 'object', label: 'Group of fields' },
] as const

/**
 * "What does it start with?": the fields a run is given, one row each. A
 * step that declares none starts with a message, which is what chat and
 * the API send; it is shown, and only written once something changes. The
 * whole schema is under Advanced.
 */
function InputConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  const schema = (node.data.schema as Record<string, any>) || {}
  const props: Record<string, any> = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const declared = Object.keys(props)
  const rows = declared.length > 0 ? declared : ['message']
  const current = declared.length > 0 ? props : { message: { type: 'string' } }

  const write = (nextProps: Record<string, any>, required?: string[]) => {
    const req = (required ?? (Array.isArray(schema.required) ? schema.required : [])).filter((k: string) => k in nextProps)
    updateData('schema', { ...schema, type: schema.type ?? 'object', properties: nextProps, ...(schema.required !== undefined || req.length > 0 ? { required: req } : {}) })
  }
  const rename = (from: string, to: string) => {
    const next: Record<string, any> = {}
    for (const k of Object.keys(current)) next[k === from ? to : k] = current[k]
    const required = (Array.isArray(schema.required) ? schema.required : []).map((k: string) => (k === from ? to : k))
    write(next, required)
  }
  const retype = (key: string, type: string) => write({ ...current, [key]: { ...current[key], type } })
  const remove = (key: string) => {
    const { [key]: _gone, ...rest } = current
    write(rest)
  }
  const add = () => {
    let n = rows.length + 1
    while (`field_${n}` in current) n += 1
    write({ ...current, [`field_${n}`]: { type: 'string' } })
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">What does it start with?</p>
        <p className="mt-1 text-xs text-muted-foreground">What a run is given. Chat and the API send a message.</p>
      </div>
      <div className="space-y-2">
        {rows.map((key, i) => (
          <div key={`${i}`} className="flex items-center gap-1" data-testid={`input-field-${key}`}>
            <Input className="h-8 text-xs" aria-label={`Field ${i + 1} name`} value={key} onChange={(e) => e.target.value && rename(key, e.target.value)} />
            <Select value={current[key]?.type ?? 'string'} onValueChange={(v) => retype(key, v)}>
              <SelectTrigger className="h-8 w-32 shrink-0 text-xs" aria-label={`Field ${i + 1} kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {rows.length > 1 && (
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`Remove field ${i + 1}`} onClick={() => remove(key)}>
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        ))}
        <Button variant="outline" size="sm" className="w-full" onClick={add}>
          Add a field
        </Button>
      </div>
      <StepAdvanced node={node}>
        <div>
          <Label>Schema</Label>
          <div className="mt-1">
            <JsonSchemaBuilder value={(node.data.schema as Record<string, unknown>) || { type: 'object', properties: {} }} onChange={(next) => updateData('schema', next)} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">The JSON Schema a run&apos;s input is checked against.</p>
        </div>
      </StepAdvanced>
    </div>
  )
}

// --- Output ---
function OutputConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  return (
    <div className="space-y-3">
      <StepValueField
        id="output-mapping"
        label="What it answers with"
        multiline
        value={(node.data.mapping as string) || ''}
        onChange={(v) => updateData('mapping', v)}
        placeholder="Usually the last step's answer"
        hint="Arrives as text: an answer that is a list or an object comes as JSON."
      />
      <StepAdvanced node={node} />
    </div>
  )
}

// --- Model call ---
function LlmCallConfig({ node, tools, updateData, onUpdateNode }: { node: Node; tools: any[]; updateData: UpdateDataFn; onUpdateNode: (nodeId: string, data: NodeData) => void }) {
  const [toolSearch, setToolSearch] = useState('')
  const [showAllTools, setShowAllTools] = useState(false)
  const temperature = typeof node.data.temperature === 'number' ? node.data.temperature : 0.7
  const toolList = tools as Array<Pick<Tool, 'id' | 'name'>>

  return (
    <div className="space-y-3">
      {/* Model selection: a pinned provider + model, or a routing policy the
          catalog resolves at run time. The two are exclusive on the node:
          routing replaces providerId, switching back removes routing. */}
      <ModelPicker
        idPrefix="node"
        layout="stack"
        allowRouting
        value={nodeModelSelection(node)}
        // One write for all fields, so no update lands on stale data.
        onChange={(next, provider) => onUpdateNode(node.id, withModelSelection(node.data, next, provider))}
      />

      <StepValueField
        id="system-prompt"
        label="Instructions"
        multiline
        value={(node.data.systemPrompt as string) || ''}
        onChange={(v) => updateData('systemPrompt', v)}
        placeholder="You are a helpful assistant..."
      />

      <StepValueField
        id="user-prompt"
        label="Message"
        multiline
        value={(node.data.userPromptTemplate as string) || ''}
        onChange={(v) => updateData('userPromptTemplate', v)}
        placeholder="What to send the model, e.g. the input's message"
      />

      <div>
        {(() => {
          const selectedTools: string[] = (node.data.toolIds as string[]) || []
          const allIds = toolList.map((t: any) => t.id)

          // Group tools by source
          const grouped: Record<string, typeof toolList> = {}
          toolList.forEach((t: any) => {
            const source = t.metadata?.sourceApi?.name || t.metadata?.apiName || (t.type === 'api' ? 'API tools' : 'Your tools')
            if (!grouped[source]) grouped[source] = []
            grouped[source].push(t)
          })
          const groups = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))

          return (
            <>
              <div className="flex items-center justify-between">
                <Label>Tools it can use</Label>
                <span className="text-xs text-muted-foreground">
                  {selectedTools.length} of {toolList.length}
                </span>
              </div>

              {toolList.length === 0 ? (
                <p className="text-xs text-muted-foreground mt-1">No tools yet. Make some under Tools.</p>
              ) : (
                <>
                  <div className="flex gap-1 mt-1 mb-2">
                    <button type="button" className="text-[10px] px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors" onClick={() => updateData('toolIds', allIds)}>
                      All
                    </button>
                    <button type="button" className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground transition-colors" onClick={() => updateData('toolIds', [])}>
                      None
                    </button>
                    {groups.map(([source, groupTools]) => (
                      <button
                        key={source}
                        type="button"
                        className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground transition-colors truncate max-w-[80px]"
                        onClick={() => {
                          const groupIds = (groupTools as any[]).map((t) => t.id)
                          const otherIds = selectedTools.filter((id) => !groupIds.includes(id))
                          const allGroupSelected = groupIds.every((id) => selectedTools.includes(id))
                          updateData('toolIds', allGroupSelected ? otherIds : [...otherIds, ...groupIds])
                        }}
                        title={source}
                      >
                        {source}
                      </button>
                    ))}
                  </div>

                  <Input
                    placeholder="Filter tools"
                    value={toolSearch}
                    onChange={(e) => {
                      setToolSearch(e.target.value)
                      setShowAllTools(false)
                    }}
                    className="mb-1 text-xs h-7"
                  />

                  <div className="space-y-0.5 max-h-[180px] overflow-y-auto border rounded-md p-1.5">
                    {groups.map(([source, groupTools]) => {
                      const filtered = toolSearch ? (groupTools as any[]).filter((t) => t.name?.toLowerCase().includes(toolSearch.toLowerCase())) : (groupTools as any[])
                      if (filtered.length === 0) return null
                      const groupIds = (groupTools as any[]).map((t) => t.id)
                      const allSelected = groupIds.every((id) => selectedTools.includes(id))
                      return (
                        <div key={source}>
                          <button
                            type="button"
                            className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground py-1 w-full hover:text-foreground"
                            onClick={() => {
                              const otherIds = selectedTools.filter((id) => !groupIds.includes(id))
                              updateData('toolIds', allSelected ? otherIds : [...otherIds, ...groupIds])
                            }}
                          >
                            <input type="checkbox" checked={allSelected} readOnly className="rounded" />
                            {source} ({filtered.length})
                          </button>
                          {(!showAllTools && filtered.length > 5 ? filtered.slice(0, 5) : filtered).map((tool: any) => {
                            const isSelected = selectedTools.includes(tool.id)
                            return (
                              <label key={tool.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/10 rounded px-1 py-0.5 ml-3">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => {
                                    updateData('toolIds', e.target.checked ? [...selectedTools, tool.id] : selectedTools.filter((id) => id !== tool.id))
                                  }}
                                  className="rounded"
                                />
                                <span className="truncate">{tool.name}</span>
                              </label>
                            )
                          })}
                          {!showAllTools && filtered.length > 5 && (
                            <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground ml-3 py-0.5" onClick={() => setShowAllTools(true)}>
                              +{filtered.length - 5} more
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </>
          )
        })()}
      </div>

      <StepAdvanced node={node}>
        <div>
          <Label>Temperature: {temperature.toFixed(2)}</Label>
          <Slider className="mt-2" value={[temperature]} min={0} max={2} step={0.01} onValueChange={([v]) => updateData('temperature', v)} />
          <p className="mt-1 text-xs text-muted-foreground">Lower is steadier, higher is more varied.</p>
        </div>
        <div>
          <Label htmlFor="max-tokens">Longest answer (tokens)</Label>
          <Input
            id="max-tokens"
            type="number"
            className="mt-1"
            value={(node.data.maxTokens as number) || ''}
            onChange={(e) => updateData('maxTokens', e.target.value ? parseInt(e.target.value) : undefined)}
            placeholder="4096"
          />
        </div>
      </StepAdvanced>
    </div>
  )
}

// --- Tool call ---
function ToolCallConfig({ node, nodes, tools, onUpdateNode }: { node: Node; nodes: Node[]; tools: any[]; onUpdateNode: (nodeId: string, data: NodeData) => void }) {
  const toolList = tools as Array<Pick<Tool, 'id' | 'name'>>
  const tool = tools.find((t) => t.id === node.data.toolId)
  const params = toolParameters(tool)
  const mapping = node.data.parameterMapping
  const entries = mappingEntries(mapping)
  const extra = params ? entries.filter((e) => !(e.key in params.properties)) : []

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="tool-step-tool">Tool</Label>
        <Select
          value={(node.data.toolId as string) || ''}
          onValueChange={(v) => {
            const picked = toolList.find((t) => t.id === v)
            onUpdateNode(node.id, {
              ...node.data,
              toolId: v,
              toolName: picked?.name || '',
            })
          }}
        >
          <SelectTrigger id="tool-step-tool" className="mt-1">
            <SelectValue placeholder="Pick a tool" />
          </SelectTrigger>
          <SelectContent>
            {/*
              A required field whose select opens on nothing is a dead
              end: the node fails validation, Save is blocked, and the
              screen never says why.
            */}
            {toolList.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No tools yet. Make some from an API, or under Tools.</div>}
            {toolList.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {node.data.toolId ? <ToolStepInputs node={node} nodes={nodes} tool={tool} onUpdateNode={onUpdateNode} /> : null}

      <StepAdvanced node={node}>
        {params && (
          <OtherValues
            title="Other values it gets"
            node={node}
            entries={entries}
            known={Object.keys(params.properties)}
            write={(next: MappingEntry[]) => onUpdateNode(node.id, { ...node.data, parameterMapping: toMapping(next, mapping) })}
            hint={extra.length === 0 ? 'Values the tool does not list, sent along with the rest.' : undefined}
          />
        )}
      </StepAdvanced>
    </div>
  )
}

// --- Condition operators ---
const CONDITION_OPERATORS = [
  { value: '===', label: 'equals' },
  { value: '!==', label: 'does not equal' },
  { value: '>', label: 'is more than' },
  { value: '<', label: 'is less than' },
  { value: '>=', label: 'is at least' },
  { value: '<=', label: 'is at most' },
  { value: 'includes', label: 'contains' },
  { value: '!includes', label: 'does not contain' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
] as const

// --- Parse a condition expression into parts ---
function parseConditionExpression(expr: string): { source: string; operator: string; value: string } | null {
  // Try to parse: source operator value
  for (const op of CONDITION_OPERATORS) {
    if (op.value === 'includes' || op.value === '!includes' || op.value === 'startsWith' || op.value === 'endsWith') {
      // Pattern: source.includes('value') or !source.includes('value')
      const negate = op.value.startsWith('!')
      const method = negate ? op.value.slice(1) : op.value
      const regex = new RegExp(`^(\\!?)(.*?)\\.${method}\\(['"](.*)['"]\\)$`)
      const match = expr.match(regex)
      if (match) {
        const isNegated = match[1] === '!'
        if ((negate && isNegated) || (!negate && !isNegated)) {
          return { source: match[2], operator: op.value, value: match[3] }
        }
      }
    } else {
      // Pattern: source === 'value' or source > 123
      const regex = new RegExp(`^(.*?)\\s*${op.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*['"]?(.*)['"]?$`)
      const match = expr.match(regex)
      if (match) {
        return { source: match[1].trim(), operator: op.value, value: match[2].replace(/['"]/g, '').trim() }
      }
    }
  }
  return null
}

// --- Build condition expression from parts ---
function buildConditionExpression(source: string, operator: string, value: string): string {
  if (!source) return ''
  if (operator === 'includes') return `${source}.includes('${value}')`
  if (operator === '!includes') return `!${source}.includes('${value}')`
  if (operator === 'startsWith') return `${source}.startsWith('${value}')`
  if (operator === 'endsWith') return `${source}.endsWith('${value}')`
  // Numeric comparison - don't quote if it's a number
  const isNumeric = !isNaN(Number(value)) && value.trim() !== ''
  const quotedValue = isNumeric ? value : `'${value}'`
  return `${source} ${operator} ${quotedValue}`
}

// --- Condition ---
function ConditionConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  const { asText } = React.useContext(StepTextMode)
  const expression = (node.data.expression as string) || ''
  const parsed = useMemo(() => parseConditionExpression(expression), [expression])
  // The parts are held here, seeded from the node: an expression is only
  // built once all three say something.
  const [condSource, setCondSource] = useState(parsed?.source || '')
  const [condOperator, setCondOperator] = useState(parsed?.operator || '===')
  const [condValue, setCondValue] = useState(parsed?.value || '')

  const updateCondition = (source: string, operator: string, value: string) => {
    setCondSource(source)
    setCondOperator(operator)
    setCondValue(value)
    updateData('expression', buildConditionExpression(source, operator, value))
  }

  const custom = !!expression && !parsed

  return (
    <div className="space-y-3">
      {asText ? (
        <div>
          <Label>Condition</Label>
          <div className="mt-1">
            <CodeEditor value={expression} onChange={(value) => updateData('expression', value)} language="javascript" height="100px" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">An expression that comes out true or false.</p>
        </div>
      ) : custom ? (
        <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground" data-testid="condition-custom">
          This condition is written as an expression. Change it under Advanced with Edit values as text.
        </p>
      ) : (
        <div className="space-y-2 border rounded-lg p-3 bg-muted/30">
          <StepValueSelect id="node-if" label="If" value={condSource} onChange={(v) => updateCondition(v, condOperator, condValue)} />

          <div>
            <Label htmlFor="node-operator" className="text-xs">
              Is
            </Label>
            <Select value={condOperator} onValueChange={(v) => updateCondition(condSource, v, condValue)}>
              <SelectTrigger id="node-operator" className="mt-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITION_OPERATORS.map((op) => (
                  <SelectItem key={op.value} value={op.value}>
                    {op.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="node-value" className="text-xs">
              Value
            </Label>
            <Input id="node-value" className="mt-1 text-xs" value={condValue} onChange={(e) => updateCondition(condSource, condOperator, e.target.value)} placeholder="What to compare with" />
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">The right-hand handle is the yes path, the bottom one the no path.</p>
      <StepAdvanced node={node} />
    </div>
  )
}

// --- Transform ---
function TransformConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  return (
    <div className="space-y-3">
      <StepValueField
        id="transform-expr"
        label="Result"
        multiline
        value={(node.data.expression as string) || ''}
        onChange={(v) => updateData('expression', v)}
        placeholder="Text with values from earlier steps"
        hint="Put earlier values into text. Shaped like JSON, it still arrives downstream as text."
      />
      <StepAdvanced node={node} />
    </div>
  )
}

// --- Merge ---
const MERGE_STRATEGIES = [
  { value: 'first_response', label: 'First to finish', summary: 'Passes on the first branch that finishes.' },
  { value: 'best_of_n', label: 'Best answer, picked by a judge', summary: 'A judge model picks the best branch.' },
  { value: 'concatenate', label: 'All of them, joined', summary: 'Passes on every branch, joined.' },
  { value: 'consensus', label: 'What most agree on', summary: 'Passes on what most branches agree on.' },
] as const

function MergeConfig({ node, updateData, onUpdateNode }: { node: Node; updateData: UpdateDataFn; onUpdateNode: (nodeId: string, data: NodeData) => void }) {
  const strategy = (node.data.strategy as string) || 'first_response'
  const current = MERGE_STRATEGIES.find((s) => s.value === strategy)
  return (
    <div className="space-y-3">
      <p className="text-sm" data-testid="merge-summary">
        {current?.summary ?? 'Combines the branches wired into it.'}
      </p>
      <StepAdvanced node={node}>
        <div>
          <Label htmlFor="node-merge-strategy">How to combine</Label>
          <Select value={strategy} onValueChange={(v) => updateData('strategy', v)}>
            <SelectTrigger id="node-merge-strategy" className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MERGE_STRATEGIES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {(strategy === 'best_of_n' || strategy === 'consensus') && (
          // The executor reads a pinned judge from judgeConfig and a policy from the node.
          <ModelPicker
            idPrefix="merge-judge"
            layout="stack"
            allowRouting
            providerLabel="Judge provider"
            modelLabel="Judge model"
            providerOptionalLabel="Organization default routing policy"
            value={{
              providerId: (node.data.judgeConfig as any)?.providerId,
              model: (node.data.judgeConfig as any)?.model,
              routing: (node.data.routing as RoutingPolicy) || undefined,
            }}
            onChange={(next) => {
              const { judgeConfig, routing: _routing, ...rest } = node.data as Record<string, any>
              const { providerId: _p, model: _m, ...judgeRest } = (judgeConfig || {}) as Record<string, any>
              const nextJudge = next.providerId ? { ...judgeRest, providerId: next.providerId, model: next.model || undefined } : judgeRest
              onUpdateNode(node.id, {
                ...rest,
                ...(Object.keys(nextJudge).length > 0 ? { judgeConfig: nextJudge } : {}),
                ...(next.routing ? { routing: next.routing } : {}),
              })
            }}
          />
        )}

        {strategy === 'best_of_n' && (
          <>
            <div>
              <Label htmlFor="judge-prompt">What the judge looks for</Label>
              <Textarea
                id="judge-prompt"
                className="mt-1 text-xs"
                rows={4}
                value={(node.data.judgePrompt as string) || ''}
                onChange={(e) => updateData('judgePrompt', e.target.value)}
                placeholder="Pick the best response considering quality and accuracy..."
              />
              <p className="mt-1 text-xs text-muted-foreground">Leave it empty to ask for the best one. The judge answers with the option number only.</p>
            </div>
            <p className="text-xs text-muted-foreground">
              The judge uses this step&apos;s own model, else the organization&apos;s default routing policy. With neither, the run fails here. A single branch is
              passed on without judging.
            </p>
          </>
        )}

        {strategy === 'consensus' && (
          <div>
            <Label htmlFor="consensus-threshold">How many must agree</Label>
            <Input
              id="consensus-threshold"
              type="number"
              className="mt-1"
              min={0}
              max={1}
              step={0.1}
              value={(node.data.consensusThreshold as number) ?? 0.5}
              onChange={(e) => updateData('consensusThreshold', parseFloat(e.target.value))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              A share from 0 to 1. The step also hands on <code>agreement</code> and <code>consensusReached</code>, so a condition after it can branch on
              disagreement.
            </p>
          </div>
        )}
      </StepAdvanced>
    </div>
  )
}

// --- Parallel ---
function ParallelConfig({ node }: { node: Node }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Runs every branch wired out of it at the same time. Wire the branches into a merge step to collect them.</p>
      <StepAdvanced node={node} />
    </div>
  )
}

// --- Sub-agent ---
function SubAgentConfig({ node, updateData, onUpdateNode }: { node: Node; updateData: UpdateDataFn; onUpdateNode: (nodeId: string, data: NodeData) => void }) {
  const { data: agents } = useQuery({
    queryKey: ['agents-for-subagent'],
    queryFn: async () => {
      const res = await agentsApi.getAll()
      const result = Array.isArray(res) ? res : res?.agents || []
      return Array.isArray(result) ? result : []
    },
  })

  const agentList = (agents || []) as Array<Pick<Agent, 'id' | 'name'>>
  const mappings: ParameterMapping[] = (node.data.inputMapping as ParameterMapping[]) || []

  const updateMapping = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...mappings]
    updated[index] = { ...updated[index], [field]: val }
    updateData('inputMapping', updated)
  }

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="sub-agent-agent">Agent</Label>
        <Select
          value={(node.data.agentId as string) || ''}
          onValueChange={(v) => {
            const agent = agentList.find((a) => a.id === v)
            // One write, not two: onUpdateNode replaces `data` wholesale, so
            // writing the name second used to drop the id written first.
            onUpdateNode(node.id, {
              ...node.data,
              agentId: v,
              agentName: agent?.name || '',
            })
          }}
        >
          <SelectTrigger id="sub-agent-agent" className="mt-1">
            <SelectValue placeholder="Pick an agent" />
          </SelectTrigger>
          <SelectContent>
            {agentList.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No other agents to call yet.</div>}
            {agentList.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">What to send it</p>
        {mappings.map((m, i) => (
          <div key={i} className="space-y-1 rounded-lg border bg-background p-2">
            <div className="flex items-center gap-1">
              <Input className="h-8 text-xs" aria-label={`Value ${i + 1} name`} placeholder="name" value={m.key} onChange={(e) => updateMapping(i, 'key', e.target.value)} />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label={`Remove value ${i + 1}`}
                onClick={() =>
                  updateData(
                    'inputMapping',
                    mappings.filter((_, j) => j !== i),
                  )
                }
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
            <StepValueField id={`sub-agent-value-${i}`} label={`Value ${i + 1}`} hideLabel value={m.value || ''} onChange={(v) => updateMapping(i, 'value', v)} />
          </div>
        ))}
        <Button variant="outline" size="sm" className="w-full" onClick={() => updateData('inputMapping', [...mappings, { key: '', value: '' }])}>
          Add a value
        </Button>
      </div>
      <StepAdvanced node={node} />
    </div>
  )
}

// --- Loop ---
function LoopConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  return (
    <div className="space-y-3">
      <StepValueSelect id="loop-items" label="Go through" value={(node.data.iterableExpression as string) || ''} onChange={(v) => updateData('iterableExpression', v)} placeholder="Pick a list from an earlier step" />
      <p className="text-xs text-muted-foreground">
        Hands on that list, up to the most items set under Advanced. The steps after it run once, on the whole list; to run them per item, fan out through a
        parallel step.
      </p>
      <StepAdvanced node={node}>
        <div>
          <Label htmlFor="node-max-iterations">Most items</Label>
          <Input
            id="node-max-iterations"
            type="number"
            className="mt-1"
            min={1}
            max={1000}
            value={(node.data.maxIterations as number) || 100}
            onChange={(e) => updateData('maxIterations', parseInt(e.target.value) || 100)}
          />
        </div>
      </StepAdvanced>
    </div>
  )
}

// --- Verify ---

interface VerifyChecker {
  name?: string
  providerId?: string
  model?: string
  roleKey?: string
  instructions?: string
}

const VERIFY_POLICIES = [
  { value: 'any_fail_blocks', label: 'Any checker fails, it fails' },
  { value: 'majority', label: 'Most checkers decide' },
  { value: 'all_pass', label: 'Every checker must pass' },
] as const

function VerifyConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  const checkers: VerifyChecker[] = Array.isArray(node.data.checkers) ? (node.data.checkers as VerifyChecker[]) : []

  // Every write goes through the whole list, so a checker that names a role
  // and nothing else -- what the strategy compiler emits, and what keeps an
  // ejected graph portable -- keeps its roleKey when any other field is
  // edited.
  const patchChecker = (index: number, patch: Partial<VerifyChecker>) => {
    updateData(
      'checkers',
      checkers.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    )
  }
  const addChecker = () => {
    updateData('checkers', [...checkers, { name: '', providerId: '', model: '', instructions: '' }])
  }
  const removeChecker = (index: number) => {
    updateData(
      'checkers',
      checkers.filter((_, i) => i !== index),
    )
  }

  return (
    <div className="space-y-3">
      <StepValueField
        id="verify-target"
        label="What to check"
        multiline
        value={(node.data.target as string) || ''}
        onChange={(v) => updateData('target', v || undefined)}
        placeholder="Empty: the answer of the step wired into it"
      />

      <StepValueField
        id="verify-spec"
        label="Rules"
        multiline
        value={(node.data.spec as string) || ''}
        onChange={(v) => updateData('spec', v)}
        placeholder="The answer must cite a source for every figure."
        hint="What every checker holds it to."
      />

      <div>
        <div className="flex items-center justify-between">
          <Label>Checkers</Label>
          <span className="text-xs text-muted-foreground">{checkers.length}</span>
        </div>

        {checkers.length === 0 && <p className="text-xs text-muted-foreground mt-1">Add at least one. Give each a different provider for a panel across vendors.</p>}

        <div className="mt-2 space-y-2">
          {checkers.map((checker, i) => (
            <div key={i} className="rounded-lg border p-2 space-y-2 bg-background">
              <div className="flex items-center gap-1">
                <Input className="text-xs" aria-label={`Checker ${i + 1} name`} placeholder="name" value={checker.name || ''} onChange={(e) => patchChecker(i, { name: e.target.value })} />
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`Remove checker ${i + 1}`} onClick={() => removeChecker(i)}>
                  <X className="h-3 w-3" />
                </Button>
              </div>

              {checker.roleKey && !checker.providerId && (
                <p className="text-[11px] text-muted-foreground">
                  Filled at run time by role <code>{checker.roleKey}</code>. Pick a provider below to pin it instead.
                </p>
              )}

              <ModelPicker
                idPrefix={`checker-${i}`}
                layout="stack"
                compact
                modelOptional
                providerLabel={`Checker ${i + 1} provider`}
                modelLabel={`Checker ${i + 1} model`}
                value={{ providerId: checker.providerId, model: checker.model }}
                onChange={(next) => patchChecker(i, { providerId: next.providerId, model: next.model })}
              />

              <Textarea
                className="text-xs"
                rows={2}
                aria-label={`Checker ${i + 1} instructions`}
                placeholder="What this checker looks for (optional)"
                value={checker.instructions || ''}
                onChange={(e) => patchChecker(i, { instructions: e.target.value })}
              />
            </div>
          ))}

          <Button variant="outline" size="sm" className="w-full" onClick={addChecker}>
            Add checker
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        A checker only tries to find what is wrong. The step never fails the run: it hands on <code>verdict</code>, <code>passed</code> and <code>failures</code>, and a
        condition after it decides what happens next.
      </p>

      <StepAdvanced node={node}>
        <div>
          <Label htmlFor="verify-policy">How the checkers agree</Label>
          <Select value={(node.data.policy as string) || 'any_fail_blocks'} onValueChange={(v) => updateData('policy', v)}>
            <SelectTrigger id="verify-policy" className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VERIFY_POLICIES.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </StepAdvanced>
    </div>
  )
}

// --- Extract context ---
function ExtractContextConfig({ node, updateData, onUpdateNode }: { node: Node; updateData: UpdateDataFn; onUpdateNode: (nodeId: string, data: NodeData) => void }) {
  return (
    <div className="space-y-3">
      <StepValueField
        id="extract-task"
        label="What the brief is for"
        multiline
        value={(node.data.task as string) || ''}
        onChange={(v) => updateData('task', v || undefined)}
        placeholder="Empty: the run's input"
      />

      <StepValueField
        id="extract-sources"
        label="What to boil down"
        multiline
        value={(node.data.sources as string) || ''}
        onChange={(v) => updateData('sources', v || undefined)}
        placeholder="Empty: the steps wired into it"
        hint="With neither this nor a step wired in, the step fails rather than pass everything on."
      />

      <NodeModelField node={node} idPrefix="extract" onUpdateNode={onUpdateNode} />

      <StepAdvanced node={node}>
        <div>
          <Label htmlFor="extract-instruction">Instruction</Label>
          <Textarea
            id="extract-instruction"
            className="mt-1 text-xs"
            rows={3}
            value={(node.data.instruction as string) || ''}
            onChange={(e) => updateData('instruction', e.target.value || undefined)}
            placeholder="Empty: the built-in instruction"
          />
          <p className="text-xs text-muted-foreground mt-1">
            The brief has to come back in the format this step reads. Replace the built-in instruction only with one that still asks for it; a brief that does not
            parse fails the step.
          </p>
        </div>
      </StepAdvanced>
    </div>
  )
}

// --- Decision ---

interface DecisionOption {
  id: string
  description?: string
  abstain?: boolean
}

interface DecisionQuestion {
  id?: string
  type?: 'choice' | 'score' | 'boolean'
  prompt?: string
  options?: DecisionOption[]
  optionsOrderPolicy?: 'asis' | 'permute2' | 'prior_debias'
}

// Only what the step runs. A saved graph can carry a `boolean` question or
// a debiasing order policy the step refuses at run time; neither is offered
// as a choice, and a step that carries one says so and offers the fix.
const DECISION_TYPES = [
  { value: 'choice', label: 'Pick one answer' },
  { value: 'score', label: 'Pick one level, in order' },
] as const

function DecisionConfig({ node, updateData, onUpdateNode }: { node: Node; updateData: UpdateDataFn; onUpdateNode: (nodeId: string, data: NodeData) => void }) {
  const question = ((node.data.question as DecisionQuestion) || {}) as DecisionQuestion
  const options: DecisionOption[] = Array.isArray(question.options) ? question.options : []
  const thresholds = (node.data.thresholds as Record<string, number>) || {}
  const type = question.type || 'choice'
  const isBoolean = type === 'boolean'
  const abstainCount = options.filter((o) => o?.abstain === true).length
  const orderPolicy = question.optionsOrderPolicy || 'asis'
  const unservedOrderPolicy = orderPolicy !== 'asis'

  const patchQuestion = (patch: Partial<DecisionQuestion>) => {
    updateData('question', { ...question, ...patch })
  }
  const patchOption = (index: number, patch: Partial<DecisionOption>) => {
    patchQuestion({ options: options.map((o, i) => (i === index ? { ...o, ...patch } : o)) })
  }
  const addOption = () => {
    patchQuestion({ options: [...options, { id: '' }] })
  }
  const removeOption = (index: number) => {
    patchQuestion({ options: options.filter((_, i) => i !== index) })
  }
  // Exactly one abstain option, enforced here rather than left to the
  // backend to refuse: marking a second one silently unmarks the first.
  const markAbstain = (index: number) => {
    patchQuestion({ options: options.map((o, i) => ({ ...o, abstain: i === index ? true : undefined })) })
  }
  const setThreshold = (optionId: string, raw: string) => {
    const next = { ...thresholds }
    if (raw === '') delete next[optionId]
    else next[optionId] = Number(raw)
    updateData('thresholds', Object.keys(next).length > 0 ? next : undefined)
  }

  return (
    <div className="space-y-3">
      {/* The decide call takes its model like a model call does:
          role, pinned provider, routing policy, then the org default. */}
      <NodeModelField node={node} idPrefix="decision" onUpdateNode={onUpdateNode} />

      <div>
        <Label htmlFor="decision-prompt">Question</Label>
        <Textarea
          id="decision-prompt"
          className="mt-1 text-xs"
          rows={3}
          value={question.prompt || ''}
          onChange={(e) => patchQuestion({ prompt: e.target.value })}
          placeholder="Does this ticket describe a billing problem?"
        />
        <p className="text-xs text-muted-foreground mt-1">Asked about what is wired into this step, and answered with one of the answers below.</p>
      </div>

      {isBoolean && (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="decision-boolean">
          This step cannot run a yes-or-no question: it has no answer for &ldquo;cannot tell&rdquo;. Under Advanced, make it pick one answer, with yes, no and a
          &ldquo;cannot tell&rdquo; answer.
        </p>
      )}

      <div>
        <div className="flex items-center justify-between">
          <Label>Answers</Label>
          <span className="text-xs text-muted-foreground">{options.length}</span>
        </div>

        {abstainCount === 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            Mark one answer as &ldquo;cannot tell&rdquo;. Without it the step cannot say the state does not answer the question, and hands on its best wrong
            guess instead.
          </p>
        )}

        <div className="mt-2 space-y-2">
          {options.map((option, i) => (
            <div key={i} className="rounded-lg border p-2 space-y-2 bg-background">
              <div className="flex items-center gap-1">
                <Input className="text-xs font-mono" aria-label={`Answer ${i + 1}`} placeholder="answer" value={option.id || ''} onChange={(e) => patchOption(i, { id: e.target.value })} />
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`Remove answer ${i + 1}`} onClick={() => removeOption(i)}>
                  <X className="h-3 w-3" />
                </Button>
              </div>

              <Input
                className="text-xs"
                aria-label={`Answer ${i + 1} meaning`}
                placeholder="what this answer means (optional)"
                value={option.description || ''}
                onChange={(e) => patchOption(i, { description: e.target.value || undefined })}
              />

              <div className="flex items-center gap-2">
                <Switch
                  id={`decision-abstain-${i}`}
                  aria-label={`Answer ${i + 1} means cannot tell`}
                  checked={option.abstain === true}
                  onCheckedChange={(checked) => (checked ? markAbstain(i) : patchOption(i, { abstain: undefined }))}
                />
                <Label htmlFor={`decision-abstain-${i}`} className="text-xs font-normal">
                  Cannot tell
                </Label>
              </div>
            </div>
          ))}

          <Button variant="outline" size="sm" className="w-full" onClick={addOption}>
            Add answer
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        The step leaves by the edge of the winning answer. An answer below its bar leaves by the &ldquo;cannot tell&rdquo; edge instead, so a weak guess is never
        handed on as a decision.
      </p>

      <StepAdvanced node={node}>
        <div>
          <Label htmlFor="decision-type">Kind of question</Label>
          <Select value={isBoolean ? '' : type} onValueChange={(v) => patchQuestion({ type: v as DecisionQuestion['type'] })}>
            <SelectTrigger id="decision-type" className="mt-1">
              <SelectValue placeholder="Pick a kind" />
            </SelectTrigger>
            <SelectContent>
              {DECISION_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {options.some((o) => o.abstain !== true) && (
          <div className="space-y-2">
            <p className="text-sm font-medium">How sure it must be</p>
            <p className="text-xs text-muted-foreground">From 0 to 1, per answer. Below it, the step leaves by &ldquo;cannot tell&rdquo;. Empty: no bar.</p>
            {options.map((option, i) =>
              option.abstain === true ? null : (
                <div key={i} className="flex items-center justify-between gap-2">
                  <Label htmlFor={`decision-threshold-${i}`} className="text-xs font-normal font-mono">
                    {option.id || `Answer ${i + 1}`}
                  </Label>
                  <Input
                    id={`decision-threshold-${i}`}
                    className="text-xs w-20"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    aria-label={`Answer ${i + 1} bar`}
                    value={typeof thresholds[option.id] === 'number' ? String(thresholds[option.id]) : ''}
                    onChange={(e) => setThreshold(option.id, e.target.value)}
                  />
                </div>
              ),
            )}
          </div>
        )}

        <div>
          <Label htmlFor="decision-question-id">Answers come back under</Label>
          <Input id="decision-question-id" className="mt-1 font-mono text-xs" value={question.id || ''} onChange={(e) => patchQuestion({ id: e.target.value })} placeholder="decision" />
        </div>

        {unservedOrderPolicy && (
          <div className="space-y-2" data-testid="decision-order-policy">
            <p className="text-xs text-amber-600 dark:text-amber-400">
              This step is set to reorder its answers ({orderPolicy}), which it does not do yet, so it would refuse to run. It asks them in the order written.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => patchQuestion({ optionsOrderPolicy: 'asis' })}>
              Use the written order
            </Button>
          </div>
        )}
      </StepAdvanced>
    </div>
  )
}
