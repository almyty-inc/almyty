import React, { useCallback, useMemo, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { Button } from '@/components/ui/button'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { surfaceNodeTypes } from './surface-nodes'
import {
  CATEGORY_BLURB,
  CATEGORY_LABEL,
  inboundAuthStatus,
  type SurfaceCategory,
  type SurfaceDescriptor,
} from './surface-types'

export interface PublishedSurface {
  id: string
  type: string
  name: string
  configuration?: Record<string, any> | null
}

export interface SurfacesCanvasProps {
  agentName: string
  catalog: SurfaceDescriptor[]
  published: PublishedSurface[]
  /** Clicking a published node opens its inline config. */
  onSelectPublished: (surface: PublishedSurface) => void
  /** Clicking an unpublished, available surface starts a publish. */
  onAddSurface: (surface: SurfaceDescriptor) => void
}

const CATEGORY_ORDER: SurfaceCategory[] = ['protocol', 'messaging', 'human']

/** Column x for each category, agent hub in the middle. */
const HUB_X = 470
const LEFT_X = 60
const RIGHT_X = 880
const ROW_HEIGHT = 132
const TOP_Y = 40

/**
 * Where an agent is reachable from, as a canvas.
 *
 * Protocol surfaces sit on the left, human-facing surfaces on the right,
 * agent in the middle: machines call in from one side, people from the
 * other. Every node comes from the backend catalog, so a surface that is
 * not usable renders greyed with the catalog's own reason rather than
 * the UI inventing one or quietly omitting it.
 */
export function SurfacesCanvas({
  agentName,
  catalog,
  published,
  onSelectPublished,
  onAddSurface,
}: SurfacesCanvasProps) {
  const [showUnpublished, setShowUnpublished] = useState(true)

  const publishedByType = useMemo(() => {
    const map = new Map<string, PublishedSurface[]>()
    for (const surface of published) {
      const list = map.get(surface.type) ?? []
      list.push(surface)
      map.set(surface.type, list)
    }
    return map
  }, [published])

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = []
    const edges: Edge[] = []

    const columns: Record<SurfaceCategory, { x: number; count: number }> = {
      protocol: { x: LEFT_X, count: 0 },
      messaging: { x: RIGHT_X, count: 0 },
      human: { x: RIGHT_X, count: 0 },
    }

    // Messaging and people share the right column, stacked in that order.
    const rightOrder: SurfaceCategory[] = ['messaging', 'human']
    let rightRow = 0

    for (const category of CATEGORY_ORDER) {
      const surfaces = catalog.filter((s) => s.category === category)

      for (const surface of surfaces) {
        const instances = publishedByType.get(surface.type) ?? []
        const isPublished = instances.length > 0
        if (!isPublished && !showUnpublished) continue

        // One node per published instance, or a single placeholder.
        const entries: Array<PublishedSurface | null> = isPublished ? instances : [null]

        for (const instance of entries) {
          const onRight = rightOrder.includes(category)
          const row = onRight ? rightRow++ : columns[category].count++
          const x = onRight ? RIGHT_X : columns[category].x
          const status = inboundAuthStatus(surface, instance?.configuration)

          const id = instance ? `surface-${instance.id}` : `catalog-${surface.type}`
          nodes.push({
            id,
            type: 'surface',
            position: { x, y: TOP_Y + row * ROW_HEIGHT },
            data: {
              surfaceType: surface.type,
              label: surface.label,
              category: surface.category,
              available: surface.available,
              unavailableReason: surface.unavailableReason,
              edition: surface.edition,
              name: instance?.name ?? '',
              // Only warn about inbound auth once a surface actually
              // exists. An unpublished placeholder has no configuration
              // to be wrong about yet.
              verified: instance ? status.verified : true,
              warning: instance ? status.reason : null,
            },
          })

          if (instance) {
            edges.push(
              onRight
                ? { id: `e-${id}`, source: 'agent-hub', target: id, animated: status.verified }
                : { id: `e-${id}`, source: id, target: 'agent-hub', animated: status.verified },
            )
          }
        }
      }
    }

    const rows = Math.max(rightRow, columns.protocol.count, 1)
    nodes.push({
      id: 'agent-hub',
      type: 'agentHub',
      position: { x: HUB_X, y: TOP_Y + ((rows - 1) * ROW_HEIGHT) / 2 },
      draggable: false,
      data: { name: agentName, surfaceCount: published.length },
    })

    return { nodes, edges }
  }, [agentName, catalog, publishedByType, published.length, showUnpublished])

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.id === 'agent-hub') return

      const instance = published.find((s) => `surface-${s.id}` === node.id)
      if (instance) {
        onSelectPublished(instance)
        return
      }

      const surface = catalog.find((s) => `catalog-${s.type}` === node.id)
      // Nothing to configure on a surface that is not usable; the node
      // already says why.
      if (surface?.available) onAddSurface(surface)
    },
    [catalog, published, onAddSurface, onSelectPublished],
  )

  return (
    <ErrorBoundary>
      <div className="h-[600px] w-full rounded-lg border bg-muted/20" data-testid="surfaces-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={surfaceNodeTypes}
          onNodeClick={handleNodeClick}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
          <Panel position="top-left" className="space-y-1">
            {CATEGORY_ORDER.map((category) => (
              <div key={category} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{CATEGORY_LABEL[category]}</span>
                {': '}
                {CATEGORY_BLURB[category]}
              </div>
            ))}
          </Panel>
          <Panel position="top-right">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowUnpublished((value) => !value)}
            >
              {showUnpublished ? 'Hide unpublished' : 'Show all surfaces'}
            </Button>
          </Panel>
        </ReactFlow>
      </div>
    </ErrorBoundary>
  )
}
