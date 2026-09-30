import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import { FormSection } from '@/components/layout/form-page'
import { CopyField } from '@/components/ui/copy-field'
import { WhoCanUseLine } from '@/components/connect/who-can-use'
import { AllowedOriginsField, allowedOriginsFrom } from '@/components/gateways/allowed-origins-card'
import { CustomDomainField, customDomainKey, type CustomDomainView } from '@/components/gateways/custom-domain-card'
import { GatewayAuthSection } from '@/components/gateways/detail/gateway-auth-section'
import { HostedChatSsoUrls } from '@/components/gateways/hosted-chat-sso-urls'
import {
  VisitorOAuthCard,
  visitorOAuthBody,
  visitorOAuthKey,
  visitorOAuthProblem,
  type VisitorOAuthDraft,
  type VisitorOAuthState,
} from '@/components/gateways/visitor-oauth-card'
import { WidgetBuilder, widgetPlacementFrom, type WidgetPlacement } from '@/components/gateways/widget-builder'
import { useEntitlements } from '@/hooks/use-entitlement'
import { gatewaysApi, getApiBaseUrl } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { a2aAddresses, webChatUrl, type AgentChannel } from '@/lib/agent-channels'

/** The gateway a published channel answers on, once there is one. */
function useChannelGateway(gatewayId: string | null) {
  return useQuery<any>({
    queryKey: ['gateway', gatewayId],
    queryFn: () => gatewaysApi.getById(gatewayId!),
    enabled: !!gatewayId,
  }).data
}

/** A save that failed on a field of the page; the field says why, so no toast is needed. */
export class SurfaceFieldError extends Error {}

interface SurfaceEdits {
  domain?: string
  allowedOrigins?: string[]
  placement?: WidgetPlacement
  oauth?: VisitorOAuthDraft | null
}

/**
 * The web chat's and the widget's settings that live on the gateway they
 * answer on: the custom domain, the allowed sites, where the widget sits
 * and the visitor sign-in provider. They are fields of the channel page,
 * saved by its one Save.
 */
export function useSurfaceSettings(channel: AgentChannel) {
  const queryClient = useQueryClient()
  const web = channel.type === 'web'
  const gatewayId = web || channel.type === 'widget' ? channel.gatewayId : null
  const gateway = useChannelGateway(gatewayId)
  const { data: domain } = useQuery<CustomDomainView | null>({
    queryKey: customDomainKey(gatewayId ?? ''),
    queryFn: () => gatewaysApi.getCustomDomain(gatewayId!),
    enabled: web && !!gatewayId,
  })
  const oauthOn = web && channel.effective.visitorRules.authMode === 'oauth'
  const { data: oauth } = useQuery<VisitorOAuthState>({
    queryKey: visitorOAuthKey(gatewayId ?? ''),
    queryFn: () => gatewaysApi.getVisitorOAuth(gatewayId!),
    enabled: oauthOn && !!gatewayId,
  })

  const [edits, setEdits] = useState<SurfaceEdits>({})
  const [errors, setErrors] = useState<{ domain?: string; oauth?: string }>({})

  const saved = {
    domain: domain?.hostname ?? '',
    allowedOrigins: allowedOriginsFrom(gateway?.configuration),
    placement: widgetPlacementFrom(gateway?.configuration),
  }
  const values = {
    domain: edits.domain ?? saved.domain,
    allowedOrigins: edits.allowedOrigins ?? saved.allowedOrigins,
    placement: edits.placement ?? saved.placement,
    oauth: edits.oauth ?? null,
  }
  const changed = {
    domain: web && values.domain.trim().toLowerCase() !== saved.domain,
    allowedOrigins: JSON.stringify(values.allowedOrigins) !== JSON.stringify(saved.allowedOrigins),
    placement: channel.type === 'widget' && JSON.stringify(values.placement) !== JSON.stringify(saved.placement),
    oauth: oauthOn && values.oauth !== null,
  }
  const dirty = !!gatewayId && Object.values(changed).some(Boolean)

  const set = (patch: SurfaceEdits) => {
    setEdits((e) => ({ ...e, ...patch }))
    if ('domain' in patch) setErrors((e) => ({ ...e, domain: undefined }))
    if ('oauth' in patch) setErrors((e) => ({ ...e, oauth: undefined }))
  }

  /** Says, next to the field, what is missing before a save; false when something is. */
  const validate = (): boolean => {
    if (!changed.oauth || !values.oauth) return true
    const problem = visitorOAuthProblem(values.oauth, oauth?.provider ?? null)
    setErrors((e) => ({ ...e, oauth: problem ?? undefined }))
    return !problem
  }

  const save = async () => {
    if (!gatewayId || !dirty) return
    if (changed.allowedOrigins || changed.placement) {
      // Merge, never replace: the configuration also carries the channel
      // link and whatever else the gateway holds.
      const configuration = gateway?.configuration ?? {}
      const widget = configuration.widget && typeof configuration.widget === 'object' ? configuration.widget : {}
      await gatewaysApi.update(gatewayId, {
        configuration: {
          ...configuration,
          allowedOrigins: values.allowedOrigins,
          ...(channel.type === 'widget' ? { widget: { ...widget, ...values.placement } } : {}),
        },
      })
      await queryClient.invalidateQueries({ queryKey: ['gateway', gatewayId] })
      setEdits(({ allowedOrigins: _o, placement: _p, ...rest }) => rest)
    }
    if (changed.domain) {
      const hostname = values.domain.trim()
      try {
        const next = hostname ? await gatewaysApi.setCustomDomain(gatewayId, hostname) : null
        if (!hostname) await gatewaysApi.removeCustomDomain(gatewayId)
        queryClient.setQueryData(customDomainKey(gatewayId), next)
        setEdits(({ domain: _d, ...rest }) => rest)
      } catch (err) {
        setErrors((e) => ({ ...e, domain: getApiErrorMessage(err, 'Please try again.') }))
        throw new SurfaceFieldError()
      }
    }
    if (changed.oauth && values.oauth) {
      try {
        const next = await gatewaysApi.setVisitorOAuth(gatewayId, visitorOAuthBody(values.oauth))
        queryClient.setQueryData(visitorOAuthKey(gatewayId), next)
        setEdits(({ oauth: _a, ...rest }) => rest)
      } catch (err) {
        setErrors((e) => ({ ...e, oauth: getApiErrorMessage(err, 'Please try again.') }))
        throw new SurfaceFieldError()
      }
    }
  }

  return { gateway, domain, values, set, errors, dirty, validate, save }
}

