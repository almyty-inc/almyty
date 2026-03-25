import React, { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Node } from '@xyflow/react'
import { X, Trash2, ChevronDown, ChevronUp, Code } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { JsonSchemaBuilder } from '@/components/JsonSchemaBuilder'

import { llmProvidersApi, toolsApi, agentsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { NODE_TYPE_CONFIG, type PipelineNodeType } from './nodes'
import type { LlmProvider, Tool, Agent } from '@/types'

// ─── Shared types ────────────────────────────────────────────────────────────

type NodeData = Record<string, unknown>

type UpdateDataFn = (key: string, value: unknown) => void

interface NodeConfigPanelProps {
  node: Node | null
  nodes: Node[]
  onUpdateNode: (nodeId: string, data: NodeData) => void
  onDeleteNode: (nodeId: string) => void
  onClose: () => void
}

interface ParameterMapping {
  key: string
  value: string
}

// ─── Main Panel ──────────────────────────────────────────────────────────────

export function NodeConfigPanel({ node, nodes, onUpdateNode, onDeleteNode, onClose }: NodeConfigPanelProps) {
  if (!node) return null

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
    <div className="w-full lg:w-[320px] border-l bg-muted/30 flex flex-col overflow-hidden h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${config?.color || 'bg-zinc-500'}`} />
          <span className="text-sm font-semibold">{config?.label || nodeType}</span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Node ID (read-only) */}
        <div>
          <Label className="text-xs text-muted-foreground">Node ID</Label>
          <div className="text-xs font-mono mt-0.5">{node.id}</div>
        </div>

        {/* Type-specific configs */}
        {nodeType === 'input' && <InputConfig node={node} updateData={updateData} />}
        {nodeType === 'output' && <OutputConfig node={node} nodes={nodes} updateData={updateData} />}
        {nodeType === 'llm_call' && <LlmCallConfig node={node} updateData={updateData} onUpdateNode={onUpdateNode} />}
        {nodeType === 'tool_call' && <ToolCallConfig node={node} updateData={updateData} onUpdateNode={onUpdateNode} />}
        {nodeType === 'condition' && <ConditionConfig node={node} nodes={nodes} updateData={updateData} />}
        {nodeType === 'transform' && <TransformConfig node={node} updateData={updateData} />}
        {nodeType === 'merge' && <MergeConfig node={node} updateData={updateData} />}
        {nodeType === 'parallel' && <ParallelConfig />}
        {nodeType === 'sub_agent' && <SubAgentConfig node={node} updateData={updateData} />}
      </div>

      {/* Footer: delete */}
      <div className="px-4 py-3 border-t shrink-0">
        <Button
          variant="destructive"
          size="sm"
          className="w-full"
          onClick={() => onDeleteNode(node.id)}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          Delete Node
        </Button>
      </div>
    </div>
  )
}

// --- Input Node Config ---
function InputConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  return (
    <div className="space-y-3">
      <div>
        <Label>Input Schema</Label>
        <div className="mt-1">
          <JsonSchemaBuilder
            value={(node.data.schema as Record<string, unknown>) || { type: 'object', properties: {} }}
            onChange={(schema) => updateData('schema', schema)}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Define the JSON Schema for pipeline input.
        </p>
      </div>
    </div>
  )
}

