import { useQuery } from '@tanstack/react-query'

import { FormSection } from '@/components/layout/form-page'
import { CopyField } from '@/components/ui/copy-field'
import { ChannelInstallationsPanel } from '@/components/agents/detail/channel-installations-panel'
import { gatewaysApi, getApiBaseUrl } from '@/lib/api'
import { slackInstallRedirectUrl } from '@/lib/agent-apps'

/**
 * "Add to Slack", once the Slack place is live with its app's client id
 * and secret: the redirect URL to give Slack, the install link to share,
 * and the workspaces that have installed it. The install flow and the
 * list are the existing ones (channel-installations-panel.tsx), keyed by
 * the gateway this place was published as.
 */
export function SlackInstall({ gatewayId }: { gatewayId: string }) {
  const { data: gateway } = useQuery<any>({
    queryKey: ['gateway', gatewayId],
    queryFn: () => gatewaysApi.getById(gatewayId),
  })
  const configuration = gateway?.configuration ?? {}
  if (!gateway || !(configuration.client_id || configuration.clientId)) return null

  return (
    <FormSection
      title="Install link"
      description="Add this redirect URL to your Slack app under OAuth & Permissions, then share the install link."
    >
      <CopyField id="slack-redirect-url" value={slackInstallRedirectUrl(getApiBaseUrl(), gatewayId)} label="Redirect URL" />
      <ChannelInstallationsPanel gateway={gateway} />
    </FormSection>
  )
}
