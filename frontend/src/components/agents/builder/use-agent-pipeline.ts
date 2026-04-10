/**
 * Core state machine for the agent pipeline DAG: nodes, edges, undo/redo,
 * and all node CRUD operations. Extracted from agent-builder.tsx to isolate
 * the ReactFlow state logic from presentation concerns.
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import {
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react'
import type { PipelineNodeType } from '@/components/agents/nodes'

// ── Helpers ──────────────────────────────────────────────────────────────────

let idCounter = 0
function generateNodeId(type: string): string {
  idCounter++
  return `${type}_${Date.now()}_${idCounter}`
}

export function getDefaultData(type: PipelineNodeType): Record<string, any> {
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

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAgentPipeline() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([] as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([] as Edge[])
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [initialized, setInitialized] = useState(false)

  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null)

  // ── Undo / Redo history ─────────────────────────────────────────────────
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

  // ── Edge connection ─────────────────────────────────────────────────────
  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, id: `e_${Date.now()}` }, eds))
    },
    [setEdges]
  )

  // ── Node selection ──────────────────────────────────────────────────────
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node)
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedNode(null)
  }, [])

  // ── Node CRUD ───────────────────────────────────────────────────────────
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

  const onDeleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId))
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
      setSelectedNode(null)
    },
    [setNodes, setEdges]
  )

  // ── Drag-and-drop from palette ──────────────────────────────────────────
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

  return {
    // Nodes & edges state
    nodes,
    setNodes,
    edges,
    setEdges,
    onNodesChange,
    onEdgesChange,
    onConnect,

    // Selection
    selectedNode,
    setSelectedNode,
    onNodeClick,
    onPaneClick,

    // Node CRUD
    onUpdateNode,
    onDeleteNode,

    // Drag-and-drop
    onDragOver,
    onDrop,
    reactFlowWrapper,
    reactFlowInstance,
    setReactFlowInstance,

    // Initialization
    initialized,
    setInitialized,

    // Undo / Redo
    canUndo,
    canRedo,
    undo,
    redo,
  }
}
