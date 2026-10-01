/**
 * Channels tab for the agent detail page: where people, or other agents,
 * reach this agent, and the only place channels are added and edited.
 *
 * A table of the agent's channels (row click opens the channel's page),
 * "Add channel" to add another, and the branding and visitor rules every
 * channel uses unless it sets its own. Every gateway that serves an agent
 * is one of its channels, so there is nothing else to list.
 */
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { ChevronRight, MessagesSquare, Plus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DataTable } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import {
  AUTH_MODE_SUMMARY,
  CHANNEL_LABELS,
  agentChannelsApi,
  isBuildable,
  webChatUrl,
  type AgentChannel,
} from '@/lib/agent-channels'
import { ChannelIcon, CHANNEL_STATUS } from './channel-meta'
import { channelKeys } from './channel-page-loader'
import { useOrganizationRole } from '@/hooks/use-organization-role'

interface ChannelsTabProps {
  agentId: string
  agentName?: string
}

/** Where a channel is, in one short line. */
function whereLine(channel: AgentChannel): string {
  if (channel.type === 'web' && channel.slug) return webChatUrl(channel.slug).replace(/^https:\/\//, '')
  if (isBuildable(channel.type)) return channel.lastBuild?.version ? `Last build ${channel.lastBuild.version}` : 'Not built yet'
  return channel.status === 'live' ? 'Answering' : 'Not answering yet'
}

const hasOwnSettings = (channel: AgentChannel) => !!channel.branding || !!channel.visitorRules

export function ChannelsTab({ agentId, agentName }: ChannelsTabProps) {
  const navigate = useNavigate()
  // Answering a person's data request is for owners and admins; the server
  // refuses anyone else, so the link is not offered to them.
  const { canManage } = useOrganizationRole()
  const name = agentName || 'this agent'

  const channelsQuery = useQuery({
    queryKey: channelKeys.list(agentId),
    queryFn: () => agentChannelsApi.list(agentId),
    enabled: !!agentId,
  })
  const settingsQuery = useQuery({
    queryKey: channelKeys.publicSettings(agentId),
    queryFn: () => agentChannelsApi.publicSettings(agentId),
    enabled: !!agentId,
  })

  const channels = channelsQuery.data ?? []

  const addPath = `/agents/${agentId}/channels/new`
  const channelPath = (channel: AgentChannel) => `/agents/${agentId}/channels/${channel.id}`

  const columns: ColumnDef<AgentChannel, any>[] = [
    {
      id: 'channel',
      header: 'Channel',
      cell: ({ row }) => {
        const kind = CHANNEL_LABELS[row.original.type] ?? row.original.type
        const named = row.original.name || kind
        return (
          <span className="flex items-center gap-2">
            <ChannelIcon type={row.original.type} />
            <span className="font-medium">{named}</span>
            {named !== kind && <span className="text-xs text-muted-foreground">{kind}</span>}
          </span>
        )
      },
    },
    {
      id: 'where',
      header: 'Where',
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{whereLine(row.original)}</span>,
    },
    {
      id: 'settings',
      header: 'Branding and visitor rules',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">{hasOwnSettings(row.original) ? 'Its own' : `Same as ${name}`}</span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const status = CHANNEL_STATUS[row.original.status] ?? CHANNEL_STATUS.draft
        return <Badge variant={status.variant}>{status.label}</Badge>
      },
    },
  ]

  const settings = settingsQuery.data?.effective

  return (
    <div className="space-y-6" data-testid="channels-tab">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Channels</h2>
          <p className="text-sm text-muted-foreground">Where people, or other agents, reach {name}.</p>
        </div>
        <Button asChild className="gap-2">
          <Link to={addPath}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add channel
          </Link>
        </Button>
      </div>

      {settings && (
        <Card className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-sm" data-testid="public-settings-summary">
          <span className="text-muted-foreground">Name people see:</span>
          <span className="font-medium">{settings.branding.appName}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">Who can use it:</span>
          <span>{AUTH_MODE_SUMMARY[settings.visitorRules.authMode]}</span>
          <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
            {canManage && (
              <Link
                to={`/agents/${agentId}/channels/visitor-data`}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Visitor data
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            )}
            <Link
              to={`/agents/${agentId}/channels/settings`}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Branding and visitor rules
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </span>
        </Card>
      )}

      {channelsQuery.isError ? (
        <QueryError error={channelsQuery.error} onRetry={() => channelsQuery.refetch()} title="Couldn't load the channels" />
      ) : (
        <DataTable
          columns={columns}
          data={channels}
          loading={channelsQuery.isLoading}
          onRowClick={(channel) => navigate(channelPath(channel))}
          hideSelectionCount
          hideColumnsButton
          hidePaginationWhenSinglePage
          emptyState={
            <EmptyState
              icon={MessagesSquare}
              title="No channels yet"
              description={`Add a web chat link, a website widget, Slack, WhatsApp or another channel to put ${name} in front of people.`}
              action={
                <Button asChild>
                  <Link to={addPath}>Add channel</Link>
                </Button>
              }
            />
          }
        />
      )}
    </div>
  )
}
