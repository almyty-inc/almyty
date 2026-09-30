import type { ReactElement } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { ChannelSettings } from '@/components/channels/channel-settings'
import { WithAgent, WithChannel, channelKeys } from '@/components/channels/channel-page-loader'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { agentChannelsApi } from '@/lib/agent-channels'

/** /agents/:id/channels/:channelId -- one channel of an agent. */
export function AgentChannelPage() {
  const { id = '', channelId = '' } = useParams<{ id: string; channelId: string }>()
  return (
    <WithAgent agentId={id}>
      {(agent) => (
        <WithChannel agent={agent} channelId={channelId}>
          {(channel) => <Inherited agentId={agent.id}>{(inherited) => <ChannelSettings key={channel.id} agent={agent} channel={channel} inherited={inherited} />}</Inherited>}
        </WithChannel>
      )}
    </WithAgent>
  )
}

/** What the agent's channels inherit, which the channel's own settings are told apart from. */
function Inherited({
  agentId,
  children,
}: {
  agentId: string
  children: (inherited: Awaited<ReturnType<typeof agentChannelsApi.publicSettings>>['effective']) => ReactElement
}) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: channelKeys.publicSettings(agentId),
    queryFn: () => agentChannelsApi.publicSettings(agentId),
  })
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }
  if (isError || !data) return <QueryError error={error} onRetry={() => refetch()} />
  return children(data.effective)
}

export default AgentChannelPage
