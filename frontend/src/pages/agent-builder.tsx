import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, ListChecks } from 'lucide-react'

import { QueryError } from '@/components/ui/query-error'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

import { useAgentPipeline } from '@/components/agents/builder/use-agent-pipeline'
import { BuilderToolbar } from '@/components/agents/builder/builder-toolbar'
import { TestPanel } from '@/components/agents/builder/test-panel'
import { CanvasArea } from '@/components/agents/builder/canvas-area'
import { AutonomousConfig } from '@/components/agents/builder/autonomous-config'
import { modelsFromAgent, modelsPayload, modelsProblems, newAgentModels } from '@/components/agents/builder/agent-models'
import { workflowIssues, type BuilderIssue, type GraphNode, type GraphEdge } from '@/components/agents/builder/validate-graph'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'

import { agentsApi, toolsApi } from '@/lib/api'
import { captureEvent } from '@/lib/analytics'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import type { Agent, AgentModels, PipelineNode, PipelineEdge } from '@/types'
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
  // An autonomous agent's roles and strategy. A new agent starts with one
  // Main role, no model chosen yet, running Single.
  const [agentModels, setAgentModels] = useState<AgentModels>(newAgentModels)
  const [agentMemoryConfig, setAgentMemoryConfig] = useState<{ enabled?: boolean; autoSave?: boolean }>({ enabled: false, autoSave: false })
  const [agentConfig, setAgentConfig] = useState<{ canCallAgents?: boolean; canCreateAgents?: boolean }>({ canCallAgents: false, canCreateAgents: false })

  const [showTestPanel, setShowTestPanel] = useState(false)
  const [agentVisibility, setAgentVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [showVisibility, setShowVisibility] = useState(false)

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

  // Fetch available agents: a panelist or teammate role can be another agent
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
      setAgentModels(modelsFromAgent(agent))
      setAgentMemoryConfig(agent.memoryConfig || { enabled: false, autoSave: false })
      setAgentConfig(agent.agentConfig || { canCallAgents: false, canCreateAgents: false })
      setAgentVisibility({ visibility: agent.visibility ?? 'org', teamId: agent.teamId ?? null })
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
  const validationIssues = useMemo(() => {
    const errors: BuilderIssue[] = []

    if (!agentName.trim()) {
      errors.push({ text: 'Name the agent', nodeIds: [] })
    }

    if (agentMode === 'workflow') {
      errors.push(
        ...workflowIssues(pipeline.nodes as GraphNode[], pipeline.edges as GraphEdge[], {
          // An organization default makes a bare Model Call node legitimate:
          // the engine resolves it, and the server's validator never had an
          // llm_call rule to begin with.
          hasDefaultRouting: Boolean(currentOrganization?.settings?.defaultRouting),
        }),
      )
    } else {
      // Autonomous mode validation
      if (!agentInstructions.trim()) {
        errors.push({ text: 'Write the instructions', nodeIds: [] })
      }
      errors.push(...modelsProblems(agentModels).map((text) => ({ text, nodeIds: [] })))
    }

    return errors
  }, [agentName, agentMode, agentInstructions, agentModels, pipeline.nodes, pipeline.edges, currentOrganization?.settings?.defaultRouting])

  const validationErrors = useMemo(() => validationIssues.map((issue) => issue.text), [validationIssues])

  const canSave = validationErrors.length === 0

  // ── When the remaining steps become errors ──────────────────────────────
  //
  // A brand-new draft opened red: untouched fields reported as failures
  // before the user had done anything. A blank form has not failed
  // validation, it has not been filled in yet, and red on first paint is how
  // people learn to ignore red, which costs us the banners that are real.
  //
  // So the same list is shown in a neutral, forward-looking voice until the
  // user has either been in one of these fields or pressed Save. Nothing
  // about the rule changes: canSave still gates the mutation, and Save still
  // refuses and still explains.
  const [saveAttempted, setSaveAttempted] = useState(false)

  // An agent loaded from the server is not a blank draft: whatever is wrong
  // with it is wrong with saved data, and worth saying plainly at once.
  const draftTouched = useMemo(() => {
    const signals = [
      agentName !== 'New Agent',
      agentDescription.trim() !== '',
      agentInstructions.trim() !== '',
      agentPersonality.trim() !== '',
      // Anything beyond the starting Main role with no model chosen.
      agentModels.strategy !== 'single' ||
        agentModels.roles.length !== 1 ||
        agentModels.roles.some((r) => Boolean(r.providerId || r.routing || r.agentId)),
      agentToolIds.length > 0,
      // The first history entry is the starting graph, so this only turns
      // true once a node or an edge has actually been changed.
      pipeline.canUndo,
    ]
    return signals.some(Boolean)
  }, [
    agentName,
    agentDescription,
    agentInstructions,
    agentPersonality,
    agentModels,
    agentToolIds.length,
    pipeline.canUndo,
  ])

  const showValidationErrors = isEditing || saveAttempted || draftTouched

  // An item about a step takes the user to it: selecting the node opens its
  // settings, which is where the fix is, and the view centres on it. With
  // two Model Calls, this -- not a node id in the text -- is how the user
  // learns which one the item means.
  const goToIssue = useCallback(
    (issue: BuilderIssue) => {
      const node = pipeline.nodes.find((n) => n.id === issue.nodeIds[0])
      if (!node) return
      pipeline.setSelectedNode(node)
      pipeline.reactFlowInstance?.fitView({
        nodes: issue.nodeIds.map((id) => ({ id })),
        padding: 0.6,
        maxZoom: 1.2,
        duration: 300,
      })
    },
    [pipeline.nodes, pipeline.setSelectedNode, pipeline.reactFlowInstance],
  )

  // Outline the steps the list is about, once the list is shown as errors.
  // A fresh draft stays calm: its steps are a to-do list, not a failure.
  const canvasNodes = useMemo(() => {
    if (!showValidationErrors) return pipeline.nodes
    const flagged = new Set(validationIssues.flatMap((issue) => issue.nodeIds))
    if (!flagged.size) return pipeline.nodes
    return pipeline.nodes.map((node) =>
      flagged.has(node.id)
        ? {
            ...node,
            className: [node.className, 'rounded-xl ring-2 ring-destructive ring-offset-2 ring-offset-background']
              .filter(Boolean)
              .join(' '),
          }
        : node,
    )
  }, [pipeline.nodes, validationIssues, showValidationErrors])

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
        // Sent on every save: 'private' makes the agent the saver's alone,
        // and an edit must not quietly reset an existing scope.
        visibility: agentVisibility.visibility,
        teamId: agentVisibility.teamId,
      }

      if (agentMode === 'workflow') {
        payload.pipeline = buildPipeline()
      } else {
        // Autonomous mode -- save instructions + soul + heartbeat + tools + models
        payload.personality = agentPersonality || undefined
        payload.instructions = agentInstructions
        payload.heartbeat = agentHeartbeat.enabled ? agentHeartbeat : { enabled: false, intervalMinutes: agentHeartbeat.intervalMinutes, prompt: agentHeartbeat.prompt }
        payload.toolIds = agentToolIds
        payload.memoryConfig = agentMemoryConfig
        payload.agentConfig = agentConfig
        // The roles and their strategy are the source of truth for which
        // models run; the server mirrors the main role into modelConfig.
        // Collaboration is what the roles replaced, so it is cleared.
        payload.models = modelsPayload(agentModels)
        payload.collaboration = null
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
      // A refused save is the moment the remaining steps become errors, and
      // it still says which. The button only greys out once they are on
      // screen, so there is always a way to ask and always an answer.
      setSaveAttempted(true)
      errorNotif('Not ready to save yet', validationErrors.join(' · '))
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
        saveDisabled={!canSave && showValidationErrors}
        isSaving={saveMutation.isPending}
        onSave={handleSave}
        onExport={handleExport}
        onBack={() => navigate('/agents')}
        visibility={agentVisibility.visibility}
        visibilityOpen={showVisibility}
        onVisibilityClick={() => setShowVisibility((open) => !open)}
      />

      {/*
        One list, two voices. On an untouched new draft these are the steps
        that are left, drawn like any other hint on the page; once the user
        has been in a field or pressed Save they are errors, and the styling
        says so. Both render the same strings, so nothing is hidden either
        way and Save is gated by canSave in both.
      */}
      {validationErrors.length > 0 && (
        showValidationErrors ? (
          <div
            data-testid="builder-validation-errors"
            role="alert"
            className="px-4 py-2 bg-destructive/10 border-b border-destructive/20 shrink-0"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              {/* Capped: mirroring the server means a badly wired graph can
                  report several problems at once, and an uncapped list pushed
                  the canvas off the screen. */}
              <ul className="text-xs text-destructive space-y-0.5 max-h-24 overflow-y-auto">
                {validationIssues.map((issue, i) => (
                  <li key={i}>
                    {issue.nodeIds.length ? (
                      <button
                        type="button"
                        onClick={() => goToIssue(issue)}
                        className="text-left underline-offset-2 hover:underline"
                      >
                        {issue.text}
                      </button>
                    ) : (
                      issue.text
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <div
            data-testid="builder-next-steps"
            className="px-4 py-2 bg-muted/50 border-b border-border shrink-0"
          >
            <div className="flex items-start gap-2">
              <ListChecks className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  To finish this agent
                </p>
                <ul className="text-xs text-muted-foreground space-y-0.5 max-h-24 overflow-y-auto mt-0.5">
                  {validationIssues.map((issue, i) => (
                  <li key={i}>
                    {issue.nodeIds.length ? (
                      <button
                        type="button"
                        onClick={() => goToIssue(issue)}
                        className="text-left underline-offset-2 hover:underline"
                      >
                        {issue.text}
                      </button>
                    ) : (
                      issue.text
                    )}
                  </li>
                ))}
                </ul>
              </div>
            </div>
          </div>
        )
      )}

      {/*
        Who can see and use the agent, opened from the toolbar. Inline under
        the toolbar rather than in a dialog so the canvas stays in view.
      */}
      {showVisibility && (
        <div
          id="agent-visibility-panel"
          role="region"
          aria-label="Agent visibility"
          className="px-4 py-3 border-b bg-background shrink-0"
        >
          <VisibilityField
            organizationId={currentOrganization?.id ?? ''}
            value={agentVisibility}
            onChange={setAgentVisibility}
            noun="this agent"
          />
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
          models={agentModels}
          onModelsChange={setAgentModels}
          toolIds={agentToolIds}
          onToolIdsChange={setAgentToolIds}
          tools={availableTools}
          memoryConfig={agentMemoryConfig}
          onMemoryConfigChange={setAgentMemoryConfig}
          agentConfig={agentConfig}
          onAgentConfigChange={setAgentConfig}
          availableAgents={availableAgents}
          heartbeat={agentHeartbeat}
          onHeartbeatChange={setAgentHeartbeat}
        />
      ) : (
        <CanvasArea
          // Restores the position the graph was saved at. buildPipeline has
          // always written this and nothing read it back.
          savedViewport={agentData?.pipeline?.viewport}
          nodes={canvasNodes}
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
