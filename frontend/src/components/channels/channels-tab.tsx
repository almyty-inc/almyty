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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import {
  AUTH_MODE_SUMMARY,
  CHANNEL_LABELS,
  agentChannelsApi,
  isBuildable,
  notReceivingReason,
  webChatUrl,
  type AgentChannel,
} from '@/lib/agent-channels'
import { ChannelIcon, CHANNEL_STATUS } from './channel-meta'
import { channelKeys } from './channel-page-loader'
import { useCanManageAgent } from '@/hooks/use-organization-role'

interface ChannelsTabProps {
  agentId: string
  agentName?: string
  /** Who owns the agent (its createdBy), who may answer data requests for it. */
  agentOwnerId?: string | null
  /** The server's answer to "may this person manage the agent"; wins over the owner guess. */
  viewerCanManage?: boolean
}

/** Where a channel is, in one short line. */
function whereLine(channel: AgentChannel): string {
  if (channel.type === 'web' && channel.slug) return webChatUrl(channel.slug).replace(/^https:\/\//, '')
  if (isBuildable(channel.type)) return channel.lastBuild?.version ? `Last build ${channel.lastBuild.version}` : 'Not built yet'
  return channel.status === 'live' ? 'Answering' : 'Not answering yet'
}

const hasOwnSettings = (channel: AgentChannel) => !!channel.branding || !!channel.visitorRules

export function ChannelsTab({ agentId, agentName, agentOwnerId, viewerCanManage }: ChannelsTabProps) {
  const navigate = useNavigate()
  // Answering a person's data request is for whoever may manage the agent
  // (an admin or owner, the member who owns it, or a lead of its team); the
  // server refuses anyone else, so the link is not offered to them.
  const canAnswerDataRequests = useCanManageAgent(agentOwnerId, viewerCanManage)
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
        // Published, but nothing the platform sends can arrive: said here, not only in a log.
        const notReceiving = notReceivingReason(row.original)
        if (notReceiving) {
          return (
            <span className="flex flex-col items-start gap-0.5" data-testid="channel-not-receiving">
              <Badge variant="warning">Not receiving messages</Badge>
              <span className="text-xs text-muted-foreground">{notReceiving}</span>
            </span>
          )
        }
        const status = CHANNEL_STATUS[row.original.status] ?? CHANNEL_STATUS.draft
        return <Badge variant={status.variant}>{status.label}</Badge>
      },
    },
  ]

  const settings = settingsQuery.data?.effective

  // One card, header and body, like the agent's other tabs (Runs, Memory,
  // Files): the title, description and action in the card header, the
  // shared settings line and the table in its body.
  return (
    <Card data-testid="channels-tab">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Channels</CardTitle>
            <CardDescription className="text-xs mt-1">Where people, or other agents, reach {name}.</CardDescription>
          </div>
          <Button asChild size="sm">
            <Link to={addPath}>
              <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
              Add channel
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {settings && (
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-4 py-3 text-sm"
            data-testid="public-settings-summary"
          >
            <span className="text-muted-foreground">Name people see:</span>
            <span className="font-medium">{settings.branding.appName}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">Who can use it:</span>
            <span>{AUTH_MODE_SUMMARY[settings.visitorRules.authMode]}</span>
            <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
              {canAnswerDataRequests && (
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
          </div>
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
      </CardContent>
    </Card>
  )
}
