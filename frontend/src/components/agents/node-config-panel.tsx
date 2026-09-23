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
import { CodeEditor } from '@/components/ui/code-editor'
import { JsonSchemaBuilder } from '@/components/JsonSchemaBuilder'

import { llmProvidersApi, toolsApi, agentsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { NODE_TYPE_CONFIG, type PipelineNodeType } from './nodes'
import { RoutingPolicyField } from '@/components/models/routing-policy-editor'
import type { LlmProvider, Tool, Agent } from '@/types'
import type { RoutingPolicy } from '@/types/models'

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
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close node configuration" onClick={onClose}>
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
        {/* Keyed by node id: the panel is not remounted when you click a
            different node, so without this the custom-model mode picked on
            one node would carry over to the next one. */}
        {nodeType === 'llm_call' && <LlmCallConfig key={node.id} node={node} updateData={updateData} onUpdateNode={onUpdateNode} />}
        {nodeType === 'tool_call' && <ToolCallConfig node={node} updateData={updateData} onUpdateNode={onUpdateNode} />}
        {/* Keyed by node id for the same reason as the Model Call editor:
            the visual builder holds source/operator/value in state seeded
            from the node it first rendered for, and clicking a second
            condition node would otherwise rebuild that node's expression
            around the previous node's source. */}
        {nodeType === 'condition' && <ConditionConfig key={node.id} node={node} nodes={nodes} updateData={updateData} />}
        {nodeType === 'transform' && <TransformConfig node={node} updateData={updateData} />}
        {nodeType === 'merge' && <MergeConfig node={node} updateData={updateData} />}
        {nodeType === 'parallel' && <ParallelConfig />}
        {nodeType === 'sub_agent' && <SubAgentConfig node={node} updateData={updateData} onUpdateNode={onUpdateNode} />}
        {nodeType === 'loop' && <LoopConfig node={node} updateData={updateData} />}
        {nodeType === 'verify' && <VerifyConfig node={node} updateData={updateData} />}
        {nodeType === 'extract_context' && <ExtractContextConfig node={node} updateData={updateData} />}
        {nodeType === 'decision' && <DecisionConfig key={node.id} node={node} updateData={updateData} />}
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
  const mapping = (node.data.mapping as string) || ''
  // The picker and the box below edit one field, not two. Binding the
  // picker's value to that same field is what makes it visible: choose a
  // node and the box fills in, write a template of your own and the picker
  // falls back to its placeholder instead of showing a stale choice that
  // overwrites what you typed the next time you open it.
  const pickedNode = availableNodes.some(n => `{{nodes.${n.id}.output}}` === mapping)

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="node-output-source">Output Template</Label>
        <Select
          value={pickedNode ? mapping : ''}
          onValueChange={(v) => updateData('mapping', v)}
        >
          <SelectTrigger id="node-output-source" className="mt-1">
            <SelectValue placeholder="Pick an upstream node" />
          </SelectTrigger>
          <SelectContent>
            {/*
              Same dead end as the provider select above: delete the middle
              node and there is nothing left to map an output from, so the
              select opened on a 4px sliver that explained nothing.
            */}
            {availableNodes.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No upstream nodes yet — add a node between Input and Output.
              </div>
            )}
            {availableNodes.map(n => (
              <SelectItem key={n.id} value={`{{nodes.${n.id}.output}}`}>
                {NODE_TYPE_CONFIG[n.type as PipelineNodeType]?.label || n.type}: {n.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          A shortcut: picking a node writes its output reference into the template below.
        </p>
      </div>

      <div>
        <Label htmlFor="output-mapping-custom">Template</Label>
        <Textarea
          id="output-mapping-custom"
          className="mt-1 font-mono text-xs"
          rows={3}
          value={mapping}
          onChange={(e) => updateData('mapping', e.target.value)}
          placeholder="{{nodes.llm_1.output}}"
        />
        <p className="text-xs text-muted-foreground mt-1">
          The pipeline result, written with {'{{nodes.<id>.output}}'} syntax. It is
          rendered as text, so a node whose output is an object or an array arrives here
          as JSON text.
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
  // `null` means "the user has not picked a mode on this panel yet", so the
  // mode is derived from the saved value below instead of defaulting to the
  // suggestion list. Plain `useState(false)` made a saved custom model open
  // on a Select that could not represent it.
  const [customModelOverride, setCustomModelOverride] = useState<boolean | null>(null)
  const VISIBLE_TOOLS_LIMIT = 8

  const { data: providers } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const res = await llmProvidersApi.getAll()
      return Array.isArray(res) ? res : res?.providers || []
    },
  })

  const { data: tools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const res = await toolsApi.getAll(currentOrganization?.id)
      return Array.isArray(res) ? res : res?.tools || []
    },
    enabled: !!currentOrganization,
  })

  const temperature = typeof node.data.temperature === 'number' ? node.data.temperature : 0.7
  const routed = !!node.data.routing && typeof node.data.routing === 'object'

  // Get the selected provider to determine type for model suggestions
  const providerList = (Array.isArray(providers) ? providers : (providers as any)?.providers || []) as Array<Pick<LlmProvider, 'id' | 'name' | 'type'>>
  const selectedProvider = useMemo(() => {
    if (!providerList.length || !node.data.providerId) return null
    return providerList.find((p) => p.id === node.data.providerId) || null
  }, [providerList, node.data.providerId])

  // Fetch models dynamically from the provider API
  const { data: dynamicModels } = useQuery({
    queryKey: ['provider-models', node.data.providerId],
    queryFn: async () => {
      // llmProvidersApi.getModels goes through apiGet → extractData,
      // so res is already the flat array of model objects.
      const res = await llmProvidersApi.getModels(node.data.providerId as string)
      const models = Array.isArray(res) ? res : []
      return models.map((m: Record<string, string>) => m.id || m.name || String(m))
    },
    enabled: !!node.data.providerId,
  })

  const modelSuggestions: string[] = dynamicModels || []

  const savedModel = (node.data.model as string) || ''
  // Radix renders the placeholder whenever `value` matches no SelectItem, and
  // it does so silently: a node holding a dated snapshot id, a fine-tune or a
  // retired model -- none of which the provider's list endpoint returns --
  // read as "Select model" while still executing the saved value. Two guards,
  // because either alone leaves a hole: default this node to the free-text
  // input when the saved model is not in the list, and keep the saved value in
  // the list so the Select can never drop it even if the user switches back.
  const savedModelIsCustom =
    !!savedModel && modelSuggestions.length > 0 && !modelSuggestions.includes(savedModel)
  const useCustomModel = customModelOverride ?? savedModelIsCustom
  const modelOptions = savedModel && !modelSuggestions.includes(savedModel)
    ? [savedModel, ...modelSuggestions]
    : modelSuggestions

  // Filter tools by search
  const toolList = (Array.isArray(tools) ? tools : (tools as any)?.tools || []) as Array<Pick<Tool, 'id' | 'name'>>
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
      {/* Model selection: a pinned provider + model, or a routing policy the
          catalog resolves at run time. The two are exclusive on the node:
          routing replaces providerId, switching back removes routing. */}
      <div>
        <Label>Model selection</Label>
        <div className="mt-1 grid grid-cols-2 gap-1 rounded-md bg-muted p-1" role="radiogroup" aria-label="Model selection">
          <button
            type="button"
            role="radio"
            aria-checked={!routed}
            className={`rounded px-2 py-1 text-xs transition-colors ${!routed ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => {
              if (!routed) return
              const { routing: _routing, ...rest } = node.data
              onUpdateNode(node.id, rest)
            }}
          >
            Pinned provider
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={routed}
            className={`rounded px-2 py-1 text-xs transition-colors ${routed ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => {
              if (routed) return
              const { providerId: _providerId, providerName: _providerName, providerType: _providerType, model: _model, ...rest } = node.data
              onUpdateNode(node.id, { ...rest, routing: { objective: 'cheapest' } })
              setCustomModelOverride(null)
            }}
          >
            Routed by policy
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">
          {routed
            ? 'The router picks a validated card from the catalog on every call and records which one answered.'
            : 'Always this provider and model.'}
        </p>
      </div>

      {routed ? (
        <RoutingPolicyField
          value={(node.data.routing as RoutingPolicy) || {}}
          onChange={(policy) => updateData('routing', policy)}
        />
      ) : (
        <>
      <div>
        <Label htmlFor="node-provider">Provider</Label>
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
            setCustomModelOverride(null)
          }}
        >
          <SelectTrigger id="node-provider" className="mt-1">
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {/*
              A required field whose select opens on nothing is a dead
              end: the node fails validation, Save is blocked, and the
              screen never says why.
            */}
            {providerList.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No model providers connected yet — add one under Models.
              </div>
            )}
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
              onClick={() => setCustomModelOverride(!useCustomModel)}
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
              {modelOptions.map((model) => (
                <SelectItem key={model} value={model}>
                  {model}
                  {model === savedModel && savedModelIsCustom && (
                    <span className="text-muted-foreground ml-1">(saved)</span>
                  )}
                </SelectItem>
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
        </>
      )}

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
        {(() => {
          const selectedTools: string[] = (node.data.toolIds as string[]) || []
          const allIds = toolList.map((t: any) => t.id)

          // Group tools by source
          const grouped: Record<string, typeof toolList> = {}
          toolList.forEach((t: any) => {
            const source = t.metadata?.sourceApi?.name || t.metadata?.apiName || (t.type === 'api' ? 'API Tools' : 'Custom Tools')
            if (!grouped[source]) grouped[source] = []
            grouped[source].push(t)
          })
          const groups = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))

          return (
            <>
              <div className="flex items-center justify-between">
                <Label>Tools for function calling</Label>
                <span className="text-xs text-muted-foreground">{selectedTools.length} of {toolList.length}</span>
              </div>

              {toolList.length === 0 ? (
                <p className="text-xs text-muted-foreground mt-1">No tools available. Create tools first.</p>
              ) : (
                <>
                  <div className="flex gap-1 mt-1 mb-2">
                    <button type="button" className="text-[10px] px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                      onClick={() => updateData('toolIds', allIds)}>All</button>
                    <button type="button" className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => updateData('toolIds', [])}>None</button>
                    {groups.map(([source, tools]) => (
                      <button key={source} type="button" className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground transition-colors truncate max-w-[80px]"
                        onClick={() => {
                          const groupIds = (tools as any[]).map(t => t.id)
                          const otherIds = selectedTools.filter(id => !groupIds.includes(id))
                          const allGroupSelected = groupIds.every(id => selectedTools.includes(id))
                          updateData('toolIds', allGroupSelected ? otherIds : [...otherIds, ...groupIds])
                        }}
                        title={source}
                      >{source}</button>
                    ))}
                  </div>

                  <Input
                    placeholder="Filter tools..."
                    value={toolSearch}
                    onChange={(e) => { setToolSearch(e.target.value); setShowAllTools(false) }}
                    className="mb-1 text-xs h-7"
                  />

                  <div className="space-y-0.5 max-h-[180px] overflow-y-auto border rounded-md p-1.5">
                    {groups.map(([source, tools]) => {
                      const filtered = toolSearch
                        ? (tools as any[]).filter(t => t.name?.toLowerCase().includes(toolSearch.toLowerCase()))
                        : tools as any[]
                      if (filtered.length === 0) return null
                      const groupIds = (tools as any[]).map(t => t.id)
                      const allSelected = groupIds.every(id => selectedTools.includes(id))
                      return (
                        <div key={source}>
                          <button type="button" className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider py-1 w-full hover:text-foreground"
                            onClick={() => {
                              const otherIds = selectedTools.filter(id => !groupIds.includes(id))
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
                                <input type="checkbox" checked={isSelected} onChange={(e) => {
                                  updateData('toolIds', e.target.checked ? [...selectedTools, tool.id] : selectedTools.filter(id => id !== tool.id))
                                }} className="rounded" />
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
      return Array.isArray(res) ? res : res?.tools || []
    },
    enabled: !!currentOrganization,
  })

  const toolList = (Array.isArray(tools) ? tools : (tools as any)?.tools || []) as Array<Pick<Tool, 'id' | 'name'>>
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
            {/*
              A required field whose select opens on nothing is a dead
              end: the node fails validation, Save is blocked, and the
              screen never says why.
            */}
            {toolList.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No tools yet — generate some from an API, or create one under Tools.
              </div>
            )}
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
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Remove parameter" onClick={() => removeParam(i)}>
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
          <div className="mt-1">
            <CodeEditor
              value={expression}
              onChange={(value) => updateData('expression', value)}
              language="javascript"
              height="100px"
              placeholder="{{nodes.llm_1.output.sentiment}} === 'positive'"
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            JavaScript expression that evaluates to true/false.
          </p>
        </div>
      ) : (
        <div className="space-y-2 border rounded-lg p-3 bg-muted/30">
          <div>
            <Label htmlFor="node-if" className="text-xs">If</Label>
            <Select
              value={condSource}
              onValueChange={(v) => updateCondition(v, condOperator, condValue)}
            >
              <SelectTrigger id="node-if" className="mt-1 text-xs font-mono">
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
            <Label htmlFor="node-operator" className="text-xs">Operator</Label>
            <Select
              value={condOperator}
              onValueChange={(v) => updateCondition(condSource, v, condValue)}
            >
              <SelectTrigger id="node-operator" className="mt-1 text-xs">
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
            <Label htmlFor="node-value" className="text-xs">Value</Label>
            <Input id="node-value"
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
        <Label htmlFor="transform-expr">Transform Template</Label>
        <div className="mt-1">
          <CodeEditor
            value={(node.data.expression as string) || ''}
            onChange={(value) => updateData('expression', value)}
            language="text"
            height="140px"
            placeholder={'{\n  "summary": "{{nodes.llm_1.output}}",\n  "source": "{{input.url}}"\n}'}
          />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          A template, not JavaScript. Each {'{{...}}'} is replaced by a value read out of{' '}
          <code>input</code>, <code>nodes</code> or <code>variables</code> by dot path.
          There are no function calls, arithmetic or indexing. The node outputs the
          rendered text, so a template shaped like JSON produces a JSON string
          downstream, not an object.
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
        <Label htmlFor="node-merge-strategy">Merge Strategy</Label>
        <Select
          value={(node.data.strategy as string) || 'first_response'}
          onValueChange={(v) => updateData('strategy', v)}
        >
          <SelectTrigger id="node-merge-strategy" className="mt-1">
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
        <>
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
            <p className="mt-1 text-xs text-muted-foreground">
              Leave empty to ask for the best option and nothing else. The judge must answer
              with just the option number.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            The judging call uses this node&apos;s own provider or routing policy, and
            falls back to the organization&apos;s default routing policy. With none of
            the three set, the run fails at this node. One incoming branch is returned
            as-is, without a judging call.
          </p>
        </>
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
            value={(node.data.consensusThreshold as number) ?? 0.5}
            onChange={(e) => updateData('consensusThreshold', parseFloat(e.target.value))}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            The share of branches that have to agree. The node outputs the combined answer
            plus <code>agreement</code> and <code>consensusReached</code>, so a Condition
            node downstream can branch on disagreement.
          </p>
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
            // One write, not two. Both `updateData` calls spread the same
            // `node.data` prop -- React has not re-rendered between them --
            // and onUpdateNode replaces `data` wholesale, so writing the
            // name second used to drop the id written first.
            onUpdateNode(node.id, {
              ...node.data,
              agentId: v,
              agentName: agent?.name || '',
            })
          }}
        >
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="Select agent" />
          </SelectTrigger>
          <SelectContent>
            {/*
              A required field whose select opens on nothing is a dead
              end: the node fails validation, Save is blocked, and the
              screen never says why.
            */}
            {agentList.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                No other agents to call yet.
              </div>
            )}
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
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Remove mapping" onClick={() => removeMapping(i)}>
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

// --- Loop Node Config ---
function LoopConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  return (
    <div className="space-y-3">
      <div>
        <Label>Iterable Expression</Label>
        <div className="mt-1">
          <CodeEditor
            value={(node.data.iterableExpression as string) || ''}
            onChange={(value) => updateData('iterableExpression', value)}
            language="javascript"
            height="80px"
            placeholder="{{nodes.tool_1.output.items}}"
          />
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Template expression that resolves to an array. This node outputs that array,
          capped at Max Iterations. It does not run the nodes downstream of it once per
          item — read the whole list with <code>{'{{nodes.<id>.output}}'}</code>, or fan
          it out through a Parallel node.
        </p>
      </div>
      <div>
        <Label htmlFor="node-max-iterations">Max Iterations</Label>
        <Input id="node-max-iterations"
          type="number"
          className="mt-1"
          min={1}
          max={1000}
          value={(node.data.maxIterations as number) || 100}
          onChange={(e) => updateData('maxIterations', parseInt(e.target.value) || 100)}
        />
      </div>
    </div>
  )
}

// --- Verify Config ---

interface VerifyChecker {
  name?: string
  providerId?: string
  model?: string
  roleKey?: string
  instructions?: string
}

const VERIFY_POLICIES = [
  { value: 'any_fail_blocks', label: 'Any checker fails -> fail' },
  { value: 'majority', label: 'Majority of checkers' },
  { value: 'all_pass', label: 'All checkers must pass' },
] as const

function VerifyConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  const { data: providers } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const res = await llmProvidersApi.getAll()
      return Array.isArray(res) ? res : res?.providers || []
    },
  })
  const providerList = (Array.isArray(providers) ? providers : (providers as any)?.providers || []) as Array<
    Pick<LlmProvider, 'id' | 'name' | 'type'>
  >

  const checkers: VerifyChecker[] = Array.isArray(node.data.checkers)
    ? (node.data.checkers as VerifyChecker[])
    : []

  // Every write goes through the whole list, so a checker that names a role
  // and nothing else -- what the strategy compiler emits, and what keeps an
  // ejected graph portable -- keeps its roleKey when any other field is
  // edited.
  const patchChecker = (index: number, patch: Partial<VerifyChecker>) => {
    updateData('checkers', checkers.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }
  const addChecker = () => {
    updateData('checkers', [...checkers, { name: '', providerId: '', model: '', instructions: '' }])
  }
  const removeChecker = (index: number) => {
    updateData('checkers', checkers.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="verify-target">Target</Label>
        <Textarea
          id="verify-target"
          className="mt-1 font-mono text-xs"
          rows={2}
          value={(node.data.target as string) || ''}
          onChange={(e) => updateData('target', e.target.value || undefined)}
          placeholder="{{nodes.draft.output}}"
        />
        <p className="text-xs text-muted-foreground mt-1">
          What gets checked. Leave it empty to check the output of the step(s) wired into
          this node.
        </p>
      </div>

      <div>
        <Label htmlFor="verify-spec">Spec</Label>
        <Textarea
          id="verify-spec"
          className="mt-1 text-xs"
          rows={4}
          value={(node.data.spec as string) || ''}
          onChange={(e) => updateData('spec', e.target.value)}
          placeholder="The answer must cite a source for every figure."
        />
        <p className="text-xs text-muted-foreground mt-1">
          The rules every checker holds the target to. {'{{...}}'} values are resolved before
          the checkers see it.
        </p>
      </div>

      <div>
        <Label htmlFor="verify-policy">Merge policy</Label>
        <Select
          value={(node.data.policy as string) || 'any_fail_blocks'}
          onValueChange={(v) => updateData('policy', v)}
        >
          <SelectTrigger id="verify-policy" className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VERIFY_POLICIES.map((p) => (
              <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label>Checkers</Label>
          <span className="text-xs text-muted-foreground">{checkers.length}</span>
        </div>

        {checkers.length === 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            At least one checker is required. Point each one at a different provider to get a
            cross-vendor panel.
          </p>
        )}

        <div className="mt-2 space-y-2">
          {checkers.map((checker, i) => (
            <div key={i} className="rounded-lg border p-2 space-y-2 bg-background">
              <div className="flex items-center gap-1">
                <Input
                  className="text-xs"
                  aria-label={`Checker ${i + 1} name`}
                  placeholder="name"
                  value={checker.name || ''}
                  onChange={(e) => patchChecker(i, { name: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  aria-label={`Remove checker ${i + 1}`}
                  onClick={() => removeChecker(i)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>

              {checker.roleKey && !checker.providerId && (
                <p className="text-[11px] text-muted-foreground">
                  Filled at run time by role <code>{checker.roleKey}</code>. Pick a provider
                  below to pin it instead.
                </p>
              )}

              <Select
                value={checker.providerId || ''}
                onValueChange={(v) => patchChecker(i, { providerId: v })}
              >
                <SelectTrigger className="text-xs" aria-label={`Checker ${i + 1} provider`}>
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {providerList.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      No model providers connected yet — add one under Models.
                    </div>
                  )}
                  {providerList.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} <span className="text-muted-foreground ml-1">({p.type})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                className="text-xs"
                aria-label={`Checker ${i + 1} model`}
                placeholder="model (optional)"
                value={checker.model || ''}
                onChange={(e) => patchChecker(i, { model: e.target.value })}
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
            Add Checker
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        A checker only tries to refute. This node never fails the run on a bad verdict — it
        outputs <code>verdict</code>, <code>passed</code> and <code>failures</code>, so a
        Condition node downstream is what decides to retry, escalate or stop.
      </p>
    </div>
  )
}

// --- Extract Context Config ---
function ExtractContextConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
  const { data: providers } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const res = await llmProvidersApi.getAll()
      return Array.isArray(res) ? res : res?.providers || []
    },
  })
  const providerList = (Array.isArray(providers) ? providers : (providers as any)?.providers || []) as Array<
    Pick<LlmProvider, 'id' | 'name' | 'type'>
  >
  const roleKey = node.data.roleKey as string | undefined

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="extract-task">Task</Label>
        <Textarea
          id="extract-task"
          className="mt-1 font-mono text-xs"
          rows={2}
          value={(node.data.task as string) || ''}
          onChange={(e) => updateData('task', e.target.value || undefined)}
          placeholder="{{input.message}}"
        />
        <p className="text-xs text-muted-foreground mt-1">
          What the brief is for. Leave it empty to use the run input.
        </p>
      </div>

      <div>
        <Label htmlFor="extract-sources">Sources</Label>
        <Textarea
          id="extract-sources"
          className="mt-1 font-mono text-xs"
          rows={2}
          value={(node.data.sources as string) || ''}
          onChange={(e) => updateData('sources', e.target.value || undefined)}
          placeholder="{{nodes.explore_1.output}}"
        />
        <p className="text-xs text-muted-foreground mt-1">
          What gets compressed. Leave it empty to use the output of the step(s) wired into this
          node. With neither, the node fails rather than passing the transcripts through.
        </p>
      </div>

      {roleKey ? (
        <div>
          <Label>Model</Label>
          <p className="text-xs text-muted-foreground mt-1">
            Filled at run time by role <code>{roleKey}</code>.
          </p>
        </div>
      ) : (
        <>
          <div>
            <Label htmlFor="extract-provider">Provider</Label>
            <Select
              value={(node.data.providerId as string) || ''}
              onValueChange={(v) => updateData('providerId', v)}
            >
              <SelectTrigger id="extract-provider" className="mt-1">
                <SelectValue placeholder="Organization default routing policy" />
              </SelectTrigger>
              <SelectContent>
                {providerList.length === 0 && (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No model providers connected yet — add one under Models.
                  </div>
                )}
                {providerList.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} <span className="text-muted-foreground ml-1">({p.type})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Leave it unset and the organization's default routing policy answers. With no
              default set either, the run fails at this node.
            </p>
          </div>

          <div>
            <Label htmlFor="extract-model">Model</Label>
            <Input
              id="extract-model"
              className="mt-1"
              value={(node.data.model as string) || ''}
              onChange={(e) => updateData('model', e.target.value)}
              placeholder="Enter model name"
            />
          </div>
        </>
      )}

      <div>
        <Label htmlFor="extract-instruction">Instruction</Label>
        <Textarea
          id="extract-instruction"
          className="mt-1 text-xs"
          rows={3}
          value={(node.data.instruction as string) || ''}
          onChange={(e) => updateData('instruction', e.target.value || undefined)}
          placeholder="Leave empty to use the built-in extraction instruction"
        />
        <p className="text-xs text-muted-foreground mt-1">
          The brief has to come back in the structured format this node parses. Replace the
          built-in instruction only if the replacement still asks for that format — a brief
          that does not parse fails the node.
        </p>
      </div>
    </div>
  )
}

// --- Decision Config ---

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

// `boolean` is a contract type but the node refuses it: a boolean question
// declares no options, so it has no abstain edge and the threshold protects
// nothing. It is offerable only on a node that already carries it, so an
// imported graph can be read and corrected rather than silently failing.
const DECISION_TYPES = [
  { value: 'choice', label: 'Choice - pick one declared option' },
  { value: 'score', label: 'Score - pick one ordered level' },
] as const

// Same rule: only `asis` is served today, and the node refuses the other two
// by name rather than quietly serving the declared order.
const DECISION_ORDER_POLICIES = [{ value: 'asis', label: 'As written' }] as const

function DecisionConfig({ node, updateData }: { node: Node; updateData: UpdateDataFn }) {
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
      <div>
        <Label htmlFor="decision-question-id">Question ID</Label>
        <Input
          id="decision-question-id"
          className="mt-1 font-mono text-xs"
          value={question.id || ''}
          onChange={(e) => patchQuestion({ id: e.target.value })}
          placeholder="decision"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Answers come back keyed by this id.
        </p>
      </div>

      <div>
        <Label htmlFor="decision-type">Question type</Label>
        <Select value={type} onValueChange={(v) => patchQuestion({ type: v as DecisionQuestion['type'] })}>
          <SelectTrigger id="decision-type" className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DECISION_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
            {isBoolean && (
              <SelectItem value="boolean">Boolean - refused by this node</SelectItem>
            )}
          </SelectContent>
        </Select>
        {isBoolean && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
            This node refuses a boolean question at run time: it declares no options, so it has
            no abstain edge and no threshold to clear. Ask it as a choice with yes / no /
            abstain options instead.
          </p>
        )}
      </div>

      <div>
        <Label htmlFor="decision-prompt">Prompt</Label>
        <Textarea
          id="decision-prompt"
          className="mt-1 text-xs"
          rows={3}
          value={question.prompt || ''}
          onChange={(e) => patchQuestion({ prompt: e.target.value })}
          placeholder="Does this ticket describe a billing problem?"
        />
        <p className="text-xs text-muted-foreground mt-1">
          The question asked of the state wired into this node. It is answered with a
          distribution over the options below, not with prose.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label>Options</Label>
          <span className="text-xs text-muted-foreground">{options.length}</span>
        </div>

        {abstainCount === 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            No abstain option. Every choice question needs one — without it the node cannot
            answer "the state does not say" and returns its best-scoring wrong option
            instead.
          </p>
        )}

        <div className="mt-2 space-y-2">
          {options.map((option, i) => (
            <div key={i} className="rounded-lg border p-2 space-y-2 bg-background">
              <div className="flex items-center gap-1">
                <Input
                  className="text-xs font-mono"
                  aria-label={`Option ${i + 1} id`}
                  placeholder="option id"
                  value={option.id || ''}
                  onChange={(e) => patchOption(i, { id: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() => removeOption(i)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>

              <Input
                className="text-xs"
                aria-label={`Option ${i + 1} description`}
                placeholder="what this option means (optional)"
                value={option.description || ''}
                onChange={(e) => patchOption(i, { description: e.target.value || undefined })}
              />

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Switch
                    id={`decision-abstain-${i}`}
                    aria-label={`Option ${i + 1} is the abstain option`}
                    checked={option.abstain === true}
                    onCheckedChange={(checked) =>
                      checked ? markAbstain(i) : patchOption(i, { abstain: undefined })
                    }
                  />
                  <Label htmlFor={`decision-abstain-${i}`} className="text-xs font-normal">
                    Abstain
                  </Label>
                </div>

                {option.abstain !== true && (
                  <div className="flex items-center gap-1">
                    <Label
                      htmlFor={`decision-threshold-${i}`}
                      className="text-xs font-normal text-muted-foreground"
                    >
                      Threshold
                    </Label>
                    <Input
                      id={`decision-threshold-${i}`}
                      className="text-xs w-20"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      aria-label={`Option ${i + 1} threshold`}
                      value={
                        typeof thresholds[option.id] === 'number' ? String(thresholds[option.id]) : ''
                      }
                      onChange={(e) => setThreshold(option.id, e.target.value)}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}

          <Button variant="outline" size="sm" className="w-full" onClick={addOption}>
            Add Option
          </Button>
        </div>
      </div>

      <div>
        <Label htmlFor="decision-order-policy">Option order</Label>
        <Select
          value={orderPolicy}
          onValueChange={(v) => patchQuestion({ optionsOrderPolicy: v as DecisionQuestion['optionsOrderPolicy'] })}
        >
          <SelectTrigger id="decision-order-policy" className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DECISION_ORDER_POLICIES.map((p) => (
              <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
            ))}
            {unservedOrderPolicy && (
              <SelectItem value={orderPolicy}>{orderPolicy} - refused by this node</SelectItem>
            )}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          Where an option sits in the prompt moves the answer on its own, so the order they
          happen to be written in is a confound. Only <code>asis</code> is served today.
        </p>
        {unservedOrderPolicy && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
            This node refuses <code>{orderPolicy}</code> at run time rather than quietly serving
            the declared order, because a caller who asked for the order to be debiased cannot
            tell from the distribution that it was not.
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        The node leaves by the edge of the winning option. An answer that scores below that
        option's threshold leaves by <code>abstain</code> instead, so a low-confidence guess
        is never handed downstream as a decision.
      </p>
    </div>
  )
}
