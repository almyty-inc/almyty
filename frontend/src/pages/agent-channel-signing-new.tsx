import { useParams, useSearchParams } from 'react-router-dom'

import { SigningCredentialForm } from '@/components/channels/signing-credential-form'
import { WithAgent, WithChannel } from '@/components/channels/channel-page-loader'

/**
 * /agents/:id/channels/:channelId/signing/new?kind=apple|authenticode
 * -- add the certificate this desktop or terminal app is signed with.
 */
export function AgentChannelSigningNewPage() {
  const { id = '', channelId = '' } = useParams<{ id: string; channelId: string }>()
  const [searchParams] = useSearchParams()
  const kind = searchParams.get('kind') === 'authenticode' ? 'authenticode' : 'apple'

  return (
    <WithAgent agentId={id}>
      {(agent) => (
        <WithChannel agent={agent} channelId={channelId}>
          {(channel) => (
            <SigningCredentialForm agentId={agent.id} agentName={agent.name} channelId={channel.id} type={channel.type} kind={kind} />
          )}
        </WithChannel>
      )}
    </WithAgent>
  )
}

export default AgentChannelSigningNewPage
