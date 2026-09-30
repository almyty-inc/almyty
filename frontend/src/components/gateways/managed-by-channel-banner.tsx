import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, MessagesSquare } from 'lucide-react'

import { CHANNEL_LABELS, channelLinkApi, type GatewayManagedBy } from '@/lib/agent-channels'

/** The agent channel a gateway answers for, or null. Undefined while loading. */
export function useManagedByChannel(gatewayId: string | undefined) {
  const { data } = useQuery({
    queryKey: ['gateway-channel', gatewayId],
    queryFn: () => channelLinkApi.channelForGateway(gatewayId!),
    enabled: !!gatewayId,
  })
  return data
}

/**
 * "Managed on <agent>": a gateway a channel stood up is configured on the
 * agent's Channels tab, so its page says so once and links to the channel,
 * rather than offering a second copy of the same settings.
 */
export function ManagedByChannelBanner({ managedBy }: { managedBy: GatewayManagedBy }) {
  const label = CHANNEL_LABELS[managedBy.channel.type] ?? managedBy.channel.type
  return (
    <div
      data-testid="managed-by-channel"
      className="flex items-start gap-3 rounded-lg border border-violet-200 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-950/30"
    >
      <MessagesSquare className="mt-0.5 h-5 w-5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium text-violet-900 dark:text-violet-200">
          {label} channel of {managedBy.agent.name}
        </p>
        <p className="text-sm text-violet-700 dark:text-violet-400">
          Who can use it, its look and its settings are on the agent.{' '}
          <Link
            to={`/agents/${managedBy.agent.id}/channels/${managedBy.channel.id}`}
            className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
          >
            Open the channel
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </p>
      </div>
    </div>
  )
}
