/**
 * Interfaces tab for the agent detail page. Shows deployed interface
 * cards with webhook URLs and embed snippets, plus a deploy dialog
 * with type-specific configuration forms.
 */
import React, { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
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

import { interfacesApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { formatDateTime } from '@/lib/utils'
import {
  interfaceStatusVariant,
  interfaceTypeIcons,
  getDefaultInterfaceConfig,
  maskSecret,
  getInterfaceConfigSummary,
} from './constants'
import type { AgentInterface } from '@/types'

interface InterfacesTabProps {
  agentId: string
  interfaces: AgentInterface[]
}

export function InterfacesTab({ agentId, interfaces }: InterfacesTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [deployInterfaceOpen, setDeployInterfaceOpen] = useState(false)
  const [newInterfaceType, setNewInterfaceType] = useState<string>('chat_widget')
  const [newInterfaceName, setNewInterfaceName] = useState('')
  const [interfaceConfig, setInterfaceConfig] = useState<Record<string, any>>({
    welcomeMessage: '',
    primaryColor: '#8b5cf6',
    position: 'bottom-right',
    theme: 'auto',
  })

  const deployInterfaceMutation = useMutation({
    mutationFn: async () => {
      return interfacesApi.create({
        agentId,
        type: newInterfaceType,
        name: newInterfaceName || `${newInterfaceType} interface`,
        configuration: interfaceConfig,
      })
    },
    onSuccess: () => {
      success('Interface Deployed', 'Interface has been created.')
      queryClient.invalidateQueries({ queryKey: ['agent-interfaces', agentId] })
      setDeployInterfaceOpen(false)
      setNewInterfaceName('')
      setNewInterfaceType('chat_widget')
      setInterfaceConfig(getDefaultInterfaceConfig('chat_widget'))
    },
    onError: (err: any) => {
      errorNotif('Deploy Failed', err?.response?.data?.message || err?.message || 'Failed to deploy interface')
    },
  })

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Deployed Interfaces</h3>
          <p className="text-xs text-muted-foreground">Channels where this agent is accessible</p>
        </div>
        <Button size="sm" onClick={() => setDeployInterfaceOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Deploy Interface
        </Button>
      </div>

      {interfaces.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <p className="text-sm text-muted-foreground text-center">
              No interfaces deployed yet. Deploy an interface to make this agent accessible via chat widgets, Slack, Discord, and more.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {interfaces.map((iface) => {
            const configSummary = getInterfaceConfigSummary(iface.type, iface.configuration)
            const isWebhookType = ['slack', 'discord', 'telegram', 'whatsapp', 'email', 'webhook', 'google_chat', 'microsoft_teams', 'signal', 'matrix', 'irc'].includes(iface.type)
            const webhookUrl = isWebhookType ? `https://api.staging.almyty.com/interfaces/${iface.id}/webhook` : null
            const embedSnippet = iface.type === 'chat_widget' ? `<script src="https://api.staging.almyty.com/widget/${iface.id}"></script>` : null

            return (
              <Card key={iface.id} className="hover:shadow-md transition-shadow">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{interfaceTypeIcons[iface.type] || '🔌'}</span>
                      <div>
                        <div className="font-medium text-sm">{iface.name}</div>
                        <div className="text-xs text-muted-foreground">{iface.type.replace('_', ' ')}</div>
                      </div>
                    </div>
                    <Badge variant={interfaceStatusVariant[iface.status] || 'secondary'}>
                      {iface.status}
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

                  {/* Webhook URL or Embed snippet */}
                  {webhookUrl && (
                    <div className="mb-3 rounded border bg-muted/30 p-2">
                      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Webhook URL</div>
                      <div className="flex items-center gap-1">
                        <code className="text-[11px] break-all flex-1">{webhookUrl}</code>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          aria-label="Copy webhook URL"
                          onClick={() => { navigator.clipboard.writeText(webhookUrl); success('Copied', 'Webhook URL copied to clipboard.') }}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  )}
                  {embedSnippet && (
                    <div className="mb-3 rounded border bg-muted/30 p-2">
                      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Embed Snippet</div>
                      <div className="flex items-center gap-1">
                        <code className="text-[11px] break-all flex-1">{embedSnippet}</code>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          aria-label="Copy embed snippet"
                          onClick={() => { navigator.clipboard.writeText(embedSnippet); success('Copied', 'Embed snippet copied to clipboard.') }}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="space-y-1 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      <span>{iface.totalMessages} message{iface.totalMessages !== 1 ? 's' : ''}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      <span>Last active: {iface.lastMessageAt ? formatDateTime(iface.lastMessageAt) : 'Never'}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Deploy Interface Dialog */}
      <Dialog open={deployInterfaceOpen} onOpenChange={setDeployInterfaceOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Deploy Interface</DialogTitle>
            <DialogDescription>
              Deploy this agent to a new channel.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="interface-type">Type</Label>
              <Select value={newInterfaceType} onValueChange={(val) => { setNewInterfaceType(val); setInterfaceConfig(getDefaultInterfaceConfig(val)) }}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat_widget">Chat Widget</SelectItem>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="discord">Discord</SelectItem>
                  <SelectItem value="telegram">Telegram</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                  <SelectItem value="google_chat">Google Chat</SelectItem>
                  <SelectItem value="microsoft_teams">Microsoft Teams</SelectItem>
                  <SelectItem value="signal">Signal</SelectItem>
                  <SelectItem value="matrix">Matrix</SelectItem>
                  <SelectItem value="irc">IRC</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="interface-name">Name</Label>
              <Input
                id="interface-name"
                placeholder={`${newInterfaceType.replace('_', ' ')} interface`}
                value={newInterfaceName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewInterfaceName(e.target.value)}
                className="mt-1"
              />
            </div>

            {/* Type-specific configuration */}
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
                <div>
                  <Label htmlFor="cfg-position">Position</Label>
                  <Select value={interfaceConfig.position || 'bottom-right'} onValueChange={(val) => setInterfaceConfig(prev => ({ ...prev, position: val }))}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bottom-right">Bottom Right</SelectItem>
                      <SelectItem value="bottom-left">Bottom Left</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="cfg-theme">Theme</Label>
                  <Select value={interfaceConfig.theme || 'auto'} onValueChange={(val) => setInterfaceConfig(prev => ({ ...prev, theme: val }))}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                      <SelectItem value="auto">Auto</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {newInterfaceType === 'slack' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Slack Settings</p>
                <div>
                  <Label htmlFor="cfg-slack-token">Bot Token</Label>
                  <Input
                    id="cfg-slack-token"
                    type="password"
                    placeholder="xoxb-..."
                    value={interfaceConfig.botToken || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botToken: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-slack-secret">Signing Secret</Label>
                  <Input
                    id="cfg-slack-secret"
                    type="password"
                    placeholder="Signing secret"
                    value={interfaceConfig.signingSecret || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, signingSecret: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-slack-channels">Channel IDs</Label>
                  <Input
                    id="cfg-slack-channels"
                    placeholder="C01234, C56789"
                    value={interfaceConfig.channelIds || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, channelIds: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'discord' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Discord Settings</p>
                <div>
                  <Label htmlFor="cfg-discord-token">Bot Token</Label>
                  <Input
                    id="cfg-discord-token"
                    type="password"
                    placeholder="Bot token"
                    value={interfaceConfig.botToken || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botToken: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-discord-guilds">Guild IDs</Label>
                  <Input
                    id="cfg-discord-guilds"
                    placeholder="123456789, 987654321"
                    value={interfaceConfig.guildIds || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, guildIds: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'telegram' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Telegram Settings</p>
                <div>
                  <Label htmlFor="cfg-telegram-token">Bot Token</Label>
                  <Input
                    id="cfg-telegram-token"
                    type="password"
                    placeholder="123456:ABC-DEF..."
                    value={interfaceConfig.botToken || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botToken: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'whatsapp' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">WhatsApp Settings</p>
                <div>
                  <Label htmlFor="cfg-wa-sid">Twilio Account SID</Label>
                  <Input
                    id="cfg-wa-sid"
                    placeholder="AC..."
                    value={interfaceConfig.accountSid || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, accountSid: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-wa-auth">Twilio Auth Token</Label>
                  <Input
                    id="cfg-wa-auth"
                    type="password"
                    placeholder="Auth token"
                    value={interfaceConfig.authToken || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, authToken: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-wa-phone">Phone Number</Label>
                  <Input
                    id="cfg-wa-phone"
                    placeholder="+1234567890"
                    value={interfaceConfig.phoneNumber || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, phoneNumber: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'email' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Email Settings</p>
                <div>
                  <Label htmlFor="cfg-email-key">Resend API Key</Label>
                  <Input
                    id="cfg-email-key"
                    type="password"
                    placeholder="re_..."
                    value={interfaceConfig.resendApiKey || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, resendApiKey: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-email-from">Reply From Address</Label>
                  <Input
                    id="cfg-email-from"
                    placeholder="agent@yourdomain.com"
                    value={interfaceConfig.replyFrom || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, replyFrom: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-email-receive">Receive Address</Label>
                  <Input
                    id="cfg-email-receive"
                    placeholder="inbox@yourdomain.com"
                    value={interfaceConfig.receiveAddress || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, receiveAddress: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'webhook' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Webhook Settings</p>
                <div>
                  <Label htmlFor="cfg-webhook-url">Callback URL</Label>
                  <Input
                    id="cfg-webhook-url"
                    placeholder="https://..."
                    value={interfaceConfig.callbackUrl || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, callbackUrl: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-webhook-secret">Secret</Label>
                  <Input
                    id="cfg-webhook-secret"
                    type="password"
                    placeholder="HMAC verification secret"
                    value={interfaceConfig.secret || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, secret: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'google_chat' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Google Chat Settings</p>
                <div>
                  <Label htmlFor="cfg-gchat-webhook">Webhook URL</Label>
                  <Input
                    id="cfg-gchat-webhook"
                    placeholder="https://chat.googleapis.com/v1/spaces/..."
                    value={interfaceConfig.webhookUrl || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, webhookUrl: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-gchat-space">Space ID</Label>
                  <Input
                    id="cfg-gchat-space"
                    placeholder="spaces/AAAA..."
                    value={interfaceConfig.spaceId || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, spaceId: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'microsoft_teams' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Microsoft Teams Settings</p>
                <div>
                  <Label htmlFor="cfg-teams-botid">Bot ID</Label>
                  <Input
                    id="cfg-teams-botid"
                    placeholder="Bot (App) ID"
                    value={interfaceConfig.botId || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botId: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-teams-password">Bot Password</Label>
                  <Input
                    id="cfg-teams-password"
                    type="password"
                    placeholder="Bot password / client secret"
                    value={interfaceConfig.botPassword || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botPassword: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-teams-tenant">Tenant ID</Label>
                  <Input
                    id="cfg-teams-tenant"
                    placeholder="Azure AD Tenant ID"
                    value={interfaceConfig.tenantId || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, tenantId: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'signal' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Signal Settings</p>
                <div>
                  <Label htmlFor="cfg-signal-phone">Signal Phone Number</Label>
                  <Input
                    id="cfg-signal-phone"
                    placeholder="+1234567890"
                    value={interfaceConfig.phoneNumber || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, phoneNumber: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-signal-api">signal-cli API URL</Label>
                  <Input
                    id="cfg-signal-api"
                    placeholder="http://localhost:8080"
                    value={interfaceConfig.apiUrl || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, apiUrl: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'matrix' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Matrix Settings</p>
                <div>
                  <Label htmlFor="cfg-matrix-hs">Homeserver URL</Label>
                  <Input
                    id="cfg-matrix-hs"
                    placeholder="https://matrix.org"
                    value={interfaceConfig.homeserverUrl || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, homeserverUrl: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-matrix-token">Access Token</Label>
                  <Input
                    id="cfg-matrix-token"
                    type="password"
                    placeholder="syt_..."
                    value={interfaceConfig.accessToken || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, accessToken: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-matrix-room">Room ID</Label>
                  <Input
                    id="cfg-matrix-room"
                    placeholder="!abc123:matrix.org"
                    value={interfaceConfig.roomId || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, roomId: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'irc' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">IRC Settings</p>
                <div>
                  <Label htmlFor="cfg-irc-server">Server</Label>
                  <Input
                    id="cfg-irc-server"
                    placeholder="irc.libera.chat"
                    value={interfaceConfig.server || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, server: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-irc-port">Port</Label>
                  <Input
                    id="cfg-irc-port"
                    placeholder="6667"
                    value={interfaceConfig.port || '6667'}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, port: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-irc-channel">Channel</Label>
                  <Input
                    id="cfg-irc-channel"
                    placeholder="#my-channel"
                    value={interfaceConfig.channel || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, channel: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-irc-nick">Nick</Label>
                  <Input
                    id="cfg-irc-nick"
                    placeholder="mybot"
                    value={interfaceConfig.nick || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, nick: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            <Button
              className="w-full"
              disabled={deployInterfaceMutation.isPending}
              onClick={() => deployInterfaceMutation.mutate()}
            >
              {deployInterfaceMutation.isPending ? (
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
