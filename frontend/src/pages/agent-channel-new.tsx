import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { FormPage } from '@/components/layout/form-page'
import { OptionList, type OptionListGroup } from '@/components/ui/option-list'
import { ChannelIcon } from '@/components/channels/channel-meta'
import { WithAgent, channelKeys, channelsTabPath } from '@/components/channels/channel-page-loader'
import type { JustAddedChannelState } from '@/components/channels/use-discard-untouched-channel'
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

/** A row's label: the channel's name without the part the hint says ("WhatsApp (Twilio)" -> "WhatsApp"). */
export function channelTileLabel(type: ChannelType): string {
  return CHANNEL_LABELS[type].replace(/\s*\(.*\)$/, '')
}

/** The headings the kinds of channel are listed under, in this order. */
const CHANNEL_GROUPS: Array<{ label: string; types: ChannelType[] }> = [
  { label: 'On the web', types: ['web', 'widget'] },
  {
    label: 'In messaging apps',
    types: ['slack', 'microsoft_teams', 'google_chat', 'whatsapp', 'whatsapp_cloud', 'telegram', 'discord', 'imessage_sendblue', 'imessage_loopmessage', 'signal', 'matrix', 'irc'],
  },
  { label: 'Email, text and webhooks', types: ['email', 'sms', 'webhook'] },
  { label: 'Apps and other agents', types: ['desktop', 'tui', 'a2a'] },
]

/**
 * Every addable kind, under its heading. A kind no heading names still
 * shows, under the last one, so a new channel type is never left out.
 */
export function channelOptionGroups(): OptionListGroup<ChannelType>[] {
  const named = new Set(CHANNEL_GROUPS.flatMap((g) => g.types))
  const leftover = ADDABLE_CHANNEL_TYPES.filter((t) => !named.has(t))
  return CHANNEL_GROUPS.map((g, i) => ({
    label: g.label,
    options: [...g.types.filter((t) => ADDABLE_CHANNEL_TYPES.includes(t)), ...(i === CHANNEL_GROUPS.length - 1 ? leftover : [])].map((type) => ({
      value: type,
      label: channelTileLabel(type),
      hint: CHANNEL_HINTS[type],
      icon: <ChannelIcon type={type} />,
    })),
  })).filter((g) => g.options.length > 0)
}

/**
 * /agents/:id/channels/new -- pick a kind of channel, then add it.
 *
 * Picking a row only selects it; "Add channel" adds it to the agent and
 * opens its page, where its settings and its address live. Nothing goes
 * live until it is published there, and a channel left on that page with
 * nothing saved is taken away again (useDiscardUntouchedChannel).
 */
export function AgentChannelNewPage() {
  const { id = '' } = useParams<{ id: string }>()
  return <WithAgent agentId={id}>{(agent) => <AddChannel agent={agent} />}</WithAgent>
}

function AddChannel({ agent }: { agent: Agent }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [type, setType] = useState<ChannelType | null>(null)
  const { data: channels } = useQuery({
    queryKey: channelKeys.list(agent.id),
    queryFn: () => agentChannelsApi.list(agent.id),
  })
  const hasWebChat = (channels ?? []).some((c) => c.type === 'web')
  // A desktop app opens the agent's web chat. On an agent with none, adding
  // one adds the web chat too, and the page says so before the click.
  const withWebChat = type === 'desktop' && !!channels && !hasWebChat

  const add = useMutation({
    mutationFn: async ({ type, withWebChat }: { type: ChannelType; withWebChat?: boolean }) => {
      // The web chat first, so the desktop app is added opening it.
      const webChat = withWebChat ? await agentChannelsApi.add(agent.id, { type: 'web' }) : null
      const channel = await agentChannelsApi.add(agent.id, { type })
      return { channel, alsoAdded: webChat ? [webChat.id] : [] }
    },
    onSuccess: ({ channel, alsoAdded }, { withWebChat }) => {
      success(
        'Channel added',
        withWebChat
          ? `${channel.name} and a web chat for it to open are on ${agent.name}.`
          : `${channel.name} is on ${agent.name}.`,
      )
      queryClient.invalidateQueries({ queryKey: channelKeys.list(agent.id) })
      // Its page takes it away again if it is left with nothing saved.
      const state: JustAddedChannelState = { justAdded: { ids: [channel.id, ...alsoAdded] } }
      navigate(`/agents/${agent.id}/channels/${channel.id}`, { state })
    },
    onError: (err: unknown) => {
      errorNotif('Could not add the channel', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  return (
    <FormPage
      title="Add channel"
      description={`Pick where people, or other agents, reach ${agent.name}. You can add more later.`}
      back={{ to: channelsTabPath(agent.id), label: agent.name }}
      onSubmit={(e) => {
        e.preventDefault()
        if (type && !add.isPending) add.mutate({ type, withWebChat })
      }}
      submitLabel={withWebChat ? 'Add web chat and desktop app' : 'Add channel'}
      submitting={add.isPending}
      submitDisabled={!type}
    >
      <OptionList
        label="Kind of channel"
        groups={channelOptionGroups()}
        value={type}
        onChange={setType}
        disabled={add.isPending}
        testIdPrefix="channel"
      />
      {withWebChat && (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm" role="note" data-testid="desktop-needs-web-chat">
          A desktop app opens {agent.name}&apos;s web chat, and {agent.name} has none yet, so a web chat is added as well.
        </p>
      )}
    </FormPage>
  )
}

export default AgentChannelNewPage