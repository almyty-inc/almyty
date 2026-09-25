import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import { FormSection } from '@/components/layout/form-page'
import { CopyField } from '@/components/ui/copy-field'
import { CustomDomainCard } from '@/components/gateways/custom-domain-card'
import { AllowedOriginsCard } from '@/components/gateways/allowed-origins-card'
import { VisitorOAuthCard } from '@/components/gateways/visitor-oauth-card'
import { HostedChatSsoUrls } from '@/components/gateways/hosted-chat-sso-urls'
import { useEntitlements } from '@/hooks/use-entitlement'
import { gatewaysApi } from '@/lib/api'
import { appWebUrl, type AgentApp, type AppDistribution } from '@/lib/agent-apps'
import { AppAccess } from './app-access'

/**
 * The web app's address: the link, as soon as it is published.
 *
 * The app's name is the subdomain, so there is nothing to choose before
 * publishing and nothing to copy from anywhere else afterwards.
 */
export function WebAddress({ app, live }: { app: AgentApp; live: boolean }) {
  const url = appWebUrl(app.slug)
  if (!live) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="web-address-pending">
        Publishing puts it at <span className="font-mono text-foreground">{url}</span> straight away.
      </p>
    )
  }
  return (
    <div className="space-y-2" data-testid="web-address">
      <CopyField id="web-app-url" value={url} label="Link" />
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        Open it
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  )
}

/**
 * Everything about the web app that is not the link: who can use it and
 * how they sign in, your own domain, and which sites may embed it.
 *
 * The cards are the ones the gateway page used to carry, keyed by the
 * gateway this place was published as. Until it is published there is
 * no gateway to key them by, so the page says where they will be.
 */
export function WebPlaceSettings({ app, distribution }: { app: AgentApp; distribution: AppDistribution }) {
  const entitlements = useEntitlements()
  const gatewayId = distribution.gatewayId
  const { data: gateway } = useQuery<any>({
    queryKey: ['gateway', gatewayId],
    queryFn: () => gatewaysApi.getById(gatewayId!),
    enabled: !!gatewayId,
  })
  const authMode = app.authMode ?? 'public_link'

  return (
    <>
      <FormSection title="Who can use it">
        <AppAccess app={app} />
        {authMode === 'oauth' &&
          (gatewayId ? (
            <VisitorOAuthCard gatewayId={gatewayId} authMode={authMode} />
          ) : (
            <p className="text-sm text-muted-foreground">Publish it, then pick the provider people sign in with.</p>
          ))}
        {authMode === 'sso' && gatewayId && entitlements.has('sso') && (
          <HostedChatSsoUrls gatewayId={gatewayId} savedSlug={app.slug} />
        )}
      </FormSection>

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
