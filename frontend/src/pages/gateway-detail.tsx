import React, { useEffect } from 'react'
import { useParams, useNavigate, Link, useLocation, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Info, KeyRound, Router, Settings, ChevronRight } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CopyField } from '@/components/ui/copy-field'
import { useConfirm } from '@/components/ui/confirm-dialog'

import { gatewaysApi } from '@/lib/api'
import { toolsQuery } from '@/lib/list-queries'
import { useEntitlements } from '@/hooks/use-entitlement'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { GatewayAuthSection } from '@/components/gateways/detail/gateway-auth-section'
import { GatewayConfigurationCard } from '@/components/gateways/detail/gateway-configuration-card'
import { IntegrationsSection } from '@/components/gateways/detail/integrations-section'
import {
  GatewayToolsTab,
  type ScopingPreset,
} from '@/components/gateways/detail/tools-tab'
import { GatewayEventsTab } from '@/components/gateways/detail/events-tab'
import {
  ChannelConfigForm,
  isChannelType,
} from '@/components/gateways/detail/channel-config-form'
import { WidgetBuilder } from '@/components/gateways/widget-builder'
import { HostedChatBuilder } from '@/components/gateways/hosted-chat-builder'
import { CustomDomainCard } from '@/components/gateways/custom-domain-card'
import { VisitorOAuthCard } from '@/components/gateways/visitor-oauth-card'
import { AllowedOriginsCard } from '@/components/gateways/allowed-origins-card'
import { getApiErrorMessage } from '@/lib/api-error'
import { orgSlugOf } from '@/lib/gateway-connect'
import { ConnectSnippets } from '@/components/gateways/connect-snippets'
import { GatewayStatusSwitch } from '@/components/gateways/detail/gateway-status-switch'
import { Disclosure } from '@/components/ui/disclosure'

/** The tabs `?tab=` may open. */
export const GATEWAY_TABS = ['tools', 'metrics', 'integrations', 'events'] as const

