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
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
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
import {
  interfaceStatusVariant,
  interfaceTypeIcons,
  getDefaultInterfaceConfig,
  maskSecret,
  getInterfaceConfigSummary,
} from './constants'
import type { Gateway } from '@/types'

interface InterfacesTabProps {
  agentId: string
  interfaces: any[] // kept for backwards compat but we fetch our own data
}

const CHANNEL_TYPES = [
  { value: 'a2a', label: 'A2A - Agent-to-Agent' },
  { value: 'openai_chat', label: 'OpenAI Chat' },
  { value: 'slack', label: 'Slack' },
  { value: 'discord', label: 'Discord' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'google_chat', label: 'Google Chat' },
  { value: 'microsoft_teams', label: 'Microsoft Teams' },
  { value: 'signal', label: 'Signal' },
  { value: 'matrix', label: 'Matrix' },
  { value: 'irc', label: 'IRC' },
  { value: 'chat_widget', label: 'Chat Widget' },
]

export function InterfacesTab({ agentId }: InterfacesTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [deployInterfaceOpen, setDeployInterfaceOpen] = useState(false)
  const [newInterfaceType, setNewInterfaceType] = useState<string>('a2a')
  const [newInterfaceName, setNewInterfaceName] = useState('')
  const [interfaceConfig, setInterfaceConfig] = useState<Record<string, any>>({})

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
        configuration: interfaceConfig,
      })
    },
    onSuccess: () => {
      success('Channel Deployed', 'Gateway has been created for this agent.')
      queryClient.invalidateQueries({ queryKey: ['agent-gateways', agentId] })
      setDeployInterfaceOpen(false)
      setNewInterfaceName('')
      setNewInterfaceType('a2a')
      setInterfaceConfig({})
    },
    onError: (err: any) => {
      errorNotif('Deploy Failed', err?.response?.data?.message || err?.message || 'Failed to deploy channel')
    },
  })

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Deployed Channels</h3>
          <p className="text-xs text-muted-foreground">Gateways where this agent is accessible</p>
        </div>
        <Button size="sm" onClick={() => setDeployInterfaceOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Deploy Channel
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : gateways.length === 0 ? (
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
            const configSummary = getInterfaceConfigSummary(gwType, gw.configuration || {})

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
              <Select value={newInterfaceType} onValueChange={(val) => { setNewInterfaceType(val); setInterfaceConfig(getDefaultInterfaceConfig(val)) }}>
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

            {newInterfaceType === 'slack' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Slack Settings</p>
                <div>
                  <Label htmlFor="cfg-slack-token">Bot Token</Label>
                  <Input id="cfg-slack-token" type="password" placeholder="xoxb-..." value={interfaceConfig.botToken || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botToken: e.target.value }))} className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="cfg-slack-secret">Signing Secret</Label>
                  <Input id="cfg-slack-secret" type="password" placeholder="Signing secret" value={interfaceConfig.signingSecret || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, signingSecret: e.target.value }))} className="mt-1" />
                </div>
              </div>
            )}

            {newInterfaceType === 'discord' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Discord Settings</p>
                <div>
                  <Label htmlFor="cfg-discord-token">Bot Token</Label>
                  <Input id="cfg-discord-token" type="password" placeholder="Bot token" value={interfaceConfig.botToken || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botToken: e.target.value }))} className="mt-1" />
                </div>
              </div>
            )}

            {newInterfaceType === 'telegram' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Telegram Settings</p>
                <div>
                  <Label htmlFor="cfg-telegram-token">Bot Token</Label>
                  <Input id="cfg-telegram-token" type="password" placeholder="123456:ABC-DEF..." value={interfaceConfig.botToken || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botToken: e.target.value }))} className="mt-1" />
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
    </>
  )
}
