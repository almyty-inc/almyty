/**
 * Read-only ReactFlow canvas displaying the agent pipeline.
 * Hidden for autonomous-mode agents.
 */
import React from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { nodeTypes } from '@/components/agents/nodes'

interface PipelineCanvasProps {
  flowNodes: Node[]
  flowEdges: Edge[]
}

export function PipelineCanvas({ flowNodes, flowEdges }: PipelineCanvasProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Pipeline</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="h-[350px] border-t">
          {flowNodes.length === 0 ? (
            <div className="flex items-center justify-center h-full bg-gradient-to-br from-muted/20 via-muted/10 to-transparent">
              <p className="text-sm text-muted-foreground">No nodes in pipeline. Edit the agent to add nodes.</p>
            </div>
          ) : (
            <ErrorBoundary
              fallback={
                <div className="flex items-center justify-center h-full bg-muted/10">
                  <p className="text-sm text-destructive">Failed to render pipeline canvas.</p>
                </div>
              }
            >
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.3 }}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                panOnDrag
                zoomOnScroll
                className="bg-gradient-to-br from-muted/20 via-muted/5 to-transparent"
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={16} size={1} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </ErrorBoundary>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
