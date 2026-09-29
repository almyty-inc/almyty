import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { FormPage } from '@/components/layout/form-page'
import { Button } from '@/components/ui/button'
import { ChoiceTile, ChoiceTiles } from '@/components/connect/service-tiles'
import { ChannelIcon } from '@/components/channels/channel-meta'
import { WithAgent, channelKeys, channelsTabPath } from '@/components/channels/channel-page-loader'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  ADDABLE_CHANNEL_TYPES,
  CHANNEL_HINTS,
  CHANNEL_LABELS,
  agentChannelsApi,
  type ChannelType,
} from '@/lib/agent-channels'
import { useNotifications } from '@/store/app'
import type { Agent } from '@/types'

/** A tile's label: the channel's name without the part the hint says ("WhatsApp (Twilio)" -> "WhatsApp"). */
export function channelTileLabel(type: ChannelType): string {
  return CHANNEL_LABELS[type].replace(/\s*\(.*\)$/, '')
}

/**
 * /agents/:id/channels/new -- pick a kind of channel.
 *
 * Picking one adds it to the agent and opens its page, where its settings
 * and its address live. Nothing goes live until it is published there.
 */
export function AgentChannelNewPage() {
  const { id = '' } = useParams<{ id: string }>()
  return <WithAgent agentId={id}>{(agent) => <AddChannel agent={agent} />}</WithAgent>
}

function AddChannel({ agent }: { agent: Agent }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [pending, setPending] = useState<ChannelType | null>(null)
  // A desktop app opens the agent's web chat. Picked on an agent with none,
  // it asks, right here, to add the web chat too.
  const [needsWebChat, setNeedsWebChat] = useState(false)
  const { data: channels } = useQuery({
    queryKey: channelKeys.list(agent.id),
    queryFn: () => agentChannelsApi.list(agent.id),
  })
  const hasWebChat = (channels ?? []).some((c) => c.type === 'web')

  const add = useMutation({
    mutationFn: async ({ type, withWebChat }: { type: ChannelType; withWebChat?: boolean }) => {
      // The web chat first, so the desktop app is added opening it.
      if (withWebChat) await agentChannelsApi.add(agent.id, { type: 'web' })
      return agentChannelsApi.add(agent.id, { type })
    },
    onSuccess: (channel, { withWebChat }) => {
      success(
        'Channel added',
        withWebChat
          ? `${channel.name} and a web chat for it to open are on ${agent.name}.`
          : `${channel.name} is on ${agent.name}.`,
      )
      queryClient.invalidateQueries({ queryKey: channelKeys.list(agent.id) })
      navigate(`/agents/${agent.id}/channels/${channel.id}`)
    },
    onError: (err: unknown) => {
      setPending(null)
      errorNotif('Could not add the channel', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const pick = (type: ChannelType) => {
    if (type === 'desktop' && channels && !hasWebChat) {
      setNeedsWebChat(true)
      return
    }
    setNeedsWebChat(false)
    setPending(type)
    add.mutate({ type })
  }

  return (
    <FormPage
      title="Add channel"
      description={`Pick where people, or other agents, reach ${agent.name}. You can add more later.`}
      back={{ to: channelsTabPath(agent.id), label: agent.name }}
    >
      <ChoiceTiles label="Channels">
        {ADDABLE_CHANNEL_TYPES.map((type) => (
          <ChoiceTile
            key={type}
            testId={`channel-${type}`}
            icon={pending === type ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <ChannelIcon type={type} />}
            label={channelTileLabel(type)}
            hint={CHANNEL_HINTS[type]}
            disabled={add.isPending}
            onClick={() => pick(type)}
          />
        ))}
      </ChoiceTiles>
      {needsWebChat && (
        <div className="space-y-3 rounded-md border bg-muted/40 p-4" role="region" aria-label="Desktop app needs a web chat" data-testid="desktop-needs-web-chat">
          <p className="text-sm">
            A desktop app opens {agent.name}&apos;s web chat, and {agent.name} has none yet. Add a web chat as well?
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={add.isPending}
              onClick={() => {
                setPending('desktop')
                add.mutate({ type: 'desktop', withWebChat: true })
              }}
            >
              Add the web chat and the desktop app
            </Button>
            <Button type="button" variant="outline" disabled={add.isPending} onClick={() => setNeedsWebChat(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </FormPage>
  )
}

export default AgentChannelNewPage
