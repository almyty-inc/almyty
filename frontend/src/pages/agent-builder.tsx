import React, { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, X, ChevronDown, ChevronRight, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { useAgentPipeline } from '@/components/agents/builder/use-agent-pipeline'
import { BuilderToolbar } from '@/components/agents/builder/builder-toolbar'
import { TestPanel } from '@/components/agents/builder/test-panel'
import { CanvasArea } from '@/components/agents/builder/canvas-area'

import { agentsApi, llmProvidersApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import type { Agent, PipelineNode, PipelineEdge } from '@/types'

const DEFAULT_PIPELINE_NODES: PipelineNode[] = [
  { id: 'input_1', type: 'input', position: { x: 50, y: 200 }, data: { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } },
  { id: 'llm_1', type: 'llm_call', position: { x: 350, y: 200 }, data: { userPromptTemplate: '{{input.message}}' } },
  { id: 'output_1', type: 'output', position: { x: 650, y: 200 }, data: { mapping: '{{nodes.llm_1.output}}' } },
]

const DEFAULT_PIPELINE_EDGES: PipelineEdge[] = [
  { id: 'e1', source: 'input_1', target: 'llm_1' },
  { id: 'e2', source: 'llm_1', target: 'output_1' },
]

export function AgentBuilderPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()

  const isEditing = !!id
  const templateId = searchParams.get('template')

  // ── Agent metadata state ───────────────────────────────────────────────
  const [agentName, setAgentName] = useState('New Agent')
  const [agentDescription, setAgentDescription] = useState('')
  const [agentStatus, setAgentStatus] = useState<string>('draft')
  const [agentMode, setAgentMode] = useState<'workflow' | 'autonomous'>('workflow')
  const [agentPersonality, setAgentSoul] = useState('')
  const [agentInstructions, setAgentInstructions] = useState('')
  const [agentHeartbeat, setAgentHeartbeat] = useState<{ enabled: boolean; intervalMinutes: number; prompt: string }>({ enabled: false, intervalMinutes: 60, prompt: '' })
  const [agentToolIds, setAgentToolIds] = useState<string[]>([])
  const [agentModelConfig, setAgentModelConfig] = useState<{ providerId?: string; model?: string; temperature?: number; maxTokens?: number }>({})
  const [agentMemoryConfig, setAgentMemoryConfig] = useState<{ enabled?: boolean; autoSave?: boolean }>({ enabled: false, autoSave: false })
  const [agentConfig, setAgentConfig] = useState<{ canCallAgents?: boolean; canCreateAgents?: boolean }>({ canCallAgents: false, canCreateAgents: false })
  const [agentCollaboration, setAgentCollaboration] = useState<{
    enabled: boolean;
    strategy: 'sequential' | 'parallel' | 'race' | 'debate';
    agents: { agentId: string; role?: string }[];
    sharedBrief?: string;
    rules?: {
      maxTotalCost?: number;
      maxChainDepth?: number;
      outputFormat?: 'text' | 'json';
      escalation?: 'never' | 'on_failure' | 'on_low_confidence';
      conflictResolution?: 'judge' | 'majority' | 'first_wins' | 'merge';
      sharedMemoryScope?: boolean;
      allowRevision?: boolean;
    };
    judgeAgentId?: string;
    maxRounds?: number;
  }>({ enabled: false, strategy: 'sequential', agents: [], rules: {} })

  const [showTestPanel, setShowTestPanel] = useState(false)

  // ── Tool picker state ──────────────────────────────────────────────────
  const [toolSearch, setToolSearch] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // ── Pipeline state (nodes, edges, undo/redo, CRUD) ─────────────────────
  const pipeline = useAgentPipeline()

  // Document title
  useEffect(() => {
    document.title = isEditing ? `Edit Agent | almyty` : `New Agent | almyty`
    return () => { document.title = 'almyty' }
  }, [isEditing])

  // Fetch existing agent when editing
  const { data: agentData, isLoading: isLoadingAgent } = useQuery({
    queryKey: ['agent', id],
    queryFn: () => agentsApi.getById(id!),
    enabled: isEditing,
  })

  // Fetch available tools (for autonomous mode)
  const { data: rawTools } = useQuery({
    queryKey: ['tools-list', currentOrganization?.id],
    queryFn: () => toolsApi.getAll(currentOrganization?.id),
    enabled: !!currentOrganization?.id,
  })
  const availableTools = Array.isArray(rawTools) ? rawTools : (rawTools as any)?.tools || []

  // Fetch LLM providers (for autonomous mode)
  const { data: rawProviders } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: () => llmProvidersApi.getAll(),
  })
  const availableProviders = Array.isArray(rawProviders) ? rawProviders : (rawProviders as any)?.providers || []

  // Fetch available agents (for collaboration)
  const { data: rawAgents } = useQuery({
    queryKey: ['agents-list'],
    queryFn: () => agentsApi.getAll(),
  })
  const availableAgents = Array.isArray(rawAgents) ? rawAgents : (rawAgents as any)?.data || []

  // Fetch templates for template-based creation
  const { data: templatesData } = useQuery({
    queryKey: ['agent-templates'],
    queryFn: async () => {
      const d = await agentsApi.getTemplates()
      return d || []
    },
    enabled: !!templateId && !isEditing,
  })

  // Initialize pipeline from fetched data, template, or defaults
  useEffect(() => {
    if (pipeline.initialized) return

    if (isEditing && agentData) {
      const agent = agentData as Agent
      setAgentName(agent.name)
      setAgentDescription(agent.description || '')
      setAgentStatus(agent.status)
      setAgentMode(agent.mode || 'workflow')
      setAgentSoul(agent.personality || '')
      setAgentInstructions(agent.instructions || '')
      setAgentHeartbeat(agent.heartbeat || { enabled: false, intervalMinutes: 60, prompt: '' })
      setAgentToolIds(agent.toolIds || [])
      setAgentModelConfig(agent.modelConfig || {})
      setAgentMemoryConfig(agent.memoryConfig || { enabled: false, autoSave: false })
      setAgentConfig(agent.agentConfig || { canCallAgents: false, canCreateAgents: false })
      if (agent.collaboration) {
        setAgentCollaboration({ enabled: true, ...agent.collaboration })
      }
      const pipelineNodes = (agent.pipeline?.nodes || []).map((n: PipelineNode) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
      }))
      const pipelineEdges = (agent.pipeline?.edges || []).map((e: PipelineEdge) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        label: e.label,
      }))
      pipeline.setNodes(pipelineNodes)
      pipeline.setEdges(pipelineEdges)
      pipeline.setInitialized(true)
    } else if (!isEditing && templateId && Array.isArray(templatesData)) {
      // Initialize from template
      const template = templatesData.find((t: any) => t.id === templateId)
      if (template) {
        setAgentName(template.name)
        setAgentDescription(template.description || '')
        const pipelineNodes = (template.pipeline?.nodes || []).map((n: any) => ({
          id: n.id,
          type: n.type,
          position: n.position,
          data: n.data || n.config || {},
        }))
        const pipelineEdges = (template.pipeline?.edges || []).map((e: any) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
          label: e.label,
        }))
        pipeline.setNodes(pipelineNodes)
        pipeline.setEdges(pipelineEdges)
        pipeline.setInitialized(true)
      }
    } else if (!isEditing && !templateId) {
      pipeline.setNodes(DEFAULT_PIPELINE_NODES.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
      })))
      pipeline.setEdges(DEFAULT_PIPELINE_EDGES.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })))
      pipeline.setInitialized(true)
    }
  }, [isEditing, agentData, pipeline.initialized, pipeline.setNodes, pipeline.setEdges, pipeline.setInitialized, templateId, templatesData])

  // ── Validation ──────────────────────────────────────────────────────────
  const validationErrors = useMemo(() => {
    const errors: string[] = []

    if (!agentName.trim()) {
      errors.push('Agent name is required')
    }

    if (agentMode === 'workflow') {
      const hasInput = pipeline.nodes.some((n) => n.type === 'input')
      const hasOutput = pipeline.nodes.some((n) => n.type === 'output')
      if (!hasInput) {
        errors.push('Pipeline must have at least one Input node')
      }
      if (!hasOutput) {
        errors.push('Pipeline must have at least one Output node')
      }

      // Check that all LLM call nodes have a provider selected
      const llmNodes = pipeline.nodes.filter((n) => n.type === 'llm_call')
      for (const llmNode of llmNodes) {
        if (!llmNode.data?.providerId) {
          errors.push(`LLM Call node "${llmNode.id}" is missing a provider`)
        }
      }
    } else {
      // Autonomous mode validation
      if (!agentInstructions.trim()) {
        errors.push('Instructions are required for autonomous agents')
      }
      if (!agentModelConfig.providerId) {
        errors.push('A model provider must be selected')
      }
    }

    return errors
  }, [agentName, agentMode, agentInstructions, agentModelConfig, pipeline.nodes])

  const canSave = validationErrors.length === 0

  // Build pipeline payload
  const buildPipeline = () => {
    const viewport = pipeline.reactFlowInstance?.getViewport()
    return {
      nodes: pipeline.nodes.map((n) => ({
        id: n.id,
        type: n.type as PipelineNode['type'],
        position: n.position,
        data: n.data as Record<string, any>,
      })),
      edges: pipeline.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || undefined,
        targetHandle: e.targetHandle || undefined,
        label: (e.label as string) || undefined,
      })),
      viewport: viewport ? { x: viewport.x, y: viewport.y, zoom: viewport.zoom } : undefined,
    }
  }

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: any = {
        name: agentName,
        description: agentDescription || undefined,
        mode: agentMode,
      }

      if (agentMode === 'workflow') {
        payload.pipeline = buildPipeline()
      } else {
        // Autonomous mode -- save instructions + soul + heartbeat + tools + model config
        payload.personality = agentPersonality || undefined
        payload.instructions = agentInstructions
        payload.heartbeat = agentHeartbeat.enabled ? agentHeartbeat : { enabled: false, intervalMinutes: agentHeartbeat.intervalMinutes, prompt: agentHeartbeat.prompt }
        payload.toolIds = agentToolIds
        payload.modelConfig = agentModelConfig
        payload.memoryConfig = agentMemoryConfig
        payload.agentConfig = agentConfig
        if (agentCollaboration.enabled && agentCollaboration.agents.length > 0) {
          payload.collaboration = {
            strategy: agentCollaboration.strategy,
            agents: agentCollaboration.agents,
            sharedBrief: agentCollaboration.sharedBrief || undefined,
            rules: agentCollaboration.rules && Object.values(agentCollaboration.rules).some(v => v !== undefined && v !== null)
              ? agentCollaboration.rules
              : undefined,
            judgeAgentId: agentCollaboration.judgeAgentId,
            maxRounds: agentCollaboration.maxRounds,
          }
        } else {
          payload.collaboration = null
        }
        // Keep a minimal pipeline for backward compat
        payload.pipeline = payload.pipeline || { nodes: [], edges: [] }
      }

      if (isEditing) {
        return agentsApi.update(id!, payload)
      } else {
        return agentsApi.create(payload, currentOrganization?.id)
      }
    },
    onSuccess: async (res) => {
      success('Saved', `Agent "${agentName}" saved successfully.`)
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      if (!isEditing) {
        const newAgent = res
        if (newAgent?.id) {
          navigate(`/agents/${newAgent.id}/edit`, { replace: true })
        }
      } else {
        await queryClient.invalidateQueries({ queryKey: ['agent', id] })
      }
    },
    onError: (err: any) => {
      errorNotif('Save Failed', err?.response?.data?.message || err?.message || 'Failed to save agent')
    },
  })

  const handleSave = () => {
    if (!canSave) {
      errorNotif('Validation Failed', validationErrors.join('. '))
      return
    }
    saveMutation.mutate()
  }

  const handleExport = async () => {
    try {
      const exportData = await agentsApi.exportAgent(id!)
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${agentName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`
      a.click()
      URL.revokeObjectURL(url)
      success('Exported', 'Agent JSON downloaded.')
    } catch (err: any) {
      errorNotif('Export Failed', err?.message || 'Failed to export agent')
    }
  }

  if (isEditing && isLoadingAgent) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-64px)]">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Top Bar */}
      <BuilderToolbar
        agentName={agentName}
        onAgentNameChange={setAgentName}
        agentStatus={agentStatus}
        agentMode={agentMode}
        onAgentModeChange={setAgentMode}
        canUndo={pipeline.canUndo}
        canRedo={pipeline.canRedo}
        undo={pipeline.undo}
        redo={pipeline.redo}
        isEditing={isEditing}
        id={id}
        agentVersion={agentData ? (agentData as Agent).version || '1.0.0' : undefined}
        showTestPanel={showTestPanel}
        onToggleTestPanel={() => setShowTestPanel(!showTestPanel)}
        canSave={canSave}
        validationErrors={validationErrors}
        isSaving={saveMutation.isPending}
        onSave={handleSave}
        onExport={handleExport}
        onBack={() => navigate('/agents')}
      />

      {/* Validation Errors Banner */}
      {validationErrors.length > 0 && (
        <div className="px-4 py-2 bg-destructive/10 border-b border-destructive/20 shrink-0">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <ul className="text-xs text-destructive space-y-0.5">
              {validationErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Main content: Workflow pipeline or Autonomous config */}
      {agentMode === 'autonomous' ? (
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 max-w-4xl mx-auto w-full space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Personality & Style</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={agentPersonality}
                onChange={(e) => setAgentSoul(e.target.value)}
                placeholder="You are a friendly, professional assistant. You never share personal opinions on politics or religion. You always cite your sources."
                className="min-h-[120px] font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-2">
                Personality, tone, and boundaries. Defines WHO the agent is.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Instructions</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={agentInstructions}
                onChange={(e) => setAgentInstructions(e.target.value)}
                placeholder="You are a helpful assistant that..."
                className="min-h-[200px] font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-2">
                What the agent should do. Goals, tasks, and workflows.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Model Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm">Provider</Label>
                  <Select value={agentModelConfig.providerId || ''} onValueChange={(v) => setAgentModelConfig({ ...agentModelConfig, providerId: v })}>
                    <SelectTrigger><SelectValue placeholder="Select provider" /></SelectTrigger>
                    <SelectContent>
                      {availableProviders.map((p: any) => (
                        <SelectItem key={p.id} value={p.id}>{p.name} ({p.type})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-sm">Model</Label>
                  <Input
                    value={agentModelConfig.model || ''}
                    onChange={(e) => setAgentModelConfig({ ...agentModelConfig, model: e.target.value })}
                    placeholder="e.g. gpt-4o, claude-sonnet-4-20250514"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm">Temperature</Label>
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={agentModelConfig.temperature ?? 0.7}
                    onChange={(e) => setAgentModelConfig({ ...agentModelConfig, temperature: parseFloat(e.target.value) })}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm">Max Tokens</Label>
                  <Input
                    type="number"
                    min={1}
                    max={200000}
                    value={agentModelConfig.maxTokens ?? 4096}
                    onChange={(e) => setAgentModelConfig({ ...agentModelConfig, maxTokens: parseInt(e.target.value) })}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tools</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">Select which tools this agent can use during execution.</p>

              {/* Selected tools summary */}
              {agentToolIds.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">{agentToolIds.length} tool{agentToolIds.length !== 1 ? 's' : ''} selected</p>
                  <div className="flex flex-wrap gap-1.5">
                    {agentToolIds.map((tid) => {
                      const tool = availableTools.find((t: any) => t.id === tid)
                      return (
                        <Badge key={tid} variant="secondary" className="text-xs gap-1 pr-1">
                          {tool?.name || tid}
                          <button
                            type="button"
                            onClick={() => setAgentToolIds(agentToolIds.filter((i) => i !== tid))}
                            className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Search input */}
              <div className="relative mb-3">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search tools..."
                  value={toolSearch}
                  onChange={(e) => setToolSearch(e.target.value)}
                  className="pl-8 h-8 text-sm"
                />
              </div>

              {/* Grouped tool list */}
              {(() => {
                const searchLower = toolSearch.toLowerCase()
                const filtered = availableTools.filter((t: any) =>
                  !toolSearch || t.name?.toLowerCase().includes(searchLower) || t.description?.toLowerCase().includes(searchLower)
                )

                if (availableTools.length === 0) {
                  return <p className="text-sm text-muted-foreground py-4 text-center">No tools available. Create tools first.</p>
                }

                if (filtered.length === 0) {
                  return <p className="text-sm text-muted-foreground py-4 text-center">No tools matching &ldquo;{toolSearch}&rdquo;</p>
                }

                // Group tools by name prefix
                const prefixBuckets: Record<string, any[]> = {}
                for (const tool of filtered) {
                  const prefix = (tool.name || '').split('_')[0]
                  if (!prefixBuckets[prefix]) prefixBuckets[prefix] = []
                  prefixBuckets[prefix].push(tool)
                }

                const groups: Record<string, any[]> = {}
                const otherTools: any[] = []
                for (const [prefix, items] of Object.entries(prefixBuckets)) {
                  if (items.length >= 3) {
                    groups[prefix] = items
                  } else {
                    otherTools.push(...items)
                  }
                }
                if (otherTools.length > 0) groups['Other'] = otherTools

                const groupEntries = Object.entries(groups).sort(([a], [b]) => {
                  if (a === 'Other') return 1
                  if (b === 'Other') return -1
                  return a.localeCompare(b)
                })

                return (
                  <div className="max-h-[400px] overflow-y-auto space-y-1">
                    {groupEntries.map(([groupName, groupTools]) => {
                      const isExpanded = expandedGroups.has(groupName)
                      const selectedInGroup = groupTools.filter((t: any) => agentToolIds.includes(t.id)).length
                      const allSelectedInGroup = selectedInGroup === groupTools.length

                      const toggleGroup = () => {
                        setExpandedGroups((prev) => {
                          const next = new Set(prev)
                          if (next.has(groupName)) next.delete(groupName)
                          else next.add(groupName)
                          return next
                        })
                      }

                      const selectAllInGroup = () => {
                        const idsToAdd = groupTools.map((t: any) => t.id).filter((tid: string) => !agentToolIds.includes(tid))
                        setAgentToolIds([...agentToolIds, ...idsToAdd])
                      }

                      const deselectAllInGroup = () => {
                        const idsToRemove = new Set(groupTools.map((t: any) => t.id))
                        setAgentToolIds(agentToolIds.filter((tid) => !idsToRemove.has(tid)))
                      }

                      return (
                        <div key={groupName} className="border rounded-md">
                          {/* Group header */}
                          <div
                            className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted/50 select-none"
                            onClick={toggleGroup}
                          >
                            {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                            <span className="text-sm font-medium flex-1">{groupName}</span>
                            <span className="text-xs text-muted-foreground">{groupTools.length} tool{groupTools.length !== 1 ? 's' : ''}{selectedInGroup > 0 ? `, ${selectedInGroup} selected` : ''}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 text-xs px-2"
                              onClick={(e) => { e.stopPropagation(); allSelectedInGroup ? deselectAllInGroup() : selectAllInGroup() }}
                            >
                              {allSelectedInGroup ? 'Deselect All' : 'Select All'}
                            </Button>
                          </div>

                          {/* Expanded tool list */}
                          {isExpanded && (
                            <div className="border-t px-2 pb-2 space-y-0.5">
                              {groupTools.map((tool: any) => (
                                <label key={tool.id} className="flex items-center gap-3 p-1.5 rounded-md hover:bg-muted/50 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={agentToolIds.includes(tool.id)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setAgentToolIds([...agentToolIds, tool.id])
                                      } else {
                                        setAgentToolIds(agentToolIds.filter((i) => i !== tool.id))
                                      }
                                    }}
                                    className="rounded"
                                  />
                                  <div className="min-w-0">
                                    <p className="text-sm font-medium truncate">{tool.name}</p>
                                    {tool.description && <p className="text-xs text-muted-foreground truncate">{tool.description}</p>}
                                  </div>
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Memory</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agentMemoryConfig.enabled || false}
                  onChange={(e) => setAgentMemoryConfig({ ...agentMemoryConfig, enabled: e.target.checked })}
                  className="rounded"
                />
                <div>
                  <p className="text-sm font-medium">Enable Memory</p>
                  <p className="text-xs text-muted-foreground">Agent will recall relevant memories before each LLM call</p>
                </div>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agentMemoryConfig.autoSave || false}
                  onChange={(e) => setAgentMemoryConfig({ ...agentMemoryConfig, autoSave: e.target.checked })}
                  className="rounded"
                />
                <div>
                  <p className="text-sm font-medium">Auto-save Memories</p>
                  <p className="text-xs text-muted-foreground">Automatically extract and save key facts from conversations</p>
                </div>
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agent Capabilities</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agentConfig.canCallAgents || false}
                  onChange={(e) => setAgentConfig({ ...agentConfig, canCallAgents: e.target.checked })}
                  className="rounded"
                />
                <div>
                  <p className="text-sm font-medium">Can call other agents</p>
                  <p className="text-xs text-muted-foreground">Discover and invoke existing agents as sub-agents</p>
                </div>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agentConfig.canCreateAgents || false}
                  onChange={(e) => setAgentConfig({ ...agentConfig, canCreateAgents: e.target.checked })}
                  className="rounded"
                />
                <div>
                  <p className="text-sm font-medium">Can create agents</p>
                  <p className="text-xs text-muted-foreground">Spawn temporary specialist agents during runs</p>
                </div>
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Collaboration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agentCollaboration.enabled}
                  onChange={(e) => setAgentCollaboration({ ...agentCollaboration, enabled: e.target.checked })}
                  className="rounded"
                />
                <div>
                  <p className="text-sm font-medium">Enable Multi-Agent Collaboration</p>
                  <p className="text-xs text-muted-foreground">Multiple agents work together on each request</p>
                </div>
              </label>

              {agentCollaboration.enabled && (
                <div className="space-y-4 pt-2">
                  <div className="space-y-2">
                    <Label className="text-sm">Strategy</Label>
                    <Select value={agentCollaboration.strategy} onValueChange={(v: any) => setAgentCollaboration({ ...agentCollaboration, strategy: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sequential">Sequential — agents run one after another, piping output to input</SelectItem>
                        <SelectItem value="parallel">Parallel — all agents run simultaneously, results merged</SelectItem>
                        <SelectItem value="race">Race — all agents run, first to finish wins</SelectItem>
                        <SelectItem value="debate">Debate — agents discuss in rounds, judge synthesizes</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm">Participating Agents</Label>
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                      {availableAgents
                        .filter((a: any) => a.id !== id)
                        .map((agent: any) => {
                          const isSelected = agentCollaboration.agents.some(a => a.agentId === agent.id)
                          const agentEntry = agentCollaboration.agents.find(a => a.agentId === agent.id)
                          return (
                            <div key={agent.id} className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50">
                              <label className="flex items-center gap-3 cursor-pointer flex-1 min-w-0">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setAgentCollaboration({
                                        ...agentCollaboration,
                                        agents: [...agentCollaboration.agents, { agentId: agent.id }],
                                      })
                                    } else {
                                      setAgentCollaboration({
                                        ...agentCollaboration,
                                        agents: agentCollaboration.agents.filter(a => a.agentId !== agent.id),
                                      })
                                    }
                                  }}
                                  className="rounded"
                                />
                                <div className="min-w-0">
                                  <p className="text-sm font-medium truncate">{agent.name}</p>
                                  {agent.description && <p className="text-xs text-muted-foreground truncate">{agent.description}</p>}
                                </div>
                              </label>
                              {isSelected && (
                                <Input
                                  placeholder="Role..."
                                  value={agentEntry?.role || ''}
                                  onChange={(e) => {
                                    setAgentCollaboration({
                                      ...agentCollaboration,
                                      agents: agentCollaboration.agents.map(a =>
                                        a.agentId === agent.id ? { ...a, role: e.target.value } : a
                                      ),
                                    })
                                  }}
                                  className="w-32 h-7 text-xs flex-shrink-0"
                                />
                              )}
                            </div>
                          )
                        })}
                      {availableAgents.filter((a: any) => a.id !== id).length === 0 && (
                        <p className="text-sm text-muted-foreground py-2 text-center">No other agents available.</p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-sm">Shared Brief</Label>
                    <Textarea
                      placeholder="Context shared with all participating agents..."
                      value={agentCollaboration.sharedBrief || ''}
                      onChange={(e) => setAgentCollaboration({ ...agentCollaboration, sharedBrief: e.target.value })}
                      rows={2}
                    />
                  </div>

                  {/* Rules section */}
                  <div className="space-y-3 border-t pt-3">
                    <Label className="text-sm font-medium">Rules of Engagement</Label>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Max Total Cost ($)</Label>
                        <Input
                          type="number"
                          min={0}
                          step={0.01}
                          placeholder="No limit"
                          value={agentCollaboration.rules?.maxTotalCost ?? ''}
                          onChange={(e) => setAgentCollaboration({
                            ...agentCollaboration,
                            rules: { ...agentCollaboration.rules, maxTotalCost: e.target.value ? parseFloat(e.target.value) : undefined },
                          })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Max Chain Depth</Label>
                        <Input
                          type="number"
                          min={1}
                          max={10}
                          placeholder="No limit"
                          value={agentCollaboration.rules?.maxChainDepth ?? ''}
                          onChange={(e) => setAgentCollaboration({
                            ...agentCollaboration,
                            rules: { ...agentCollaboration.rules, maxChainDepth: e.target.value ? parseInt(e.target.value) : undefined },
                          })}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Output Format</Label>
                        <Select
                          value={agentCollaboration.rules?.outputFormat || ''}
                          onValueChange={(v: any) => setAgentCollaboration({
                            ...agentCollaboration,
                            rules: { ...agentCollaboration.rules, outputFormat: v || undefined },
                          })}
                        >
                          <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="text">Text</SelectItem>
                            <SelectItem value="json">JSON</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Escalation</Label>
                        <Select
                          value={agentCollaboration.rules?.escalation || ''}
                          onValueChange={(v: any) => setAgentCollaboration({
                            ...agentCollaboration,
                            rules: { ...agentCollaboration.rules, escalation: v || undefined },
                          })}
                        >
                          <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="never">Never</SelectItem>
                            <SelectItem value="on_failure">On Failure</SelectItem>
                            <SelectItem value="on_low_confidence">On Low Confidence</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {agentCollaboration.strategy === 'parallel' && (
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Conflict Resolution</Label>
                        <Select
                          value={agentCollaboration.rules?.conflictResolution || ''}
                          onValueChange={(v: any) => setAgentCollaboration({
                            ...agentCollaboration,
                            rules: { ...agentCollaboration.rules, conflictResolution: v || undefined },
                          })}
                        >
                          <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="judge">Judge decides</SelectItem>
                            <SelectItem value="majority">Majority wins</SelectItem>
                            <SelectItem value="first_wins">First wins</SelectItem>
                            <SelectItem value="merge">Merge all</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={agentCollaboration.rules?.sharedMemoryScope ?? false}
                          onChange={(e) => setAgentCollaboration({
                            ...agentCollaboration,
                            rules: { ...agentCollaboration.rules, sharedMemoryScope: e.target.checked },
                          })}
                          className="rounded"
                        />
                        <span className="text-xs">Shared Memory</span>
                      </label>
                      {agentCollaboration.strategy === 'sequential' && (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={agentCollaboration.rules?.allowRevision ?? false}
                            onChange={(e) => setAgentCollaboration({
                              ...agentCollaboration,
                              rules: { ...agentCollaboration.rules, allowRevision: e.target.checked },
                            })}
                            className="rounded"
                          />
                          <span className="text-xs">Allow Revision</span>
                        </label>
                      )}
                    </div>
                  </div>

                  {(agentCollaboration.strategy === 'debate' || agentCollaboration.strategy === 'parallel') && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-sm">Judge Agent</Label>
                        <Select value={agentCollaboration.judgeAgentId || ''} onValueChange={(v) => setAgentCollaboration({ ...agentCollaboration, judgeAgentId: v })}>
                          <SelectTrigger><SelectValue placeholder="Select judge" /></SelectTrigger>
                          <SelectContent>
                            {availableAgents.map((a: any) => (
                              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {agentCollaboration.strategy === 'debate' && (
                        <div className="space-y-2">
                          <Label className="text-sm">Max Rounds</Label>
                          <Input
                            type="number"
                            min={1}
                            max={10}
                            value={agentCollaboration.maxRounds ?? 3}
                            onChange={(e) => setAgentCollaboration({ ...agentCollaboration, maxRounds: parseInt(e.target.value) })}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Heartbeat</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agentHeartbeat.enabled}
                  onChange={(e) => setAgentHeartbeat({ ...agentHeartbeat, enabled: e.target.checked })}
                  className="rounded"
                />
                <div>
                  <p className="text-sm font-medium">Enable Heartbeat</p>
                  <p className="text-xs text-muted-foreground">Agent wakes up periodically to check conditions or process tasks</p>
                </div>
              </label>

              {agentHeartbeat.enabled && (
                <div className="space-y-4 pt-2">
                  <div className="space-y-2">
                    <Label className="text-sm">Interval (minutes)</Label>
                    <Input
                      type="number"
                      min={1}
                      value={agentHeartbeat.intervalMinutes}
                      onChange={(e) => setAgentHeartbeat({ ...agentHeartbeat, intervalMinutes: parseInt(e.target.value) || 60 })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm">Heartbeat Prompt</Label>
                    <Textarea
                      value={agentHeartbeat.prompt}
                      onChange={(e) => setAgentHeartbeat({ ...agentHeartbeat, prompt: e.target.value })}
                      placeholder="Check my inbox for new messages. If there are urgent items, summarize them."
                      className="min-h-[100px] font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">What the agent should do on each heartbeat wake-up.</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="h-8" /> {/* Bottom spacer */}
        </div>
      ) : (
        <CanvasArea
          nodes={pipeline.nodes}
          edges={pipeline.edges}
          onNodesChange={pipeline.onNodesChange}
          onEdgesChange={pipeline.onEdgesChange}
          onConnect={pipeline.onConnect}
          onNodeClick={pipeline.onNodeClick}
          onPaneClick={pipeline.onPaneClick}
          onDrop={pipeline.onDrop}
          onDragOver={pipeline.onDragOver}
          reactFlowWrapper={pipeline.reactFlowWrapper}
          setReactFlowInstance={pipeline.setReactFlowInstance}
          selectedNode={pipeline.selectedNode}
          setSelectedNode={pipeline.setSelectedNode}
          onUpdateNode={pipeline.onUpdateNode}
          onDeleteNode={pipeline.onDeleteNode}
        />
      )}

      {/* Test Panel */}
      {showTestPanel && isEditing && agentMode === 'workflow' && (
        <TestPanel
          agentId={id!}
          onClose={() => setShowTestPanel(false)}
        />
      )}
    </div>
  )
}