export type SurfaceSettings = ReturnType<typeof useSurfaceSettings>

/**
 * The live web chat's link, to copy and open. Before it is published the
 * address field says where it will be.
 */
export function WebChatLink({ channel }: { channel: AgentChannel }) {
  if (!channel.slug || channel.status !== 'live') return null
  const url = webChatUrl(channel.slug)
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
 * domain, and which sites may embed it. All saved with the page.
 */
export function WebChatSettings({ channel, surface }: { channel: AgentChannel; surface: SurfaceSettings }) {
  const entitlements = useEntitlements()
  const gatewayId = channel.gatewayId
  const authMode = channel.effective.visitorRules.authMode

  return (
    <>
      {authMode === 'oauth' &&
        (gatewayId ? (
          <VisitorOAuthCard
            gatewayId={gatewayId}
            authMode={authMode}
            draft={surface.values.oauth}
            onDraftChange={(oauth) => surface.set({ oauth })}
            error={surface.errors.oauth}
          />
        ) : (
          <FormSection title="Sign-in">
            <p className="text-sm text-muted-foreground">Publish it, then pick the provider people sign in with.</p>
          </FormSection>
        ))}
      {authMode === 'sso' && gatewayId && entitlements.has('sso') && channel.slug && (
        <FormSection title="Sign-in">
          <HostedChatSsoUrls gatewayId={gatewayId} savedSlug={channel.slug} />
        </FormSection>
      )}
      {gatewayId ? (
        <>
          <CustomDomainField
            gatewayId={gatewayId}
            domain={surface.domain}
            value={surface.values.domain}
            onChange={(domain) => surface.set({ domain })}
            error={surface.errors.domain}
          />
          {surface.gateway && (
            <AllowedOriginsField
              id={`allowed-origin-${gatewayId}`}
              what="this web chat"
              value={surface.values.allowedOrigins}
              onChange={(allowedOrigins) => surface.set({ allowedOrigins })}
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
export function WidgetChannelSettings({ channel, surface }: { channel: AgentChannel; surface: SurfaceSettings }) {
  const gateway = surface.gateway

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
        placement={surface.values.placement}
        onPlacementChange={(placement) => surface.set({ placement })}
      />
      <AllowedOriginsField
        id={`allowed-origin-${gateway.id}`}
        what="this widget"
        value={surface.values.allowedOrigins}
        onChange={(allowedOrigins) => surface.set({ allowedOrigins })}
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
