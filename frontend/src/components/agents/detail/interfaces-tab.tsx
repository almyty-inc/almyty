/**
 * Interfaces tab for the agent detail page. Shows gateway-based channel
 * deployments for this agent, plus a deploy dialog with type-specific
 * configuration forms.
 *
 * Post-A2A-refactor: channels are now agent-kind gateways, not the
 * legacy interfaces entity. We fetch gateways with kind=agent and
 * agentId=<this agent>.
 */
import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus,
  Copy,
  MessageSquare,
  Clock,
  Plug,
  Loader2,
  Wrench,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'

import { gatewaysApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { formatDateTime } from '@/lib/utils'
import { captureEvent } from '@/lib/analytics'
import {
  interfaceStatusVariant,
  interfaceTypeIcons,
  getDefaultInterfaceConfig,
  maskSecret,
  getInterfaceConfigSummary,
} from './constants'
import { AI_DISCLOSURE_CHANNEL_TYPES } from './channel-setup'
import { ChannelSetupPanel } from './channel-setup-panel'
import { ChannelInstallationsPanel } from './channel-installations-panel'
import {
  ChannelBackingConnection,
  ChannelCredentialsSection,
  backingConnectionId,
  buildChannelConnectionPatch,
  buildDeployChannelConfig,
} from './channel-credentials-section'
import type { Gateway } from '@/types'
import type { Connection } from '@/types/connections'

interface InterfacesTabProps {
  agentId: string
  /** Shown on the canvas hub node. */
  agentName?: string
}

const CHANNEL_TYPES = [
  { value: 'a2a', label: 'A2A - Agent-to-Agent' },
  { value: 'openai_chat', label: 'OpenAI Chat' },
  { value: 'slack', label: 'Slack' },
  { value: 'discord', label: 'Discord' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'whatsapp', label: 'WhatsApp (Twilio)' },
  { value: 'whatsapp_cloud', label: 'WhatsApp Cloud (Meta)' },
  { value: 'sms', label: 'SMS (Twilio)' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'google_chat', label: 'Google Chat' },
  { value: 'microsoft_teams', label: 'Microsoft Teams' },
  { value: 'signal', label: 'Signal' },
  { value: 'matrix', label: 'Matrix' },
  { value: 'irc', label: 'IRC' },
  { value: 'chat_widget', label: 'Chat Widget' },
]

import { SurfacesCanvas } from '@/components/agents/surfaces/surfaces-canvas'
import type { SurfaceDescriptor } from '@/components/agents/surfaces/surface-types'

export function InterfacesTab({ agentId, agentName }: InterfacesTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [deployInterfaceOpen, setDeployInterfaceOpen] = useState(false)
  const [newInterfaceType, setNewInterfaceType] = useState<string>('a2a')
  const [newInterfaceName, setNewInterfaceName] = useState('')
  const [interfaceConfig, setInterfaceConfig] = useState<Record<string, any>>({})
  // The connection standing in for the pasted tokens of the channel being
  // deployed. Reset on type change and after a deploy.
  const [channelConnection, setChannelConnection] = useState<Connection | null>(null)
  // Deployed channel whose setup instructions are open. Set right after a
  // successful deploy and from the "Setup" button on every channel card.
  const [setupGateway, setSetupGateway] = useState<Gateway | null>(null)
  // The canvas is the default view: one agent, its surfaces around it.
  // The list stays for scanning many gateways at once.
  const [view, setView] = useState<'canvas' | 'list'>('canvas')

  // Which surfaces exist and which are usable is the backend's answer,
  // not a hardcoded list here, so a gated or retired surface shows up
  // without a frontend change.
  const { data: surfacesData } = useQuery({
    queryKey: ['surface-catalog'],
    queryFn: () => gatewaysApi.listSurfaces(),
    staleTime: 5 * 60 * 1000,
  })

  const catalog: SurfaceDescriptor[] = (() => {
    const raw = (surfacesData as any)?.data ?? surfacesData
    return Array.isArray(raw) ? raw : []
  })()

  // Fetch agent-kind gateways for this agent
  const { data: gatewaysData, isLoading } = useQuery({
    queryKey: ['agent-gateways', agentId],
    queryFn: () => gatewaysApi.getAll({ kind: 'agent', agentId }),
    enabled: !!agentId,
  })

  const gateways: Gateway[] = (() => {
    const raw = gatewaysData?.gateways || (Array.isArray(gatewaysData) ? gatewaysData : [])
    return Array.isArray(raw) ? raw : []
  })()

  const deployGatewayMutation = useMutation({
    mutationFn: async () => {
      const slug = (newInterfaceName || newInterfaceType).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
      return gatewaysApi.create({
        name: newInterfaceName || `${newInterfaceType} gateway`,
        kind: 'agent',
        type: newInterfaceType,
        agentId,
        endpoint: `/${slug}`,
        configuration: buildDeployChannelConfig({
          type: newInterfaceType,
          config: interfaceConfig,
          connection: channelConnection,
        }),
      })
    },
    onSuccess: (created: any) => {
      captureEvent('channel_deployed', { channelType: newInterfaceType })
      success('Channel Deployed', 'Gateway has been created for this agent.')
      setInterfaceConfig({})
      setChannelConnection(null)
      setDeployInterfaceOpen(false)
      setNewInterfaceName('')
      setNewInterfaceType('a2a')
      setInterfaceConfig({})
      // Walk the user straight into platform-side setup for the new channel.
      const gateway = created?.gateway || created
      if (gateway?.id) setSetupGateway(gateway as Gateway)
    },
    onError: (err: any) => {
      errorNotif('Deploy Failed', err?.response?.data?.message || err?.message || 'Failed to deploy channel')
    },
  })

  // Point a deployed channel at another connection, or drop the one
  // backing it. Same rule as the gateway-side form: the secret keys the
  // connection held go with it.
  const setChannelConnectionMutation = useMutation({
    mutationFn: ({ gateway, connection }: { gateway: Gateway; connection: Connection | null }) =>
      gatewaysApi.update(gateway.id, {
        configuration: buildChannelConnectionPatch({
          type: gateway.type as string,
          configuration: (gateway as any).configuration,
          connection,
        }),
      }),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agent-gateways', agentId] })
      if (variables.connection) {
        success('Connection Updated', `${variables.connection.name} now backs this channel.`)
      } else {
        success('Connection Removed', 'Paste credentials or pick another connection to keep this channel working.')
      }
    },
    onError: (err: any) => {
      errorNotif('Update Failed', err?.response?.data?.message || err?.message || 'Failed to update the channel connection')
    },
  })

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Surfaces</h3>
          <p className="text-xs text-muted-foreground">Everywhere this agent is reachable</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5">
            <Button
              type="button"
              size="sm"
              variant={view === 'canvas' ? 'secondary' : 'ghost'}
              className="h-7 px-2.5"
              onClick={() => setView('canvas')}
            >
              Canvas
            </Button>
            <Button
              type="button"
              size="sm"
              variant={view === 'list' ? 'secondary' : 'ghost'}
              className="h-7 px-2.5"
              onClick={() => setView('list')}
            >
              List
            </Button>
          </div>
          <Button size="sm" onClick={() => setDeployInterfaceOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Deploy Channel
          </Button>
        </div>
      </div>

      {view === 'canvas' && !isLoading && (
        <SurfacesCanvas
          agentName={agentName || 'This agent'}
          catalog={catalog}
          published={gateways.map((gw) => ({
            id: gw.id,
            type: gw.type as string,
            name: gw.name,
            configuration: (gw as any).configuration,
          }))}
          onSelectPublished={(surface) => {
            const gateway = gateways.find((gw) => gw.id === surface.id)
            if (gateway) setSetupGateway(gateway)
          }}
          onAddSurface={(surface) => {
            // Drop straight into the deploy dialog with the surface the
            // operator clicked already chosen.
            setNewInterfaceType(surface.type)
            setInterfaceConfig(getDefaultInterfaceConfig(surface.type))
            setDeployInterfaceOpen(true)
          }}
        />
      )}

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : view === 'canvas' ? null : gateways.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <p className="text-sm text-muted-foreground text-center">
              No channels deployed yet. Deploy a channel to make this agent accessible via A2A, Slack, Discord, and more.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {gateways.map((gw) => {
            const gwType = gw.type
            const credentialId = backingConnectionId(gw.configuration)
            // A connection supplies the secrets, so the masked-token rows
            // are dropped in favour of the account it names.
            const configSummary = getInterfaceConfigSummary(gwType, gw.configuration || {})
              .filter((item) => !(credentialId && item.secret))

            return (
              <Card key={gw.id} className="hover:shadow-md transition-shadow">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{interfaceTypeIcons[gwType] || '🔌'}</span>
                      <div>
                        <div className="font-medium text-sm">{gw.name}</div>
                        <ProtocolBadge protocol={gwType} className="mt-0.5" />
                      </div>
                    </div>
                    <Badge variant={gw.status === 'active' ? 'success' : 'secondary'}>
                      {gw.status}
                    </Badge>
                  </div>

                  {/* Backed by a connection: the account, not a masked token. */}
                  {credentialId && (
                    <ChannelBackingConnection
                      type={gwType}
                      configuration={gw.configuration}
                      isSaving={setChannelConnectionMutation.isPending}
                      onSwap={(connection) => setChannelConnectionMutation.mutate({ gateway: gw, connection })}
                      onDisconnect={() => setChannelConnectionMutation.mutate({ gateway: gw, connection: null })}
                    />
                  )}

                  {/* Configuration summary */}
                  {configSummary.length > 0 && (
                    <div className="mb-3 rounded border bg-muted/30 p-2 space-y-1">
                      {configSummary.map((item) => (
                        <div key={item.label} className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">{item.label}</span>
                          <span className="font-mono truncate max-w-[60%] text-right">
                            {item.secret ? maskSecret(item.value) : (item.value || '-')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Endpoint */}
                  {gw.endpoint && (
                    <div className="mb-3 rounded border bg-muted/30 p-2">
                      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Endpoint</div>
                      <div className="flex items-center gap-1">
                        <code className="text-[11px] break-all flex-1">{gw.endpoint}</code>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          aria-label="Copy endpoint"
                          onClick={() => { navigator.clipboard.writeText(gw.endpoint); success('Copied', 'Endpoint copied to clipboard.') }}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="space-y-1 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      <span>{gw.totalRequests || 0} request{(gw.totalRequests || 0) !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      <span>Last request: {gw.lastRequestAt ? formatDateTime(gw.lastRequestAt) : 'Never'}</span>
                    </div>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 w-full"
                    onClick={() => setSetupGateway(gw)}
                  >
                    <Wrench className="h-3.5 w-3.5 mr-1.5" />
                    Setup
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Deploy Channel Dialog */}
      <Dialog open={deployInterfaceOpen} onOpenChange={setDeployInterfaceOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Deploy Channel</DialogTitle>
            <DialogDescription>
              Deploy this agent to a new channel via a gateway.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="channel-type">Type</Label>
              <Select value={newInterfaceType} onValueChange={(val) => { setNewInterfaceType(val); setInterfaceConfig(getDefaultInterfaceConfig(val)); setChannelConnection(null) }}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_TYPES.map((ct) => (
                    <SelectItem key={ct.value} value={ct.value}>{ct.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="channel-name">Name</Label>
              <Input
                id="channel-name"
                placeholder={`${newInterfaceType.replace('_', ' ')} gateway`}
                value={newInterfaceName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewInterfaceName(e.target.value)}
                className="mt-1"
              />
            </div>

            {/* Type-specific configuration (Slack, Discord, etc.) */}
            {newInterfaceType === 'chat_widget' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Widget Settings</p>
                <div>
                  <Label htmlFor="cfg-welcome">Welcome Message</Label>
                  <Input
                    id="cfg-welcome"
                    placeholder="Hi! How can I help you?"
                    value={interfaceConfig.welcomeMessage || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, welcomeMessage: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-color">Primary Color</Label>
                  <Input
                    id="cfg-color"
                    placeholder="#8b5cf6"
                    value={interfaceConfig.primaryColor || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, primaryColor: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            <ChannelCredentialsSection
              type={newInterfaceType}
              config={interfaceConfig}
              onConfigChange={setInterfaceConfig}
              connection={channelConnection}
              onConnectionChange={setChannelConnection}
            />

            {/* Slack app-level OAuth. Separate from the bot credentials a
                connection supplies: this pair is what makes the channel
                installable in other workspaces. */}
            {newInterfaceType === 'slack' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Multi-workspace installs (optional)</p>
                <div>
                  <Label htmlFor="cfg-slack-client-id">OAuth Client ID</Label>
                  <Input id="cfg-slack-client-id" placeholder="Slack app client ID" value={interfaceConfig.client_id || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, client_id: e.target.value }))} className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="cfg-slack-client-secret">OAuth Client Secret</Label>
                  <Input id="cfg-slack-client-secret" type="password" placeholder="Slack app client secret" value={interfaceConfig.client_secret || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, client_secret: e.target.value }))} className="mt-1" />
                </div>
                <p className="text-xs text-muted-foreground">With OAuth credentials set, this channel gets an "Add to Slack" install link so any workspace can install it.</p>
              </div>
            )}

            {AI_DISCLOSURE_CHANNEL_TYPES.has(newInterfaceType) && (
              <div className="flex items-start gap-2 rounded-md border p-3">
                <Checkbox
                  id="cfg-ai-disclosure"
                  checked={!!interfaceConfig.aiDisclosure}
                  onCheckedChange={(checked) => setInterfaceConfig(prev => ({ ...prev, aiDisclosure: checked === true }))}
                  className="mt-0.5"
                />
                <div>
                  <Label htmlFor="cfg-ai-disclosure" className="text-sm font-normal cursor-pointer">
                    Disclose AI identity on first message (EU AI Act Art. 50)
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Prepends a disclosure line to the first reply of each conversation.
                  </p>
                </div>
              </div>
            )}

            <Button
              className="w-full"
              disabled={deployGatewayMutation.isPending}
              onClick={() => deployGatewayMutation.mutate()}
            >
              {deployGatewayMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <Plug className="h-4 w-4 mr-2" />
                  Deploy
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Channel Setup Dialog — opened after a deploy and from each card's Setup button */}
      <Dialog open={!!setupGateway} onOpenChange={(open) => { if (!open) setSetupGateway(null) }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Channel Setup</DialogTitle>
            <DialogDescription>
              Finish connecting {setupGateway?.name || 'this channel'} on the platform's side.
            </DialogDescription>
          </DialogHeader>
          {setupGateway && (
            <>
              <ChannelSetupPanel gateway={setupGateway} />
              {/* Multi-workspace OAuth installs (Slack channels with a configured client_id) */}
              <ChannelInstallationsPanel gateway={setupGateway} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
