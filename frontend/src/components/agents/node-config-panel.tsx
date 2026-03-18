import React from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Node } from '@xyflow/react'
import { X, Trash2 } from 'lucide-react'

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

import { llmProvidersApi, toolsApi, agentsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { NODE_TYPE_CONFIG, type PipelineNodeType } from './nodes'

interface NodeConfigPanelProps {
  node: Node | null
  onUpdateNode: (nodeId: string, data: Record<string, any>) => void
  onDeleteNode: (nodeId: string) => void
  onClose: () => void
}

export function NodeConfigPanel({ node, onUpdateNode, onDeleteNode, onClose }: NodeConfigPanelProps) {
  if (!node) return null

  const nodeType = node.type as PipelineNodeType
  const config = NODE_TYPE_CONFIG[nodeType]

  const updateData = (key: string, value: any) => {
    onUpdateNode(node.id, { ...node.data, [key]: value })
  }

  return (
    <div className="w-[320px] border-l bg-muted/30 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${config?.color || 'bg-gray-500'}`} />
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
        {nodeType === 'output' && <OutputConfig node={node} updateData={updateData} />}
        {nodeType === 'llm_call' && <LlmCallConfig node={node} updateData={updateData} />}
        {nodeType === 'tool_call' && <ToolCallConfig node={node} updateData={updateData} />}
        {nodeType === 'condition' && <ConditionConfig node={node} updateData={updateData} />}
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
function InputConfig({ node, updateData }: { node: Node; updateData: (k: string, v: any) => void }) {
  const schema = node.data.schema as any
  const schemaStr = schema ? JSON.stringify(schema, null, 2) : ''

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="input-schema">Input Schema (JSON)</Label>
        <Textarea
          id="input-schema"
          className="mt-1 font-mono text-xs"
          rows={10}
          value={schemaStr}
          onChange={(e) => {
            try {
              const parsed = JSON.parse(e.target.value)
              updateData('schema', parsed)
            } catch {
              // Allow invalid JSON while typing
            }
          }}
          placeholder='{"type": "object", "properties": {"message": {"type": "string"}}}'
        />
        <p className="text-xs text-muted-foreground mt-1">
          Define the JSON Schema for pipeline input.
        </p>
      </div>
    </div>
  )
}

// --- Output Node Config ---
function OutputConfig({ node, updateData }: { node: Node; updateData: (k: string, v: any) => void }) {
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="output-mapping">Output Mapping</Label>
        <Textarea
          id="output-mapping"
          className="mt-1 font-mono text-xs"
          rows={4}
          value={(node.data.mapping as string) || ''}
          onChange={(e) => updateData('mapping', e.target.value)}
          placeholder="{{nodes.llm_1.output}}"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Template expression mapping node outputs to pipeline result. Use {'{{nodes.<id>.output}}'} syntax.
        </p>
      </div>
    </div>
  )
}

// --- LLM Call Config ---
function LlmCallConfig({ node, updateData }: { node: Node; updateData: (k: string, v: any) => void }) {
  const { currentOrganization } = useOrganizationStore()

  const { data: providers } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const res = await llmProvidersApi.getAll()
      const d = res.data?.data || res.data
      return Array.isArray(d) ? d : d?.providers || []
    },
  })

  const { data: tools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const res = await toolsApi.getAll(currentOrganization?.id)
      const d = res.data?.data || res.data
      return Array.isArray(d) ? d : d?.tools || []
    },
    enabled: !!currentOrganization,
  })

  const temperature = typeof node.data.temperature === 'number' ? node.data.temperature : 0.7

  return (
    <div className="space-y-3">
      <div>
        <Label>LLM Provider</Label>
        <Select
          value={(node.data.providerId as string) || ''}
          onValueChange={(v) => {
            const provider = (providers || []).find((p: any) => p.id === v)
            updateData('providerId', v)
            if (provider) {
              updateData('providerName', provider.name)
            }
          }}
        >
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {(providers || []).map((p: any) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="model">Model</Label>
        <Input
          id="model"
          className="mt-1"
          value={(node.data.model as string) || ''}
          onChange={(e) => updateData('model', e.target.value)}
          placeholder="gpt-4o, claude-3.5-sonnet, etc."
        />
      </div>

      <div>
        <Label htmlFor="system-prompt">System Prompt</Label>
        <Textarea
          id="system-prompt"
          className="mt-1 text-xs"
          rows={4}
          value={(node.data.systemPrompt as string) || ''}
          onChange={(e) => updateData('systemPrompt', e.target.value)}
          placeholder="You are a helpful assistant..."
        />
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
        <p className="text-xs text-muted-foreground mt-1">
          Use {'{{input.*}}'} or {'{{nodes.<id>.output}}'} for dynamic values.
        </p>
      </div>

      <div>
        <Label>Temperature: {(temperature as number).toFixed(2)}</Label>
        <Slider
          className="mt-2"
          value={[temperature as number]}
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
        <div className="mt-1 space-y-1 max-h-[140px] overflow-y-auto border rounded-md p-2">
          {(tools || []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No tools available</p>
          ) : (
            (tools || []).map((tool: any) => {
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
                        : selectedTools.filter((id: string) => id !== tool.id)
                      updateData('toolIds', newSelected)
                    }}
                    className="rounded"
                  />
                  <span className="truncate">{tool.name}</span>
                </label>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// --- Tool Call Config ---
function ToolCallConfig({ node, updateData }: { node: Node; updateData: (k: string, v: any) => void }) {
  const { currentOrganization } = useOrganizationStore()

  const { data: tools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const res = await toolsApi.getAll(currentOrganization?.id)
      const d = res.data?.data || res.data
      return Array.isArray(d) ? d : d?.tools || []
    },
    enabled: !!currentOrganization,
  })

  const params: Array<{ key: string; value: string }> = (node.data.parameterMapping as any[]) || []

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
            const tool = (tools || []).find((t: any) => t.id === v)
            updateData('toolId', v)
            if (tool) {
              updateData('toolName', tool.name)
            }
          }}
        >
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="Select tool" />
          </SelectTrigger>
          <SelectContent>
            {(tools || []).map((t: any) => (
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

// --- Condition Config ---
function ConditionConfig({ node, updateData }: { node: Node; updateData: (k: string, v: any) => void }) {
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="condition-expr">Condition Expression</Label>
        <Textarea
          id="condition-expr"
          className="mt-1 font-mono text-xs"
          rows={4}
          value={(node.data.expression as string) || ''}
          onChange={(e) => updateData('expression', e.target.value)}
          placeholder="{{nodes.llm_1.output.sentiment}} === 'positive'"
        />
        <p className="text-xs text-muted-foreground mt-1">
          JavaScript expression that evaluates to true/false. The "True" handle connects to the right path, "False" connects below.
        </p>
      </div>
    </div>
  )
}

// --- Transform Config ---
function TransformConfig({ node, updateData }: { node: Node; updateData: (k: string, v: any) => void }) {
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
function MergeConfig({ node, updateData }: { node: Node; updateData: (k: string, v: any) => void }) {
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
function SubAgentConfig({ node, updateData }: { node: Node; updateData: (k: string, v: any) => void }) {
  const { data: agents } = useQuery({
    queryKey: ['agents-for-subagent'],
    queryFn: async () => {
      const res = await agentsApi.getAll()
      const d = res.data?.data || res.data
      const result = d?.agents || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
  })

  const mappings: Array<{ key: string; value: string }> = (node.data.inputMapping as any[]) || []

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
            const agent = (agents || []).find((a: any) => a.id === v)
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
            {(agents || []).map((a: any) => (
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
