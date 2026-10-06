import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'

import { FormPage } from '@/components/layout/form-page'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { WithAgent, channelKeys, channelsTabPath } from '@/components/channels/channel-page-loader'
import { VisitorDataRequestPage } from '@/components/channels/visitor-data-request'
import { useCanManageAgent } from '@/hooks/use-organization-role'
import { agentChannelsApi } from '@/lib/agent-channels'
import type { Agent } from '@/types'

/**
 * /agents/:id/channels/visitor-data -- answering one person's request for
 * their data on the agent's channels. For whoever may manage the agent:
 * an owner or admin, or the member who owns it. The server refuses anyone
 * else, so the page says so instead of offering a form that cannot work.
 */
export function AgentVisitorDataPage() {
  const { id = '' } = useParams<{ id: string }>()
  return <WithAgent agentId={id}>{(agent) => <Loaded agent={agent} />}</WithAgent>
}

function Loaded({ agent }: { agent: Agent }) {
  const canManage = useCanManageAgent(agent.createdBy)
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: channelKeys.list(agent.id),
    queryFn: () => agentChannelsApi.list(agent.id),
    enabled: canManage,
  })
  if (!canManage) {
    return (
      <FormPage title="Visitor data" back={{ to: channelsTabPath(agent.id), label: agent.name }}>
        <EmptyState
          variant="panel"
          icon={ShieldCheck}
          title="Only the agent's owner, or an owner or admin, answers data requests"
          description="Ask the person who owns this agent, or an owner or admin of your organization, to look the person up."
        />
      </FormPage>
    )
  }
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }
  if (isError || !data) return <QueryError error={error} onRetry={() => refetch()} />
  return <VisitorDataRequestPage agent={agent} channels={data} />
}

export default AgentVisitorDataPage
