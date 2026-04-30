/**
 * ReactFlow canvas wrapper for the workflow pipeline editor. Renders the
 * node graph, background grid, controls, help overlay, node palette
 * (desktop sidebar + mobile floating button), and the config panel.
 */
import React, { useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { NodePalette } from '@/components/agents/node-palette'
import { NodeConfigPanel } from '@/components/agents/node-config-panel'
import { nodeTypes } from '@/components/agents/nodes'
import { cn } from '@/lib/utils'

export interface CanvasAreaProps {
  nodes: Node[]
  edges: Edge[]
  onNodesChange: (changes: NodeChange<Node>[]) => void
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void
  onConnect: (connection: Connection) => void
  onNodeClick: (event: React.MouseEvent, node: Node) => void
  onPaneClick: () => void
  onDrop: (event: React.DragEvent) => void
  onDragOver: (event: React.DragEvent) => void
  reactFlowWrapper: React.RefObject<HTMLDivElement | null>
  setReactFlowInstance: (instance: ReactFlowInstance) => void
  selectedNode: Node | null
  setSelectedNode: (node: Node | null) => void
  onUpdateNode: (nodeId: string, data: Record<string, any>) => void
  onDeleteNode: (nodeId: string) => void
}

export function CanvasArea({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onPaneClick,
  onDrop,
  onDragOver,
  reactFlowWrapper,
  setReactFlowInstance,
  selectedNode,
  setSelectedNode,
  onUpdateNode,
  onDeleteNode,
}: CanvasAreaProps) {
  const [showMobilePalette, setShowMobilePalette] = useState(false)

  return (
    <div className="flex flex-1 overflow-hidden relative">
      {/* Left: Palette -- visible on lg+, hidden on mobile */}
      <div className="hidden lg:block">
        <NodePalette />
      </div>

      {/* Mobile: floating add button to open palette dropdown */}
      <div className="lg:hidden fixed bottom-4 right-4 z-50">
        <Button
          onClick={() => setShowMobilePalette(!showMobilePalette)}
          size="icon"
          className="rounded-full shadow-lg h-12 w-12"
          aria-label={showMobilePalette ? 'Close node palette' : 'Open node palette'}
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

      {/* Right: Config Panel -- sidebar on lg+, overlay on mobile */}
      {selectedNode && (
        <div className={cn(
          'lg:w-[320px] lg:relative lg:border-l lg:z-auto',
          'fixed inset-0 z-50 bg-background lg:static lg:inset-auto',
        )}>
          {/* Mobile overlay backdrop close button */}
          <div className="lg:hidden absolute top-2 right-2 z-10">
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Close node configuration" onClick={() => setSelectedNode(null)}>
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
  )
}
