import React, { useMemo } from 'react'
import { ReactFlow, Background, Controls, Panel, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { ErrorBoundary } from '@/components/ui/error-boundary'
import { appNodeTypes } from './app-nodes'
import {
  DISTRIBUTION_BLURBS,
  DISTRIBUTION_LABELS,
  type AgentApp,
  type AppCheck,
  type DistributionTarget,
} from '@/lib/agent-apps'

/**
 * An app, drawn as the chain it is.
 *
 * Agents feed in from the left, the product sits in the middle, and the
 * places it ships to fan out on the right. That layout is the whole
 * pitch made visible: capabilities become a product, a product reaches
 * people. A list of settings pages cannot show that a Slack
 * distribution and a desktop binary are the same product, which is
 * exactly the thing an operator needs to hold in their head.
 */

export interface CanvasAgent {
  id: string
  name: string
}

export interface AppCanvasProps {
  app: AgentApp
  /** Agents in the organization, for resolving names of the ids on the app. */
  agents: CanvasAgent[]
  /** What is stopping this app shipping, shown on the product node. */
  check?: AppCheck
  onSelectAgents: () => void
  onSelectApp: () => void
  onSelectDistribution: (target: DistributionTarget) => void
  onAddDistribution: () => void
}

/** Every target an app can ship to, in the order the canvas lists them. */
const TARGET_ORDER: DistributionTarget[] = [
  'web',
  'tui',
  'desktop',
  'binary',
  'slack',
  'discord',
  'telegram',
  'whatsapp',
  'whatsapp_cloud',
  'sms',
  'microsoft_teams',
  'google_chat',
  'email',
  'signal',
  'matrix',
  'irc',
  'webhook',
]

const AGENT_X = 40
const APP_X = 420
const DIST_X = 800
const ROW = 108
const TOP = 40

export function AppCanvas({
  app,
  agents,
  check,
  onSelectAgents,
  onSelectApp,
  onSelectDistribution,
  onAddDistribution,
}: AppCanvasProps) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = []
    const edges: Edge[] = []

    const shipped = app.distributions ?? []
    const rows = Math.max(shipped.length, 1)
    const centreY = TOP + ((rows - 1) * ROW) / 2

    // Agents on the left. One node listing them rather than one node
    // each: which agents are in the product matters, but their internals
    // belong on the agent page, not here.
    const named = app.agentIds
      .map((id) => agents.find((a) => a.id === id)?.name)
      .filter((name): name is string => !!name)

    nodes.push({
      id: 'agents',
      type: 'appAgents',
      position: { x: AGENT_X, y: centreY },
      data: {
        count: app.agentIds.length,
        names: named,
        // A product with no agents has nothing for a user to talk to,
        // which is a refusal rather than an empty state.
        empty: app.agentIds.length === 0,
      },
    })

    nodes.push({
      id: 'app',
      type: 'appProduct',
      position: { x: APP_X, y: centreY },
      draggable: false,
      data: {
        name: app.branding?.appName || app.name,
        slug: app.slug,
        authMode: app.authMode,
        primaryColor: app.branding?.primaryColor,
        capabilities: app.capabilities,
        blockers: check?.refusals ?? [],
        ok: check?.ok !== false,
      },
    })

    edges.push({ id: 'e-agents', source: 'agents', target: 'app', animated: false })

    shipped
      .slice()
      .sort(
        (a, b) => TARGET_ORDER.indexOf(a.target) - TARGET_ORDER.indexOf(b.target),
      )
      .forEach((distribution, index) => {
        const id = `dist-${distribution.target}`
        nodes.push({
          id,
          type: 'appDistribution',
          position: { x: DIST_X, y: TOP + index * ROW },
          data: {
            target: distribution.target,
            label: DISTRIBUTION_LABELS[distribution.target] ?? distribution.target,
            blurb: DISTRIBUTION_BLURBS[distribution.target] ?? '',
            status: distribution.status,
            lastBuild: distribution.lastBuild,
          },
        })
        edges.push({
          id: `e-${id}`,
          source: 'app',
          target: id,
          // A live distribution is carrying traffic; a draft is not, and
          // the edge should not imply otherwise.
          animated: distribution.status === 'live',
        })
      })

    return { nodes, edges }
  }, [app, agents, check])

  const handleNodeClick = (_event: React.MouseEvent, node: Node) => {
    if (node.id === 'agents') return onSelectAgents()
    if (node.id === 'app') return onSelectApp()
    const target = (node.data as any)?.target as DistributionTarget | undefined
    if (target) onSelectDistribution(target)
  }

  return (
    <ErrorBoundary>
      <div className="h-[620px] w-full rounded-lg border bg-muted/20" data-testid="app-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={appNodeTypes}
          onNodeClick={handleNodeClick}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
          <Panel position="top-left" className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Agents</span> become a{' '}
            <span className="font-medium text-foreground">product</span>, which reaches{' '}
            <span className="font-medium text-foreground">people</span>.
          </Panel>
          <Panel position="top-right">
            <button
              type="button"
              onClick={onAddDistribution}
              className="rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm hover:bg-muted"
            >
              Ship somewhere
            </button>
          </Panel>
        </ReactFlow>
      </div>
    </ErrorBoundary>
  )
}