// --- Output Node Config ---
function OutputConfig({ node, nodes, updateData }: { node: Node; nodes: Node[]; updateData: UpdateDataFn }) {
  const availableNodes = nodes.filter(n => n.id !== node.id && n.type !== 'input' && n.type !== 'output')

  return (
    <div className="space-y-3">
      <div>
        <Label>Output Source</Label>
        <Select
          value={(node.data.mapping as string) || ''}
          onValueChange={(v) => updateData('mapping', v)}
        >
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="Select output source" />
          </SelectTrigger>
          <SelectContent>
            {availableNodes.map(n => (
              <SelectItem key={n.id} value={`{{nodes.${n.id}.output}}`}>
                {NODE_TYPE_CONFIG[n.type as PipelineNodeType]?.label || n.type}: {n.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          Select which node's output becomes the pipeline result.
        </p>
      </div>

      <div>
        <Label htmlFor="output-mapping-custom">Custom Mapping</Label>
        <Textarea
          id="output-mapping-custom"
          className="mt-1 font-mono text-xs"
          rows={3}
          value={(node.data.mapping as string) || ''}
          onChange={(e) => updateData('mapping', e.target.value)}
          placeholder="{{nodes.llm_1.output}}"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Or write a custom template using {'{{nodes.<id>.output}}'} syntax.
        </p>
      </div>
    </div>
  )
}

// --- Extract {{...}} variables from a template string ---
function extractTemplateVariables(text: string): string[] {
  const matches = text.match(/\{\{([^}]+)\}\}/g)
  if (!matches) return []
  return [...new Set(matches.map(m => m.replace(/^\{\{|\}\}$/g, '').trim()))]
}

// --- LLM Call Config ---
function LlmCallConfig({ node, updateData, onUpdateNode }: { node: Node; updateData: UpdateDataFn; onUpdateNode: (nodeId: string, data: NodeData) => void }) {
  const { currentOrganization } = useOrganizationStore()
  const [toolSearch, setToolSearch] = useState('')
  const [showAllTools, setShowAllTools] = useState(false)
  const [useCustomModel, setUseCustomModel] = useState(false)
  const VISIBLE_TOOLS_LIMIT = 8

  const { data: providers } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const res = await llmProvidersApi.getAll()
      const d = res.data
      return Array.isArray(d) ? d : d?.providers || []
    },
  })

  const { data: tools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const res = await toolsApi.getAll(currentOrganization?.id)
      const d = res.data
      return Array.isArray(d) ? d : d?.tools || []
    },
    enabled: !!currentOrganization,
  })

  const temperature = typeof node.data.temperature === 'number' ? node.data.temperature : 0.7

  // Get the selected provider to determine type for model suggestions
  const providerList = (providers || []) as Array<Pick<LlmProvider, 'id' | 'name' | 'type'>>
  const selectedProvider = useMemo(() => {
    if (!providerList.length || !node.data.providerId) return null
    return providerList.find((p) => p.id === node.data.providerId) || null
  }, [providerList, node.data.providerId])

  // Fetch models dynamically from the provider API
  const { data: dynamicModels } = useQuery({
    queryKey: ['provider-models', node.data.providerId],
    queryFn: async () => {
      const res = await llmProvidersApi.getModels(node.data.providerId as string)
      const models = res.data || []
      return Array.isArray(models) ? models.map((m: Record<string, string>) => m.id || m.name || String(m)) : []
    },
    enabled: !!node.data.providerId,
  })

  const modelSuggestions: string[] = dynamicModels || []

  // Filter tools by search
  const toolList = (tools || []) as Array<Pick<Tool, 'id' | 'name'>>
  const filteredTools = useMemo(() => {
    if (!toolSearch.trim()) return toolList
    const q = toolSearch.toLowerCase()
    return toolList.filter((t) => t.name?.toLowerCase().includes(q))
  }, [toolList, toolSearch])

  const visibleTools = showAllTools ? filteredTools : filteredTools.slice(0, VISIBLE_TOOLS_LIMIT)
  const hasMoreTools = filteredTools.length > VISIBLE_TOOLS_LIMIT

  // Extract template variables from prompts
  const systemPromptVars = extractTemplateVariables((node.data.systemPrompt as string) || '')
  const userPromptVars = extractTemplateVariables((node.data.userPromptTemplate as string) || '')

  return (
    <div className="space-y-3">
      <div>
        <Label>LLM Provider</Label>
        <Select
          value={(node.data.providerId as string) || ''}
          onValueChange={(v) => {
            const provider = providerList.find((p) => p.id === v)
            // Batch all updates in one call to avoid stale data overwrites
            onUpdateNode(node.id, {
              ...node.data,
              providerId: v,
              providerName: provider?.name || '',
              providerType: provider?.type || '',
              model: '',
            })
            setUseCustomModel(false)
          }}
        >
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {providerList.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} <span className="text-muted-foreground ml-1">({p.type})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label htmlFor="model">Model</Label>
          {modelSuggestions.length > 0 && (
            <button
              type="button"
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setUseCustomModel(!useCustomModel)}
            >
              {useCustomModel ? 'Use suggested' : 'Custom model'}
            </button>
          )}
        </div>
        {modelSuggestions.length > 0 && !useCustomModel ? (
          <Select
            value={(node.data.model as string) || ''}
            onValueChange={(v) => updateData('model', v)}
          >
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              {modelSuggestions.map((model) => (
                <SelectItem key={model} value={model}>{model}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <>
            <Input
              id="model"
              className="mt-1"
              value={(node.data.model as string) || ''}
              onChange={(e) => updateData('model', e.target.value)}
              placeholder="Enter model name"
            />
            {modelSuggestions.length === 0 && node.data.providerId && (
              <p className="text-[11px] text-muted-foreground mt-1">No models returned from provider. Type the model name manually.</p>
            )}
          </>
        )}
      </div>

      <div>
        <Label htmlFor="system-prompt">System Prompt</Label>
        <Textarea
          id="system-prompt"
          className="mt-1 font-mono text-xs"
          rows={4}
          value={(node.data.systemPrompt as string) || ''}
          onChange={(e) => updateData('systemPrompt', e.target.value)}
          placeholder="You are a helpful assistant..."
        />
        {systemPromptVars.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            <span className="text-[10px] text-muted-foreground">Variables:</span>
            {systemPromptVars.map(v => (
              <code key={v} className="text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1 rounded">{v}</code>
            ))}
          </div>
        )}
      </div>

      <div>
        <Label htmlFor="user-prompt">User Prompt Template</Label>
        <Textarea
          id="user-prompt"
          className="mt-1 font-mono text-xs"
          rows={3}
          value={(node.data.userPromptTemplate as string) || ''}
          onChange={(e) => updateData('userPromptTemplate', e.target.value)}
          placeholder="{{input.message}}"
        />
        {userPromptVars.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            <span className="text-[10px] text-muted-foreground">Variables:</span>
            {userPromptVars.map(v => (
              <code key={v} className="text-[10px] bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-1 rounded">{v}</code>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          Use {'{{input.*}}'} or {'{{nodes.<id>.output}}'} for dynamic values.
        </p>
      </div>

      <div>
        <Label>Temperature: {temperature.toFixed(2)}</Label>
        <Slider
          className="mt-2"
          value={[temperature]}
          min={0}
          max={2}
          step={0.01}
          onValueChange={([v]) => updateData('temperature', v)}
        />
      </div>

      <div>
        <Label htmlFor="max-tokens">Max Tokens</Label>
        <Input
          id="max-tokens"
          type="number"
          className="mt-1"
          value={(node.data.maxTokens as number) || ''}
          onChange={(e) => updateData('maxTokens', e.target.value ? parseInt(e.target.value) : undefined)}
          placeholder="4096"
        />
      </div>

      <div>
        <Label>Tools (available for function calling)</Label>
        <Input
          placeholder="Search tools..."
          value={toolSearch}
          onChange={(e) => {
            setToolSearch(e.target.value)
            setShowAllTools(false)
          }}
          className="mt-1 mb-1 text-xs"
        />
        <div className="space-y-1 max-h-[200px] overflow-y-auto border rounded-md p-2">
          {filteredTools.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {toolList.length === 0 ? 'No tools available' : 'No tools match your search'}
            </p>
          ) : (
            <>
              {visibleTools.map((tool) => {
                const selectedTools: string[] = (node.data.toolIds as string[]) || []
                const isSelected = selectedTools.includes(tool.id)
                return (
                  <label key={tool.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent/50 rounded px-1 py-0.5">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) => {
                        const newSelected = e.target.checked
                          ? [...selectedTools, tool.id]
                          : selectedTools.filter((id) => id !== tool.id)
                        updateData('toolIds', newSelected)
                      }}
                      className="rounded"
                    />
                    <span className="truncate">{tool.name}</span>
                  </label>
                )
              })}
              {hasMoreTools && !showAllTools && (
                <button
                  type="button"
                  className="w-full text-xs text-center text-muted-foreground hover:text-foreground py-1 transition-colors"
                  onClick={() => setShowAllTools(true)}
                >
                  <ChevronDown className="h-3 w-3 inline mr-1" />
                  Show all {filteredTools.length} tools
                </button>
              )}
              {hasMoreTools && showAllTools && (
                <button
                  type="button"
                  className="w-full text-xs text-center text-muted-foreground hover:text-foreground py-1 transition-colors"
                  onClick={() => setShowAllTools(false)}
                >
                  <ChevronUp className="h-3 w-3 inline mr-1" />
                  Show fewer
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// --- Tool Call Config ---
function ToolCallConfig({ node, updateData, onUpdateNode }: { node: Node; updateData: UpdateDataFn; onUpdateNode: (nodeId: string, data: NodeData) => void }) {
  const { currentOrganization } = useOrganizationStore()

  const { data: tools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const res = await toolsApi.getAll(currentOrganization?.id)
      const d = res.data
      return Array.isArray(d) ? d : d?.tools || []
    },
    enabled: !!currentOrganization,
  })

  const toolList = (tools || []) as Array<Pick<Tool, 'id' | 'name'>>
  const params: ParameterMapping[] = (node.data.parameterMapping as ParameterMapping[]) || []

  const addParam = () => {
    updateData('parameterMapping', [...params, { key: '', value: '' }])
  }

  const updateParam = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...params]
    updated[index] = { ...updated[index], [field]: val }
    updateData('parameterMapping', updated)
  }

  const removeParam = (index: number) => {
    updateData('parameterMapping', params.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-3">
      <div>
        <Label>Tool</Label>
        <Select
          value={(node.data.toolId as string) || ''}
          onValueChange={(v) => {
            const tool = toolList.find((t) => t.id === v)
            onUpdateNode(node.id, {
              ...node.data,
              toolId: v,
              toolName: tool?.name || '',
            })
          }}
        >
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="Select tool" />
          </SelectTrigger>
          <SelectContent>
            {toolList.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>Parameter Mapping</Label>
        <div className="mt-1 space-y-2">
          {params.map((p, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                className="text-xs"
                placeholder="key"
                value={p.key}
                onChange={(e) => updateParam(i, 'key', e.target.value)}
              />
              <Input
                className="text-xs font-mono"
                placeholder="{{input.value}}"
                value={p.value}
                onChange={(e) => updateParam(i, 'value', e.target.value)}
              />
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeParam(i)}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="w-full" onClick={addParam}>
            Add Parameter
          </Button>
        </div>
      </div>
    </div>
  )
}

// --- Condition operators ---
const CONDITION_OPERATORS = [
  { value: '===', label: 'equals' },
  { value: '!==', label: 'not equals' },
  { value: '>', label: 'greater than' },
  { value: '<', label: 'less than' },
  { value: '>=', label: 'greater or equal' },
  { value: '<=', label: 'less or equal' },
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

// --- Condition Config ---
function ConditionConfig({ node, nodes, updateData }: { node: Node; nodes: Node[]; updateData: UpdateDataFn }) {
  const [useRawMode, setUseRawMode] = useState(false)
  const expression = (node.data.expression as string) || ''

  const availableOutputs = nodes.filter(n => n.id !== node.id && n.type !== 'output')

  // Try to parse existing expression
  const parsed = useMemo(() => parseConditionExpression(expression), [expression])

  const [condSource, setCondSource] = useState(parsed?.source || '')
  const [condOperator, setCondOperator] = useState(parsed?.operator || '===')
  const [condValue, setCondValue] = useState(parsed?.value || '')

  const updateCondition = (source: string, operator: string, value: string) => {
    setCondSource(source)
    setCondOperator(operator)
    setCondValue(value)
    const expr = buildConditionExpression(source, operator, value)
    updateData('expression', expr)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Condition</Label>
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          onClick={() => setUseRawMode(!useRawMode)}
        >
          <Code className="h-3 w-3" />
          {useRawMode ? 'Visual builder' : 'Raw expression'}
        </button>
      </div>

      {useRawMode ? (
        <div>
          <Textarea
            className="mt-1 font-mono text-xs"
            rows={4}
            value={expression}
            onChange={(e) => updateData('expression', e.target.value)}
            placeholder="{{nodes.llm_1.output.sentiment}} === 'positive'"
          />
          <p className="text-xs text-muted-foreground mt-1">
            JavaScript expression that evaluates to true/false.
          </p>
        </div>
      ) : (
        <div className="space-y-2 border rounded-lg p-3 bg-muted/30">
          <div>
            <Label className="text-xs">If</Label>
            <Select
              value={condSource}
              onValueChange={(v) => updateCondition(v, condOperator, condValue)}
            >
              <SelectTrigger className="mt-1 text-xs font-mono">
                <SelectValue placeholder="Select source" />
              </SelectTrigger>
              <SelectContent>
                {availableOutputs.map(n => {
                  const nodeLabel = NODE_TYPE_CONFIG[n.type as PipelineNodeType]?.label || n.type
                  const val = n.type === 'input' ? `{{input}}` : `{{nodes.${n.id}.output}}`
                  return (
                    <SelectItem key={n.id} value={val} className="text-xs font-mono">
                      {nodeLabel}: {n.id}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">Operator</Label>
            <Select
              value={condOperator}
              onValueChange={(v) => updateCondition(condSource, v, condValue)}
            >
              <SelectTrigger className="mt-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITION_OPERATORS.map(op => (
                  <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">Value</Label>
            <Input
              className="mt-1 text-xs"
              value={condValue}
              onChange={(e) => updateCondition(condSource, condOperator, e.target.value)}
              placeholder="Value to compare"
            />
          </div>

          {expression && (
            <div className="pt-1 border-t">
              <span className="text-[10px] text-muted-foreground">Expression:</span>
              <code className="block text-[10px] font-mono bg-background rounded px-2 py-1 mt-0.5 break-all">
                {expression}
              </code>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        The "True" handle connects to the right path, "False" connects below.
      </p>
    </div>
  )
}

// --- Transform Config ---
function TransformConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="transform-expr">Transform Expression</Label>
        <Textarea
          id="transform-expr"
          className="mt-1 font-mono text-xs"
          rows={6}
          value={(node.data.expression as string) || ''}
          onChange={(e) => updateData('expression', e.target.value)}
          placeholder={'{\n  "summary": "{{nodes.llm_1.output}}",\n  "timestamp": "{{Date.now()}}"\n}'}
        />
        <p className="text-xs text-muted-foreground mt-1">
          JavaScript/template expression to transform input data. Result becomes this node's output.
        </p>
      </div>
    </div>
  )
}

// --- Merge Config ---
function MergeConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  return (
    <div className="space-y-3">
      <div>
        <Label>Merge Strategy</Label>
        <Select
          value={(node.data.strategy as string) || 'first_response'}
          onValueChange={(v) => updateData('strategy', v)}
        >
          <SelectTrigger className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="first_response">First Response</SelectItem>
            <SelectItem value="best_of_n">Best of N</SelectItem>
            <SelectItem value="concatenate">Concatenate</SelectItem>
            <SelectItem value="consensus">Consensus</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {node.data.strategy === 'best_of_n' && (
        <div>
          <Label htmlFor="judge-prompt">Judge Prompt</Label>
          <Textarea
            id="judge-prompt"
            className="mt-1 text-xs"
            rows={4}
            value={(node.data.judgePrompt as string) || ''}
            onChange={(e) => updateData('judgePrompt', e.target.value)}
            placeholder="Pick the best response considering quality and accuracy..."
          />
        </div>
      )}

      {node.data.strategy === 'consensus' && (
        <div>
          <Label htmlFor="consensus-threshold">Consensus Threshold</Label>
          <Input
            id="consensus-threshold"
            type="number"
            className="mt-1"
            min={0}
            max={1}
            step={0.1}
            value={(node.data.consensusThreshold as number) || 0.5}
            onChange={(e) => updateData('consensusThreshold', parseFloat(e.target.value))}
          />
        </div>
      )}
    </div>
  )
}

// --- Parallel Config ---
function ParallelConfig() {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The Parallel node fans out execution to all connected branches. Each branch runs simultaneously. Connect branches to a Merge node to collect results.
      </p>
      <div className="rounded-lg border p-3 bg-orange-50 dark:bg-orange-950/30">
        <p className="text-xs text-orange-700 dark:text-orange-300">
          No additional configuration needed. Connect output handles to different pipeline branches.
        </p>
      </div>
    </div>
  )
}

// --- Sub-Agent Config ---
function SubAgentConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  const { data: agents } = useQuery({
    queryKey: ['agents-for-subagent'],
    queryFn: async () => {
      const res = await agentsApi.getAll()
      const d = res.data
      const result = d?.agents || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
  })

  const agentList = (agents || []) as Array<Pick<Agent, 'id' | 'name'>>
  const mappings: ParameterMapping[] = (node.data.inputMapping as ParameterMapping[]) || []

  const addMapping = () => {
    updateData('inputMapping', [...mappings, { key: '', value: '' }])
  }

  const updateMapping = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...mappings]
    updated[index] = { ...updated[index], [field]: val }
    updateData('inputMapping', updated)
  }

  const removeMapping = (index: number) => {
    updateData('inputMapping', mappings.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-3">
      <div>
        <Label>Agent</Label>
        <Select
          value={(node.data.agentId as string) || ''}
          onValueChange={(v) => {
            const agent = agentList.find((a) => a.id === v)
            updateData('agentId', v)
            if (agent) {
              updateData('agentName', agent.name)
            }
          }}
        >
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="Select agent" />
          </SelectTrigger>
          <SelectContent>
            {agentList.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>Input Mapping</Label>
        <div className="mt-1 space-y-2">
          {mappings.map((m, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                className="text-xs"
                placeholder="key"
                value={m.key}
                onChange={(e) => updateMapping(i, 'key', e.target.value)}
              />
              <Input
                className="text-xs font-mono"
                placeholder="{{input.value}}"
                value={m.value}
                onChange={(e) => updateMapping(i, 'value', e.target.value)}
              />
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeMapping(i)}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="w-full" onClick={addMapping}>
            Add Mapping
          </Button>
        </div>
      </div>
    </div>
  )
}