/** The tab to open: the requested one if it exists here, else the default. */
export function initialGatewayTab(requested: string | null, isSystem: boolean): string {
  const fallback = isSystem ? 'metrics' : 'tools'
  if (!requested || !(GATEWAY_TABS as readonly string[]).includes(requested)) return fallback
  // A system gateway has no tool-scoping tab to open.
  if (isSystem && requested === 'tools') return fallback
  return requested
}
export function GatewayDetailPage() {
  const entitlements = useEntitlements()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif, warning } = useNotifications()
  const queryClient = useQueryClient()

  const { confirm, dialog: confirmDialog } = useConfirm()
  // Editing is its own page (/gateways/:id/edit), with the visibility
  // picker. ?edit=1 from older links goes there.
  const wantsEdit = searchParams.get('edit') === '1'
  useEffect(() => {
    if (wantsEdit) navigate(`/gateways/${id}/edit`, { replace: true })
  }, [wantsEdit, id, navigate])
  // The first API key the backend minted with this gateway, handed over
  // by the create page. It is shown once and never fetched again.
  const location = useLocation()
  const initialApiKey = (location.state as { initialApiKey?: string } | null)?.initialApiKey

  const { data: gatewayData, isLoading, isError, error: gatewayError, refetch: refetchGateway } = useQuery({
    queryKey: ['gateway', id],
    queryFn: () => gatewaysApi.getById(id!),
    enabled: !!id,
  })

  useEffect(() => {
    const name = (gatewayData as any)?.name
    document.title = name ? `${name} | almyty` : 'Gateway | almyty'
    return () => { document.title = 'almyty' }
  }, [gatewayData])

  const { data: gatewayToolsData, isLoading: isLoadingGatewayTools } = useQuery({
    queryKey: ['gateway-tools', id],
    queryFn: () => gatewaysApi.getTools(id!),
    enabled: !!id,
  })

  const { data: allToolsPage, isLoading: isLoadingAllTools } = useQuery({
    ...toolsQuery(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  const assignToolMutation = useMutation({
    mutationFn: ({ toolId }: { toolId: string }) =>
      gatewaysApi.assignTool(id!, toolId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Tool assigned', 'Tool has been assigned to the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to assign tool', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const removeToolMutation = useMutation({
    mutationFn: ({ toolId }: { toolId: string }) =>
      gatewaysApi.removeTool(id!, toolId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Tool removed', 'Tool has been removed from the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to remove tool', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const bulkAssignToolsMutation = useMutation({
    mutationFn: ({ toolIds }: { toolIds: string[] }) =>
      gatewaysApi.bulkAssignTools(id!, toolIds),
    /*
      Report what actually attached.

      The endpoint answers 200 with `{ associated, skipped }` and skips
      every tool that is not active -- which, right after a schema
      import, is every tool. This handler ignored `skipped` and fired
      "Tools have been assigned to the gateway successfully" over a
      gateway that had just been given nothing. A user could not even
      suspect the draft problem, because the product told them it had
      worked.
    */
    onSuccess: async (result: any) => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })

      const assigned: any[] = result?.associated ?? []
      const skipped: Array<{ toolId: string; reason: string }> = result?.skipped ?? []

      if (skipped.length === 0) {
        success(
          'Tools assigned',
          `${assigned.length} tool${assigned.length === 1 ? '' : 's'} assigned to the gateway.`,
        )
        return
      }

      // One sentence for the reason people will actually hit, rather than
      // a list of identical lines: the reasons are per-tool but they
      // repeat.
      const reasons = [...new Set(skipped.map((s) => s.reason))]
      const detail =
        `${skipped.length} of ${assigned.length + skipped.length} could not be assigned. ` +
        reasons.slice(0, 2).join(' ')

      if (assigned.length === 0) {
        errorNotif('No tools were assigned', detail)
      } else {
        warning(`${assigned.length} of ${assigned.length + skipped.length} tools assigned`, detail)
      }
    },
    onError: (err: any) => {
      errorNotif('Failed to assign tools', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const removeAllToolsMutation = useMutation({
    mutationFn: () => gatewaysApi.removeAllTools(id!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('All tools removed', 'All tools have been removed from the gateway.')
    },
    onError: (err: any) => {
      errorNotif('Failed to remove tools', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const gateway = gatewayData


  // Channel-config mutation: PATCHes only the configuration object.
  // Used by the per-channel-type credential form.
  const updateChannelConfigMutation = useMutation({
    mutationFn: (configuration: Record<string, any>) =>
      gatewaysApi.update(id!, { configuration }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      success('Channel configuration saved', 'Credentials have been encrypted and stored.')
    },
    onError: (err: any) => {
      errorNotif('Failed to save channel config', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const updateToolConfigMutation = useMutation({
    mutationFn: ({ gatewayToolId, data }: { gatewayToolId: string; data: any }) =>
      gatewaysApi.updateToolConfig(id!, gatewayToolId, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      success('Security policy updated', 'Tool security policy has been saved.')
    },
    onError: (err: any) => {
      errorNotif('Failed to update security policy', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const gatewayToolsRaw = gatewayToolsData?.gatewayTools || gatewayToolsData?.tools || gatewayToolsData || []
  const gatewayTools = Array.isArray(gatewayToolsRaw) ? gatewayToolsRaw : []

  const allTools = allToolsPage?.items ?? []

  const applyScopingPreset = (preset: ScopingPreset) => {
    // Special case: 'none' should remove all tools
    if (preset === 'none') {
      removeAllToolsMutation.mutate()
      return
    }

    let toolsToAssign: string[] = []

    switch (preset) {
      case 'read-only':
        toolsToAssign = allTools
          .filter((tool: any) => tool.method === 'GET' || tool.name?.toLowerCase().includes('get'))
          .map((tool: any) => tool.id)
        break
      case 'admin':
        toolsToAssign = allTools
          .filter((tool: any) =>
            tool.name?.toLowerCase().includes('admin') ||
            tool.name?.toLowerCase().includes('delete') ||
            tool.name?.toLowerCase().includes('update')
          )
          .map((tool: any) => tool.id)
        break
      case 'public':
        toolsToAssign = allTools
          .filter((tool: any) =>
            !tool.name?.toLowerCase().includes('delete') &&
            !tool.name?.toLowerCase().includes('admin')
          )
          .map((tool: any) => tool.id)
        break
      case 'all':
        toolsToAssign = allTools.map((tool: any) => tool.id)
        break
    }

    bulkAssignToolsMutation.mutate({ toolIds: toolsToAssign })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-96">
        <QueryError
          error={gatewayError}
          onRetry={() => refetchGateway()}
          title="Couldn't load gateway"
        />
      </div>
    )
  }

  if (!gatewayData) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <p className="text-muted-foreground">Gateway not found</p>
          <Button className="mt-4" onClick={() => navigate('/gateways')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to gateways
          </Button>
        </div>
      </div>
    )
  }

  const isSharedTools = gateway.type === 'tools'
  const orgSlug = orgSlugOf(currentOrganization)
  // What the Share tools page could not attach, handed over with the key.
  const skippedTools: Array<{ toolId: string; reason: string }> =
    (location.state as { sharedTools?: { skipped?: Array<{ toolId: string; reason: string }> } } | null)?.sharedTools?.skipped ?? []

  const toolsTab = (
    <GatewayToolsTab
      gatewayTools={gatewayTools}
      allTools={allTools}
      isLoadingGatewayTools={isLoadingGatewayTools}
      isLoadingAllTools={isLoadingAllTools}
      bulkAssignPending={bulkAssignToolsMutation.isPending}
      assignPending={assignToolMutation.isPending}
      removePending={removeToolMutation.isPending}
      onApplyPreset={applyScopingPreset}
      onRequestRemoveAll={async () => {
        const ok = await confirm({
          title: 'Remove all tools from this gateway?',
          description: 'This will remove all tools from the gateway. The gateway will not be able to serve any requests until tools are assigned again.',
          confirmLabel: 'Remove all tools',
          destructive: true,
        })
        if (ok) applyScopingPreset('none')
      }}
      onAssign={(toolId) => assignToolMutation.mutate({ toolId })}
      onRemove={(toolId) => removeToolMutation.mutate({ toolId })}
      securitySaving={updateToolConfigMutation.isPending}
      hidePresets={isSharedTools}
      onSaveSecurity={(target) =>
        updateToolConfigMutation.mutateAsync({
          gatewayToolId: target.gatewayToolId,
          data: { securityPolicy: target.policy },
        })
      }
    />
  )

  const metricsCard = (
    <Card>
      <CardHeader>
        <CardTitle>Performance metrics</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-2xl font-bold">{gateway.totalRequests || 0}</div>
              <div className="text-sm text-muted-foreground">Total Requests</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-green-600">
                {gateway.successfulRequests || 0}
              </div>
              <div className="text-sm text-muted-foreground">Successful</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-red-600">
                {gateway.failedRequests || 0}
              </div>
              <div className="text-sm text-muted-foreground">Failed</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{gatewayTools.length}</div>
              <div className="text-sm text-muted-foreground">Assigned Tools</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )

  return (
    <div className="space-y-8">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/gateways" className="hover:text-foreground">Gateways</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{gateway.name}</span>
      </div>

      {/* Header — wraps on narrow viewports so the actions don't
          run off the right edge on mobile */}
      <div className="flex flex-wrap items-center justify-between gap-y-3">
        <div className="flex items-center space-x-4 min-w-0">
          <Button variant="outline" size="sm" onClick={() => navigate('/gateways')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center space-x-3">
            <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
              <Router className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className={DETAIL_TITLE_CLASSES}>{gateway.name}</h1>
              <p className="text-muted-foreground">{gateway.description || (isSharedTools ? 'One address for MCP, UTCP and Skills' : 'API Gateway')}</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/gateways/${id}/edit`)}>
            <Settings className="h-4 w-4 mr-2" />
            Edit gateway
          </Button>
          {!gateway.isSystem && <GatewayStatusSwitch gateway={gateway} />}
          {gateway.type && <ProtocolBadge protocol={gateway.type} />}
          {gateway.isSystem && (
            <Badge className="border-transparent bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">System</Badge>
          )}
        </div>
      </div>

      {initialApiKey && (
        <div
          data-testid="initial-api-key"
          className="space-y-3 rounded-lg border border-amber-400/60 bg-amber-50 p-4 dark:bg-amber-950/30"
        >
          <p className="flex items-center gap-2 font-medium">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {isSharedTools ? 'Your access key' : "Your gateway's first API key"}
          </p>
          <CopyField value={initialApiKey} label={isSharedTools ? 'Access key' : 'API key'} />
          <p className="text-sm text-amber-800 dark:text-amber-300">
            Copy it now. You won't see it again: once you leave this page, only its first characters are shown.
          </p>
        </div>
      )}

      {skippedTools.length > 0 && (
        <div data-testid="shared-tools-skipped" className="space-y-1 rounded-lg border border-amber-400/60 bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
          <p className="font-medium">
            {skippedTools.length} tool{skippedTools.length === 1 ? " wasn't" : "s weren't"} shared
          </p>
          <ul className="list-inside list-disc text-amber-800 dark:text-amber-300">
            {[...new Set(skippedTools.map((s) => s.reason))].slice(0, 3).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {isSharedTools && <ConnectSnippets gateway={gateway} orgSlug={orgSlug} accessKey={initialApiKey} />}

      {/*
        Webhook registration failed and nothing said so.

        Telling a platform where to deliver inbound messages happens
        fire-and-forget after the gateway is saved, so a rejected
        setWebhook -- bad token, unreachable PUBLIC_API_URL -- left the
        gateway reading "Active" while no message could ever arrive. The
        failure was recorded on the gateway and read by nothing.
      */}
      {['failed', 'skipped'].includes((gateway as any)?.metadata?.webhookRegistration?.status) && (
        <div
          data-testid="webhook-registration-failed"
          className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4"
        >
          <Info className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-destructive">This channel is not receiving messages</p>
            <p className="text-sm text-destructive/90">
              {(gateway as any).metadata.webhookRegistration.error ||
                'The platform rejected the webhook registration.'}{' '}
              Fix the credential below and save again to retry.
            </p>
          </div>
        </div>
      )}

      {/* System gateway banner */}
      {gateway.isSystem && (
        <div className="flex items-start gap-3 rounded-lg border border-violet-200 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-950/30">
          <Info className="h-5 w-5 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-violet-900 dark:text-violet-200">This is a system gateway</p>
            <p className="text-sm text-violet-700 dark:text-violet-400">
              It provides almyty platform management tools. The endpoint, tools, and deletion are managed automatically.
            </p>
          </div>
        </div>
      )}

      {/* Gateway Configuration — type-specific. A shared-tools gateway's
          address is in its Connect card above. */}
      {!isSharedTools && (
        <GatewayConfigurationCard
          gateway={gateway}
          orgSlug={orgSlug}
          onCopySuccess={success}
          onCopyError={errorNotif}
        />
      )}

      {/* Channel-type credential form (per-adapter token / webhook / OAuth fields) */}
      {isChannelType(gateway.type) && (
        <ChannelConfigForm
          gateway={gateway}
          type={gateway.type}
          isSaving={updateChannelConfigMutation.isPending}
          onSave={async (cfg) => {
            await updateChannelConfigMutation.mutateAsync(cfg)
          }}
          onTestConnection={async () => {
            const res: any = await gatewaysApi.testChannelConnection(gateway.id)
            // backend returns { success, data: { ok, detail } }; apiPost
            // already unwraps `data` so we usually get { ok, detail }
            // directly, but tolerate both shapes here.
            const data = res?.data ?? res
            return { ok: !!data?.ok, detail: data?.detail || '' }
          }}
        />
      )}

      {/* Chat widget builder — customize + live-preview the embeddable widget */}
      {gateway.type === 'chat_widget' && <WidgetBuilder gateway={gateway} />}

      {/* Hosted chat app — a standalone branded site on its own
          subdomain. Its own surface rather than a widget setting: the
          widget is a bubble in someone else's page, this is a site. They
          share the branding vocabulary, not the gateway. */}
      {gateway.type === 'hosted_chat' && (
        <HostedChatBuilder
          gateway={{
            id: gateway.id,
            configuration: gateway.configuration,
          }}
          /*
            No costCapCents and no rateLimits here on purpose. Both were
            read through `as any` off properties a Gateway has never had,
            so both arrived undefined, the builder's public-link checks
            could never pass, and Save stayed disabled for every hosted
            chat app. The server does not judge those two either -- see
            ENTITLEMENT_REFUSALS in gateways.service.ts.
          */
          /*
            Without these the builder defaulted both to undefined, so the
            white-label toggle was hard-disabled and the SSO auth mode
            permanently refused -- for every organization, including the
            ones that had bought them. The whole hosted-chat SSO
            controller existed to serve a mode nothing could select.
          */
          entitlements={{
            whiteLabel: entitlements.has('white_label'),
            enterpriseAuth: entitlements.has('sso'),
          }}
        />
      )}

      {/* A domain the tenant owns: claim, publish DNS, verify, inline. */}
      {gateway.type === 'hosted_chat' && <CustomDomainCard gatewayId={gateway.id} />}
      {/* The identity provider visitors sign in with when access is OAuth. */}
      {gateway.type === 'hosted_chat' && (
        <VisitorOAuthCard gatewayId={gateway.id} authMode={gateway.configuration?.hostedChat?.authMode} />
      )}
      {/* Which third-party sites may call this public surface from the
          browser. Keyed on the gateway so the card resets when the saved
          list changes underneath it. */}
      {(gateway.type === 'chat_widget' || gateway.type === 'hosted_chat') && (
        <AllowedOriginsCard
          key={`${gateway.id}:${JSON.stringify(gateway.configuration?.allowedOrigins ?? [])}`}
          gateway={{ id: gateway.id, type: gateway.type, configuration: gateway.configuration }}
        />
      )}

      {isSharedTools ? (
        <>
          {/* Shared tools: what is shared, then everything else folded
              away. Keys, extra sign-in methods, usage and events are
              there for whoever needs them; the address and snippets
              above are all a first visit needs. */}
          <section aria-labelledby="shared-tools-heading" className="space-y-3">
            <h2 id="shared-tools-heading" className="text-lg font-semibold">
              Shared tools <span className="text-sm font-normal text-muted-foreground">({gatewayTools.length})</span>
            </h2>
            {toolsTab}
          </section>
          <Disclosure title="Advanced" summary="Access keys, sign-in methods, usage and events">
            <GatewayAuthSection gatewayId={gateway.id} gatewayName={gateway.name} />
            {metricsCard}
            <GatewayEventsTab gatewayId={id!} />
          </Disclosure>
        </>
      ) : (
        <>
      {/* Authentication */}
      {gateway.type !== 'skills' && (
        <GatewayAuthSection gatewayId={gateway.id} gatewayName={gateway.name} />
      )}

      {/* Main Content. `?tab=` opens a tab directly: the guide's "connect a
          client" step lands on Integrations, where the command is. */}
      <Tabs defaultValue={initialGatewayTab(requestedTab, !!gateway.isSystem)} className="space-y-4">
        <TabsList>
          {!gateway.isSystem && (
            <TabsTrigger value="tools">Tool scoping ({gatewayTools.length}/{allTools.length})</TabsTrigger>
          )}
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>

        {!gateway.isSystem && (
        <TabsContent value="tools" className="space-y-6">
          {toolsTab}
        </TabsContent>
        )}

        <TabsContent value="metrics" className="space-y-4">
          {metricsCard}
        </TabsContent>

        <TabsContent value="integrations" className="space-y-6">
          <IntegrationsSection gatewayId={id!} gateway={gateway} orgSlug={orgSlug} />
        </TabsContent>

        <TabsContent value="events" className="space-y-4">
          <GatewayEventsTab gatewayId={id!} />
        </TabsContent>
      </Tabs>
        </>
      )}

      {confirmDialog}

    </div>
  )
}
