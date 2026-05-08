/**
 * GatewayEventsTab — per-gateway channel event log viewer.
 *
 * Hits GET /gateways/:id/events and renders the recent inbound webhooks
 * + outbound responses with direction, status, channel type, relative
 * time, and a click-to-expand JSON payload (with truncation marker
 * surfaced when the backend marked the payload as truncated).
 *
 * Auto-polls every 15s via TanStack Query. Manual refresh button forces
 * an immediate refetch. RBAC is enforced server-side; any org member
 * with view-gateways perm can hit this endpoint.
 *
 * runId is shown when the inbound event spawned an AgentRun. We don't
 * always know the agentId at this point so we expose a copy-id button
 * rather than trying to construct an /agents/:agentId/runs/:runId link.
 */
import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Inbox,
  RefreshCw,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { gatewaysApi } from '@/lib/api'
import { formatRelativeTime } from '@/lib/utils'
import { useNotifications } from '@/store/app'

export type ChannelDirection = 'inbound' | 'outbound'
export type ChannelEventStatus = 'received' | 'processed' | 'failed'

export interface ChannelEvent {
  id: string
  organizationId: string
  gatewayId: string
  channelType: string
  direction: ChannelDirection
  status: ChannelEventStatus
  payload: Record<string, any> | null
  errorMessage: string | null
  runId: string | null
  createdAt: string
}

const POLL_INTERVAL_MS = 15_000
const DEFAULT_LIMIT = 100

interface GatewayEventsTabProps {
  gatewayId: string
}

export function GatewayEventsTab({ gatewayId }: GatewayEventsTabProps) {
  const { success, error: errorNotif } = useNotifications()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ['gateway-events', gatewayId],
    queryFn: () => gatewaysApi.listEvents(gatewayId, DEFAULT_LIMIT),
    enabled: !!gatewayId,
    refetchInterval: POLL_INTERVAL_MS,
  })

  // Backend wraps the response as { success: true, data: [...] }; api client
  // returns the JSON body. Accept both shapes defensively.
  const events: ChannelEvent[] = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data)
      ? data
      : []

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      success('Copied', `${label} copied to clipboard.`)
    } catch {
      errorNotif('Copy failed', 'Clipboard access was denied by the browser.')
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>Channel Events</CardTitle>
          <CardDescription>
            Recent inbound webhooks and outbound responses for this gateway. Auto-refreshes every 15s.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <LoadingSpinner size="lg" />
          </div>
        ) : isError ? (
          <EmptyState
            icon={AlertCircle}
            title="Failed to load events"
            description="Couldn't fetch the event log. Try refreshing."
            action={
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            }
          />
        ) : events.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No events yet for this gateway."
            description="Inbound webhooks and outbound responses will appear here as they happen."
          />
        ) : (
          <ul className="divide-y divide-border rounded-md border">
            {events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                expanded={expandedId === event.id}
                onToggle={() => setExpandedId((prev) => (prev === event.id ? null : event.id))}
                onCopyId={(text, label) => handleCopy(text, label)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

interface EventRowProps {
  event: ChannelEvent
  expanded: boolean
  onToggle: () => void
  onCopyId: (text: string, label: string) => void
}

function EventRow({ event, expanded, onToggle, onCopyId }: EventRowProps) {
  const truncated =
    event.payload && typeof event.payload === 'object' && (event.payload as any)._truncated === true
  const originalBytes = truncated ? (event.payload as any)._originalBytes : null

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-inset"
        aria-expanded={expanded}
      >
        <div className="mt-0.5 flex-shrink-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DirectionBadge direction={event.direction} />
            <StatusBadge status={event.status} />
            <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wide">
              {event.channelType}
            </Badge>
            <span className="text-xs text-muted-foreground" title={new Date(event.createdAt).toLocaleString()}>
              {formatRelativeTime(event.createdAt)}
            </span>
            {event.runId && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  onCopyId(event.runId!, 'Run ID')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    onCopyId(event.runId!, 'Run ID')
                  }
                }}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring rounded px-1"
                title="Copy run ID"
              >
                <Copy className="h-3 w-3" />
                <span className="font-mono">run:{event.runId.slice(0, 8)}</span>
              </span>
            )}
          </div>
          {event.errorMessage && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">
              {event.errorMessage}
            </p>
          )}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 pl-11">
          {truncated && (
            <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
              Payload truncated{originalBytes ? ` (original: ${originalBytes} bytes)` : ''}. Showing preview only.
            </p>
          )}
          <pre className="max-h-96 overflow-auto rounded bg-muted/50 p-3 text-xs font-mono">
            {event.payload === null
              ? '(no payload)'
              : JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      )}
    </li>
  )
}

function DirectionBadge({ direction }: { direction: ChannelDirection }) {
  if (direction === 'inbound') {
    return (
      <Badge className="border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 gap-1">
        <ArrowDownLeft className="h-3 w-3" />
        in
      </Badge>
    )
  }
  return (
    <Badge className="border-transparent bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 gap-1">
      <ArrowUpRight className="h-3 w-3" />
      out
    </Badge>
  )
}

function StatusBadge({ status }: { status: ChannelEventStatus }) {
  if (status === 'failed') {
    return <Badge variant="destructive">failure</Badge>
  }
  if (status === 'processed') {
    return <Badge variant="success">success</Badge>
  }
  // received
  return (
    <Badge className="border-transparent bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
      received
    </Badge>
  )
}
