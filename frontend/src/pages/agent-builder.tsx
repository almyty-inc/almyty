import React, { useState, useCallback, useRef, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowLeft, Save, Loader2, Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

import { NodePalette } from '@/components/agents/node-palette'
import { NodeConfigPanel } from '@/components/agents/node-config-panel'
import { nodeTypes, type PipelineNodeType } from '@/components/agents/nodes'
import { agentsApi } from '@/lib/api'
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

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([] as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([] as Edge[])
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [initialized, setInitialized] = useState(false)

  // Fetch existing agent when editing
  const { data: agentData, isLoading: isLoadingAgent } = useQuery({
    queryKey: ['agent', id],
    queryFn: async () => {
      const res = await agentsApi.getById(id!)
      return res.data?.data || res.data
    },
    enabled: isEditing,
  })

  // Fetch templates for template-based creation
  const { data: templatesData } = useQuery({
    queryKey: ['agent-templates'],
    queryFn: async () => {
      const res = await agentsApi.getTemplates()
      return res.data?.data || []
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
      const pipeline = buildPipeline()
      if (isEditing) {
        return agentsApi.update(id!, {
          name: agentName,
          description: agentDescription || undefined,
          pipeline,
        })
      } else {
        return agentsApi.create({
          name: agentName,
          description: agentDescription || undefined,
          pipeline,
        }, currentOrganization?.id)
      }
    },
    onSuccess: async (res) => {
      success('Saved', `Agent "${agentName}" saved successfully.`)
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      if (!isEditing) {
        const newAgent = res.data?.data || res.data
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
      <div className="flex items-center justify-between px-4 py-2 border-b bg-background shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/agents')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Input
            className="text-lg font-semibold border-none shadow-none focus-visible:ring-0 w-[260px] px-1"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="Agent name"
          />
          <Badge variant={agentStatus === 'active' ? 'default' : agentStatus === 'error' ? 'destructive' : 'outline'}>
            {agentStatus}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {isEditing && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const res = await agentsApi.exportAgent(id!)
                  const exportData = res.data?.data || res.data
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
            <Badge variant="outline" className="text-xs">
              v{(agentData as Agent).version || '1.0.0'}
            </Badge>
          )}
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save
          </Button>
        </div>
      </div>

      {/* Three-panel Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Palette */}
        <NodePalette />

        {/* Center: Canvas */}
        <div className="flex-1" ref={reactFlowWrapper}>
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
          </ReactFlow>
        </div>

        {/* Right: Config Panel */}
        {selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            nodes={nodes}
            onUpdateNode={onUpdateNode}
            onDeleteNode={onDeleteNode}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </div>
    </div>
  )
}
