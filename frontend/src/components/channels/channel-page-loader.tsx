import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { MessagesSquare } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { agentsApi } from '@/lib/api'
import { agentChannelsApi, type AgentChannel } from '@/lib/agent-channels'
import type { Agent } from '@/types'

/** Where an agent's channels are listed: its Channels tab. */
export const channelsTabPath = (agentId: string) => `/agents/${agentId}?tab=channels`

/** The query keys the channel pages share, so moving between them does not refetch. */
export const channelKeys = {
  list: (agentId: string) => ['agent-channels', agentId] as const,
  one: (agentId: string, channelId: string) => ['agent-channel', agentId, channelId] as const,
  check: (agentId: string, channelId: string) => ['agent-channel-check', agentId, channelId] as const,
  publicSettings: (agentId: string) => ['agent-public-settings', agentId] as const,
  spend: (agentId: string) => ['agent-channel-spend', agentId] as const,
}

function Loading() {
  return (
    <div className="flex justify-center py-16">
      <LoadingSpinner />
    </div>
  )
}

/** Loads the agent a channel page belongs to (same query as the agent page). */
export function WithAgent({ agentId, children }: { agentId: string; children: (agent: Agent) => ReactNode }) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => agentsApi.getById(agentId),
    enabled: !!agentId,
  })
  const agent = ((data as any)?.data ?? data) as Agent | undefined
  if (isLoading) return <Loading />
  if (isError || !agent) return <QueryError error={error} onRetry={() => refetch()} />
  return <>{children(agent)}</>
}

/**
 * Loads one channel of the agent, or says it is gone: a stale link after
 * the channel was deleted.
 */
export function WithChannel({
  agent,
  channelId,
  children,
}: {
  agent: Agent
  channelId: string
  children: (channel: AgentChannel) => ReactNode
}) {
  const { data: channel, isLoading, isError, error, refetch } = useQuery({
    queryKey: channelKeys.one(agent.id, channelId),
    queryFn: () => agentChannelsApi.get(agent.id, channelId),
    enabled: !!channelId,
    retry: false,
  })
  if (isLoading) return <Loading />
  if (isError && (error as any)?.response?.status === 404) {
    return (
      <EmptyState
        variant="panel"
        icon={MessagesSquare}
        title="That channel is gone"
        description={`It may have been deleted. ${agent.name}'s channels are on its Channels tab.`}
        action={
          <Button asChild>
            <Link to={channelsTabPath(agent.id)}>Back to channels</Link>
          </Button>
        }
      />
    )
  }
  if (isError || !channel) return <QueryError error={error} onRetry={() => refetch()} />
  return <>{children(channel)}</>
}
