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
import { QueryError } from '@/components/ui/query-error'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { useAgentPipeline } from '@/components/agents/builder/use-agent-pipeline'
import { BuilderToolbar } from '@/components/agents/builder/builder-toolbar'
import { TestPanel } from '@/components/agents/builder/test-panel'
import { CanvasArea } from '@/components/agents/builder/canvas-area'
import { AutonomousConfig } from '@/components/agents/builder/autonomous-config'
import { validateWorkflowGraph, type GraphNode, type GraphEdge } from '@/components/agents/builder/validate-graph'

import { agentsApi, llmProvidersApi, toolsApi } from '@/lib/api'
import { captureEvent } from '@/lib/analytics'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import type { Agent, PipelineNode, PipelineEdge } from '@/types'
import { getApiErrorMessage } from '@/lib/api-error'

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
  const {
    data: agentData,
    isLoading: isLoadingAgent,
    isError: agentError,
    error: agentErrorValue,
    refetch: refetchAgent,
  } = useQuery({
    queryKey: ['agent', id],
    queryFn: () => agentsApi.getById(id!),
    enabled: isEditing,
  })

  // Under the ['tools'] prefix, so a tool created or deleted on the
  // tools page (which invalidates ['tools']) shows up here. This used
  // to be a key of its own -- ['tools-list', orgId] -- that nothing
  // invalidated, so a tool created with the toast "ready to assign to
  // a gateway" was missing from this picker.
  const { data: rawTools } = useQuery({
    queryKey: ['tools', currentOrganization?.id, 'all'],
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
  // The graph rules live in validateWorkflowGraph, which mirrors the server's
  // AgentValidationHelper: everything it reports is a reason the save would
  // 400 anyway, so it costs no valid graph a save and earns the user the
  // answer before the round trip instead of after it.
  const validationErrors = useMemo(() => {
    const errors: string[] = []

    if (!agentName.trim()) {
      errors.push('Agent name is required')
    }

    if (agentMode === 'workflow') {
      errors.push(...validateWorkflowGraph(pipeline.nodes as GraphNode[], pipeline.edges as GraphEdge[]))
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
  }, [agentName, agentMode, agentInstructions, agentModelConfig, pipeline.nodes, pipeline.edges])

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
        captureEvent('agent_created')
        const newAgent = res
        if (newAgent?.id) {
          navigate(`/agents/${newAgent.id}/edit`, { replace: true })
        }
      } else {
        await queryClient.invalidateQueries({ queryKey: ['agent', id] })
      }
    },
    onError: (err: any) => {
      errorNotif('Save Failed', getApiErrorMessage(err, 'Failed to save agent'))
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

  // An agent that no longer exists.
  //
  // The init effect only runs when `agentData` is present, and its other
  // branches are for the create path, so a 404 left the canvas empty,
  // the name field blank and a validation banner up -- with nothing
  // saying the agent was gone, and Save still PATCHing an id that is not
  // there. The detail page already guards this; the builder did not.
  if (isEditing && agentError) {
    return (
      <div className="p-6">
        <QueryError
          error={agentErrorValue}
          onRetry={() => refetchAgent()}
          title="Couldn't open that agent"
        />
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
            {/* Capped: mirroring the server means a badly wired graph can
                report several problems at once, and an uncapped list pushed
                the canvas off the screen. */}
            <ul className="text-xs text-destructive space-y-0.5 max-h-24 overflow-y-auto">
              {validationErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Main content: Workflow pipeline or Autonomous config */}
      {agentMode === 'autonomous' ? (
        <AutonomousConfig
          agentId={id}
          personality={agentPersonality}
          onPersonalityChange={setAgentSoul}
          instructions={agentInstructions}
          onInstructionsChange={setAgentInstructions}
          modelConfig={agentModelConfig}
          onModelConfigChange={setAgentModelConfig}
          providers={availableProviders}
          toolIds={agentToolIds}
          onToolIdsChange={setAgentToolIds}
          tools={availableTools}
          memoryConfig={agentMemoryConfig}
          onMemoryConfigChange={setAgentMemoryConfig}
          agentConfig={agentConfig}
          onAgentConfigChange={setAgentConfig}
          collaboration={agentCollaboration}
          onCollaborationChange={setAgentCollaboration}
          availableAgents={availableAgents}
          heartbeat={agentHeartbeat}
          onHeartbeatChange={setAgentHeartbeat}
        />
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
