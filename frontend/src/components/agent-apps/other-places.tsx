import { useQuery } from '@tanstack/react-query'

import { FormSection } from '@/components/layout/form-page'
import { CopyField } from '@/components/ui/copy-field'
import { WhoCanUseLine } from '@/components/connect/who-can-use'
import { AllowedOriginsCard } from '@/components/gateways/allowed-origins-card'
import { GatewayAuthSection } from '@/components/gateways/detail/gateway-auth-section'
import { WidgetBuilder } from '@/components/gateways/widget-builder'
import { gatewaysApi, getApiBaseUrl } from '@/lib/api'
import { a2aAddresses, type AgentApp, type AppDistribution } from '@/lib/agent-apps'

/** The gateway a published place answers on, once there is one. */
function usePlaceGateway(gatewayId: string | null) {
  return useQuery<any>({
    queryKey: ['gateway', gatewayId],
    queryFn: () => gatewaysApi.getById(gatewayId!),
    enabled: !!gatewayId,
  }).data
}

/**
 * The widget on someone's own website: the line to paste, where it sits,
 * and which sites may load it. Its look is the app's. There is no sign-in
 * on a widget, so who can use it is whoever visits a site it is allowed on.
 */
export function WidgetPlaceSettings({ app, distribution }: { app: AgentApp; distribution: AppDistribution }) {
  const gateway = usePlaceGateway(distribution.gatewayId)

  if (!distribution.gatewayId) {
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
        <p className="text-sm text-muted-foreground">
          The widget has no sign-in. Only sites on the list below can show it.
        </p>
      </FormSection>
      <WidgetBuilder gateway={gateway} app={app} />
      <AllowedOriginsCard
        key={`${gateway.id}:${JSON.stringify(gateway.configuration?.allowedOrigins ?? [])}`}
        gateway={{ id: gateway.id, type: gateway.type, configuration: gateway.configuration }}
      />
    </>
  )
}

/**
 * The app's agent for other agents: the JSON-RPC address they call and
 * the agent card they find it by, and the keys they sign in with. The
 * card and the endpoint answer only while the agent is active and the
 * place is published.
 */
export function A2aPlaceSettings({
  app,
  distribution,
  orgSlug,
}: {
  app: AgentApp
  distribution: AppDistribution
  orgSlug: string
}) {
  const gateway = usePlaceGateway(distribution.gatewayId)
  const addresses = a2aAddresses(getApiBaseUrl(), orgSlug, app.slug, gateway?.endpoint)

  if (!distribution.gatewayId) {
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
      <FormSection
        title="Where other agents find it"
        description="Give other agents the agent card. It lists what the agent does and the address to call."
      >
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
