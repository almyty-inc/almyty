import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowLeft, Save, Loader2, Download, AlertTriangle, Plus, X, Undo2, Redo2, Play, ChevronUp, ChevronDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CodeEditor } from '@/components/ui/code-editor'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { ErrorBoundary } from '@/components/ui/error-boundary'

import { NodePalette } from '@/components/agents/node-palette'
import { NodeConfigPanel } from '@/components/agents/node-config-panel'
import { nodeTypes, type PipelineNodeType } from '@/components/agents/nodes'
import { agentsApi, llmProvidersApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { cn } from '@/lib/utils'
import type { Agent, PipelineNode, PipelineEdge } from '@/types'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const DEFAULT_PIPELINE_NODES: PipelineNode[] = [
  { id: 'input_1', type: 'input', position: { x: 50, y: 200 }, data: { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } },
  { id: 'llm_1', type: 'llm_call', position: { x: 350, y: 200 }, data: { userPromptTemplate: '{{input.message}}' } },
  { id: 'output_1', type: 'output', position: { x: 650, y: 200 }, data: { mapping: '{{nodes.llm_1.output}}' } },
]

const DEFAULT_PIPELINE_EDGES: PipelineEdge[] = [
  { id: 'e1', source: 'input_1', target: 'llm_1' },
  { id: 'e2', source: 'llm_1', target: 'output_1' },
]

let idCounter = 0
function generateNodeId(type: string): string {
  idCounter++
  return `${type}_${Date.now()}_${idCounter}`
}

function getDefaultData(type: PipelineNodeType): Record<string, any> {
  switch (type) {
    case 'input':
      return { schema: { type: 'object', properties: {}, required: [] } }
    case 'output':
      return { mapping: '' }
    case 'llm_call':
      return { providerId: '', model: '', systemPrompt: '', userPromptTemplate: '', temperature: 0.7 }
    case 'tool_call':
      return { toolId: '', toolName: '', parameterMapping: [] }
    case 'condition':
      return { expression: '' }
    case 'transform':
      return { expression: '' }
    case 'merge':
      return { strategy: 'first_response' }
    case 'parallel':
      return {}
    case 'sub_agent':
      return { agentId: '', agentName: '', inputMapping: [] }
    case 'loop':
      return { iterableExpression: '', maxIterations: 100 }
    default:
      return {}
  }
}

export function AgentBuilderPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()

  const isEditing = !!id
  const templateId = searchParams.get('template')
  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)

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

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([] as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([] as Edge[])
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [showMobilePalette, setShowMobilePalette] = useState(false)
  const [showTestPanel, setShowTestPanel] = useState(false)
  const [testInput, setTestInput] = useState('{"message": "Hello"}')
  const [testOutput, setTestOutput] = useState<string | null>(null)
  const [testLoading, setTestLoading] = useState(false)

  // ── Undo / Redo history ───────────────────────────────────────────────
  const [history, setHistory] = useState<{ nodes: Node[]; edges: Edge[] }[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const isUndoRedoRef = useRef(false)

  const pushHistory = useCallback((newNodes: Node[], newEdges: Edge[]) => {
    if (isUndoRedoRef.current) return
    const snapshot = {
      nodes: newNodes.map((n) => ({ ...n, data: { ...n.data } })),
      edges: newEdges.map((e) => ({ ...e })),
    }
    setHistoryIndex((prevIndex) => {
      setHistory((prev) => {
        const truncated = prev.slice(0, prevIndex + 1)
        const next = [...truncated, snapshot]
        // Keep max 50 snapshots
        if (next.length > 50) next.shift()
        return next
      })
      const newIndex = Math.min(prevIndex + 1, 49)
      return newIndex
    })
  }, [])

  const canUndo = historyIndex > 0
  const canRedo = historyIndex < history.length - 1

  const undo = useCallback(() => {
    if (!canUndo) return
    isUndoRedoRef.current = true
    const prev = history[historyIndex - 1]
    setNodes(prev.nodes.map((n) => ({ ...n, data: { ...n.data } })))
    setEdges(prev.edges.map((e) => ({ ...e })))
    setHistoryIndex((i) => i - 1)
    setSelectedNode(null)
    requestAnimationFrame(() => { isUndoRedoRef.current = false })
  }, [canUndo, history, historyIndex, setNodes, setEdges])

  const redo = useCallback(() => {
    if (!canRedo) return
    isUndoRedoRef.current = true
    const next = history[historyIndex + 1]
    setNodes(next.nodes.map((n) => ({ ...n, data: { ...n.data } })))
    setEdges(next.edges.map((e) => ({ ...e })))
    setHistoryIndex((i) => i + 1)
    setSelectedNode(null)
    requestAnimationFrame(() => { isUndoRedoRef.current = false })
  }, [canRedo, history, historyIndex, setNodes, setEdges])

  const runTest = async () => {
    if (!id) return
    setTestLoading(true)
    setTestOutput(null)
    try {
      const input = JSON.parse(testInput)
      const result = await agentsApi.invoke(id, input)
      setTestOutput(JSON.stringify(result, null, 2))
    } catch (err: any) {
      setTestOutput(`Error: ${err?.response?.data?.message || err?.message || 'Execution failed'}`)
    } finally {
      setTestLoading(false)
    }
  }

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (mod && e.key === 'z' && e.shiftKey) {
        e.preventDefault()
        redo()
      } else if (mod && e.key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undo, redo])

  // Push to history whenever nodes/edges change (debounced via a stable ref)
  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!initialized) return
    if (isUndoRedoRef.current) return
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current)
    historyTimerRef.current = setTimeout(() => {
      pushHistory(nodes, edges)
    }, 300)
    return () => {
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current)
    }
    // Only fire when nodes or edges actually change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, initialized])

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
    if (initialized) return

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
      setNodes(pipelineNodes)
      setEdges(pipelineEdges)
      setInitialized(true)
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
        setNodes(pipelineNodes)
        setEdges(pipelineEdges)
        setInitialized(true)
      }
    } else if (!isEditing && !templateId) {
      setNodes(DEFAULT_PIPELINE_NODES.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
      })))
      setEdges(DEFAULT_PIPELINE_EDGES.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })))
      setInitialized(true)
    }
  }, [isEditing, agentData, initialized, setNodes, setEdges, templateId, templatesData])

  // Connect edges
  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, id: `e_${Date.now()}` }, eds))
    },
    [setEdges]
  )

  // Handle node selection
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node)
  }, [])

  // Deselect when clicking on pane
  const onPaneClick = useCallback(() => {
    setSelectedNode(null)
  }, [])

  // Update node data from config panel
  const onUpdateNode = useCallback(
    (nodeId: string, data: Record<string, any>) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === nodeId) {
            const updated = { ...n, data }
            // Keep selectedNode in sync
            setSelectedNode(updated)
            return updated
          }
          return n
        })
      )
    },
    [setNodes]
  )

  // Delete node
  const onDeleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId))
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
      setSelectedNode(null)
    },
    [setNodes, setEdges]
  )

  // Drag-and-drop from palette
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const type = event.dataTransfer.getData('application/reactflow') as PipelineNodeType
      if (!type || !reactFlowInstance) return

      // screenToFlowPosition expects raw screen coordinates — no manual offset needed
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      const newNode: Node = {
        id: generateNodeId(type),
        type,
        position,
        data: getDefaultData(type),
      }

      setNodes((nds) => [...nds, newNode])
    },
    [reactFlowInstance, setNodes]
  )

  // ── Validation ──────────────────────────────────────────────────────────
  const validationErrors = useMemo(() => {
    const errors: string[] = []

    if (!agentName.trim()) {
      errors.push('Agent name is required')
    }

    if (agentMode === 'workflow') {
      const hasInput = nodes.some((n) => n.type === 'input')
      const hasOutput = nodes.some((n) => n.type === 'output')
      if (!hasInput) {
        errors.push('Pipeline must have at least one Input node')
      }
      if (!hasOutput) {
        errors.push('Pipeline must have at least one Output node')
      }

      // Check that all LLM call nodes have a provider selected
      const llmNodes = nodes.filter((n) => n.type === 'llm_call')
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
  }, [agentName, agentMode, agentInstructions, agentModelConfig, nodes])

  const canSave = validationErrors.length === 0

  // Build pipeline payload
  const buildPipeline = () => {
    const viewport = reactFlowInstance?.getViewport()
    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type as PipelineNode['type'],
        position: n.position,
        data: n.data as Record<string, any>,
      })),
      edges: edges.map((e) => ({
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
        // Autonomous mode — save instructions + soul + heartbeat + tools + model config
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
            rules: agentCollaboration.rules && Object.values(agentCollaboration.rules).some(v => v !== undefined && v !== null && v !== '')
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
      <div className="flex items-center justify-between px-2 sm:px-4 py-2 border-b bg-background shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-1 sm:gap-3 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => navigate('/agents')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Input
            className="text-base sm:text-lg font-semibold border-none shadow-none focus-visible:ring-0 w-[140px] sm:w-[260px] px-1"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="Agent name"
          />
          <Badge variant={agentStatus === 'active' ? 'success' : agentStatus === 'error' ? 'destructive' : 'outline'} className="hidden sm:inline-flex">
            {agentStatus}
          </Badge>
          <div className="hidden sm:flex items-center gap-1 ml-2 bg-muted rounded-md p-0.5">
            <button
              className={cn('px-2 py-1 text-xs rounded font-medium transition-colors', agentMode === 'workflow' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => setAgentMode('workflow')}
            >
              Workflow
            </button>
            <button
              className={cn('px-2 py-1 text-xs rounded font-medium transition-colors', agentMode === 'autonomous' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground')}
              onClick={() => setAgentMode('autonomous')}
            >
              Autonomous
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={undo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={redo}
            disabled={!canRedo}
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="h-4 w-4" />
          </Button>
          {isEditing && (
            <Button
              variant="outline"
              size="sm"
              className="hidden sm:flex"
              onClick={async () => {
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
              }}
            >
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          )}
          {isEditing && agentData && (
            <Badge variant="outline" className="text-xs hidden sm:inline-flex">
              v{(agentData as Agent).version || '1.0.0'}
            </Badge>
          )}
          {isEditing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowTestPanel(!showTestPanel)}
            >
              <Play className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Test</span>
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => {
              if (!canSave) {
                errorNotif('Validation Failed', validationErrors.join('. '))
                return
              }
              saveMutation.mutate()
            }}
            disabled={saveMutation.isPending || !canSave}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 sm:mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 sm:mr-2" />
            )}
            <span className="hidden sm:inline">Save</span>
          </Button>
        </div>
      </div>

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
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {availableTools.map((tool: any) => (
                  <label key={tool.id} className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={agentToolIds.includes(tool.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setAgentToolIds([...agentToolIds, tool.id])
                        } else {
                          setAgentToolIds(agentToolIds.filter((id) => id !== tool.id))
                        }
                      }}
                      className="rounded"
                    />
                    <div>
                      <p className="text-sm font-medium">{tool.name}</p>
                      {tool.description && <p className="text-xs text-muted-foreground">{tool.description}</p>}
                    </div>
                  </label>
                ))}
                {availableTools.length === 0 && (
                  <p className="text-sm text-muted-foreground py-4 text-center">No tools available. Create tools first.</p>
                )}
              </div>
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
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left: Palette — visible on lg+, hidden on mobile */}
        <div className="hidden lg:block">
          <NodePalette />
        </div>

        {/* Mobile: floating add button to open palette dropdown */}
        <div className="lg:hidden fixed bottom-4 right-4 z-50">
          <Button
            onClick={() => setShowMobilePalette(!showMobilePalette)}
            size="icon"
            className="rounded-full shadow-lg h-12 w-12"
          >
            {showMobilePalette ? <X className="h-6 w-6" /> : <Plus className="h-6 w-6" />}
          </Button>
        </div>

        {/* Mobile: palette dropdown */}
        {showMobilePalette && (
          <div className="lg:hidden fixed bottom-20 right-4 z-50 w-[220px] max-h-[60vh] overflow-y-auto rounded-lg border bg-background shadow-xl">
            <NodePalette />
          </div>
        )}

        {/* Center: Canvas */}
        <div className="flex-1" ref={reactFlowWrapper}>
          <ErrorBoundary
            fallback={
              <div className="flex items-center justify-center h-full bg-muted/20">
                <div className="text-center p-8">
                  <p className="text-sm font-medium text-destructive">Canvas rendering error</p>
                  <p className="text-xs text-muted-foreground mt-1">A node may have invalid data. Try removing recently added nodes.</p>
                </div>
              </div>
            }
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              onInit={setReactFlowInstance}
              onDrop={onDrop}
              onDragOver={onDragOver}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              deleteKeyCode={['Backspace', 'Delete']}
              className="bg-muted/20"
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} size={1} />
              <Controls />
              {/* In-app help overlay for empty/fresh canvas */}
              {nodes.length <= 3 && !selectedNode && (
                <Panel position="top-center" className="bg-background/80 backdrop-blur-sm rounded-lg p-4 text-center max-w-md">
                  <p className="text-sm text-muted-foreground">
                    Drag node types from the left panel onto the canvas.
                    Connect them by dragging from output handles (right) to input handles (left).
                    Click a node to configure it.
                  </p>
                </Panel>
              )}
            </ReactFlow>
          </ErrorBoundary>
        </div>

        {/* Right: Config Panel — sidebar on lg+, overlay on mobile */}
        {selectedNode && (
          <div className={cn(
            'lg:w-[320px] lg:relative lg:border-l lg:z-auto',
            'fixed inset-0 z-50 bg-background lg:static lg:inset-auto',
          )}>
            {/* Mobile overlay backdrop close button */}
            <div className="lg:hidden absolute top-2 right-2 z-10">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelectedNode(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <NodeConfigPanel
              node={selectedNode}
              nodes={nodes}
              onUpdateNode={onUpdateNode}
              onDeleteNode={onDeleteNode}
              onClose={() => setSelectedNode(null)}
            />
          </div>
        )}
      </div>
      )}

      {/* Test Panel */}
      {showTestPanel && isEditing && agentMode === 'workflow' && (
        <div className="border-t bg-muted/30 shrink-0">
          <div className="flex items-center justify-between px-4 py-2 border-b">
            <span className="text-sm font-semibold">Test Agent</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowTestPanel(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex gap-4 p-4 max-h-[250px]">
            <div className="flex-1 space-y-2">
              <Label className="text-xs">Input JSON</Label>
              <CodeEditor
                value={testInput}
                onChange={(value) => setTestInput(value)}
                language="json"
                height="140px"
                placeholder='{"message": "Hello"}'
              />
              <Button size="sm" onClick={runTest} disabled={testLoading}>
                {testLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                Run
              </Button>
            </div>
            <div className="flex-1 space-y-2">
              <Label className="text-xs">Output</Label>
              <pre className="font-mono text-xs bg-background border rounded-md p-3 h-[170px] overflow-auto whitespace-pre-wrap">
                {testOutput || 'Run the agent to see output...'}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
