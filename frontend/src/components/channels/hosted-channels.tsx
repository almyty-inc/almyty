import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import { FormSection } from '@/components/layout/form-page'
import { CopyField } from '@/components/ui/copy-field'
import { WhoCanUseLine } from '@/components/connect/who-can-use'
import { AllowedOriginsCard } from '@/components/gateways/allowed-origins-card'
import { CustomDomainCard } from '@/components/gateways/custom-domain-card'
import { GatewayAuthSection } from '@/components/gateways/detail/gateway-auth-section'
import { HostedChatSsoUrls } from '@/components/gateways/hosted-chat-sso-urls'
import { VisitorOAuthCard } from '@/components/gateways/visitor-oauth-card'
import { WidgetBuilder } from '@/components/gateways/widget-builder'
import { useEntitlements } from '@/hooks/use-entitlement'
import { gatewaysApi, getApiBaseUrl } from '@/lib/api'
import { a2aAddresses, webChatUrl, type AgentChannel } from '@/lib/agent-channels'

/** The gateway a published channel answers on, once there is one. */
function useChannelGateway(gatewayId: string | null) {
  return useQuery<any>({
    queryKey: ['gateway', gatewayId],
    queryFn: () => gatewaysApi.getById(gatewayId!),
    enabled: !!gatewayId,
  }).data
}

/**
 * The web chat's link: where it will be before publishing, the link to
 * copy and open once it is live.
 */
export function WebChatAddress({ channel }: { channel: AgentChannel }) {
  if (!channel.slug) return null
  const url = webChatUrl(channel.slug)
  if (channel.status !== 'live') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="web-address-pending">
        Publishing puts it at <span className="font-mono text-foreground">{url}</span> straight away.
      </p>
    )
  }
  return (
    <div className="space-y-2" data-testid="web-address">
      <CopyField id="web-chat-url" value={url} label="Link" />
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        Open it
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  )
}

/**
 * Everything about the web chat that is not the link: how people sign in
 * (the sign-in rule itself is under branding and visitor rules), your own
 * domain, and which sites may embed it. These cards save themselves and
 * are keyed by the gateway the chat was published as.
 */
export function WebChatSettings({ channel }: { channel: AgentChannel }) {
  const entitlements = useEntitlements()
  const gatewayId = channel.gatewayId
  const gateway = useChannelGateway(gatewayId)
  const authMode = channel.effective.visitorRules.authMode

  return (
    <>
      {authMode === 'oauth' && (
        <FormSection title="Sign-in">
          {gatewayId ? (
            <VisitorOAuthCard gatewayId={gatewayId} authMode={authMode} />
          ) : (
            <p className="text-sm text-muted-foreground">Publish it, then pick the provider people sign in with.</p>
          )}
        </FormSection>
      )}
      {authMode === 'sso' && gatewayId && entitlements.has('sso') && channel.slug && (
        <FormSection title="Sign-in">
          <HostedChatSsoUrls gatewayId={gatewayId} savedSlug={channel.slug} />
        </FormSection>
      )}
      {gatewayId ? (
        <>
          <CustomDomainCard gatewayId={gatewayId} />
          {gateway && (
            <AllowedOriginsCard
              key={`${gateway.id}:${JSON.stringify(gateway.configuration?.allowedOrigins ?? [])}`}
              gateway={{ id: gateway.id, type: gateway.type, configuration: gateway.configuration }}
            />
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="web-settings-after-publish">
          Your own domain and the sites allowed to embed it are set here once it is published.
        </p>
      )}
    </>
  )
}

/**
 * The website widget: the line to paste, where it sits, and which sites
 * may load it. Its look is the agent's branding (or this channel's own).
 * There is no sign-in on a widget, so who can use it is whoever visits a
 * site it is allowed on.
 */
export function WidgetChannelSettings({ channel }: { channel: AgentChannel }) {
  const gateway = useChannelGateway(channel.gatewayId)

  if (!channel.gatewayId) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="widget-pending">
        Publishing gives you the line to add to your site. Where it sits on the page and which sites may show it are set here
        once it is published.
      </p>
    )
  }
  if (!gateway) return null

  return (
    <>
      <FormSection title="Who can use it">
        <WhoCanUseLine summary="anyone on the sites you allow" testId="widget-who" />
        <p className="text-sm text-muted-foreground">The widget has no sign-in. Only sites on the list below can show it.</p>
      </FormSection>
      <WidgetBuilder
        gateway={gateway}
        app={{ name: channel.effective.branding.appName, branding: channel.effective.branding }}
      />
      <AllowedOriginsCard
        key={`${gateway.id}:${JSON.stringify(gateway.configuration?.allowedOrigins ?? [])}`}
        gateway={{ id: gateway.id, type: gateway.type, configuration: gateway.configuration }}
      />
    </>
  )
}

/**
 * The agent for other agents: the JSON-RPC address they call, the agent
 * card they find it by, and the keys they sign in with. Both answer only
 * while the agent is active and the channel is published.
 */
export function A2aChannelSettings({ channel, orgSlug }: { channel: AgentChannel; orgSlug: string }) {
  const gateway = useChannelGateway(channel.gatewayId)
  const addresses = a2aAddresses(getApiBaseUrl(), orgSlug, gateway?.endpoint ?? channel.endpoint)

  if (!channel.gatewayId) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="a2a-pending">
        Publishing puts it at <span className="font-mono text-foreground">{addresses.endpoint}</span>, with its agent card next
        to it. Every caller signs in with a key you make here once it is published.
      </p>
    )
  }
  if (!gateway) return null

  return (
    <>
      <FormSection title="Where other agents find it" description="Give other agents the agent card. It lists what the agent does and the address to call.">
        <div className="space-y-2">
          <p className="text-sm font-medium">Agent card</p>
          <CopyField id="a2a-card" value={addresses.card} label="Agent card URL" />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Endpoint (JSON-RPC)</p>
          <CopyField id="a2a-endpoint" value={addresses.endpoint} label="A2A endpoint" />
        </div>
      </FormSection>
      <section className="space-y-3" aria-labelledby="a2a-sign-in">
        <div className="space-y-1">
          <h2 id="a2a-sign-in" className="text-base font-semibold">
            How other agents sign in
          </h2>
          <p className="text-sm text-muted-foreground">
            Each caller sends a key in the x-api-key header. Make one per caller, so you can revoke one without the others.
          </p>
        </div>
        <GatewayAuthSection gatewayId={gateway.id} gatewayName={gateway.name} />
      </section>
    </>
  )
}
