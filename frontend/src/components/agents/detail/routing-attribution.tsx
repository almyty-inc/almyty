import React, { useState } from 'react'
import { ChevronDown, ChevronUp, Route } from 'lucide-react'

import type { AgentExecution } from '@/types'
import type { RouteAttribution } from '@/types/models'

interface RoutingAttributionProps {
  routing: RouteAttribution
  /** Shown as a prefix when a run has more than one routed node. */
  nodeId?: string
}

/**
 * One line per routed node: which card answered, why the router picked it,
 * and on which attempt. The tried and rejected lists open on demand.
 */
export function RoutingAttribution({ routing, nodeId }: RoutingAttributionProps) {
  const [open, setOpen] = useState(false)
  const tried = Array.isArray(routing.tried) ? routing.tried : []
  const rejected = Array.isArray(routing.rejected) ? routing.rejected : []
  const hasDetails = tried.length > 0 || rejected.length > 0
  const attempt = typeof routing.attempt === 'number' ? routing.attempt : 1

  return (
    <div className="relative text-xs" data-testid="routing-attribution">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Route className="h-3 w-3 text-violet-500 shrink-0" aria-hidden />
        {nodeId && <span className="font-mono text-muted-foreground">{nodeId}:</span>}
        <span>
          Routed: <span className="font-mono font-medium">{routing.vendorModelId}</span>
          {routing.rationale ? <> via {routing.rationale}</> : null}, attempt {attempt}
        </span>
        {hasDetails && (
          <button
            type="button"
            className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground transition-colors"
            aria-expanded={open}
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
          >
            {open ? 'Hide' : 'Details'}
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        )}
      </div>
      {open && hasDetails && (
        <div role="dialog" aria-label="Routing details" className="absolute z-20 mt-1 w-72 rounded-md border bg-popover p-3 shadow-md space-y-2">
          {tried.length > 0 && (
            <div>
              <div className="font-medium mb-1">Tried</div>
              <ul className="space-y-0.5">
                {tried.map((t, i) => (
                  <li key={`t-${i}`} className="flex gap-2">
                    <span className="font-mono truncate max-w-[110px]" title={t.modelId}>{t.modelId}</span>
                    <span className="text-muted-foreground">{t.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {rejected.length > 0 && (
            <div>
              <div className="font-medium mb-1">Rejected</div>
              <ul className="space-y-0.5">
                {rejected.map((r, i) => (
                  <li key={`r-${i}`} className="flex gap-2">
                    <span className="font-mono truncate max-w-[110px]" title={r.modelId}>{r.modelId}</span>
                    <span className="text-muted-foreground">{r.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Every routed node of an execution, or a dash when none carried a policy. */
export function ExecutionRouting({ nodeResults }: { nodeResults: AgentExecution['nodeResults'] }) {
  const routed = Object.entries(nodeResults || {}).filter(([, r]) => r && r.routing && r.routing.vendorModelId)
  if (routed.length === 0) return <span className="text-sm text-muted-foreground">--</span>
  return (
    <div className="space-y-1">
      {routed.map(([nodeId, r]) => (
        <RoutingAttribution key={nodeId} routing={r.routing as RouteAttribution} nodeId={routed.length > 1 ? nodeId : undefined} />
      ))}
    </div>
  )
}
