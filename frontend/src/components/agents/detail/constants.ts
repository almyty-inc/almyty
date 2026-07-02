/**
 * Shared constants, variant maps, and helper functions used across
 * agent detail sub-components.
 */

export const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success'> = {
  active: 'success',
  draft: 'outline',
  inactive: 'secondary',
  error: 'destructive',
}

export const execStatusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  running: 'secondary',
  pending: 'outline',
  failed: 'destructive',
  cancelled: 'secondary',
  timeout: 'destructive',
}

export const runStatusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success'> = {
  pending: 'secondary',
  running: 'default',
  waiting_input: 'outline',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
  timeout: 'destructive',
}

export const interfaceStatusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success'> = {
  active: 'success',
  inactive: 'secondary',
  error: 'destructive',
}

export const interfaceTypeIcons: Record<string, string> = {
  chat_widget: '💬',
  slack: '📱',
  discord: '🎮',
  telegram: '✈️',
  whatsapp: '📞',
  email: '📧',
  webhook: '🔗',
  google_chat: '🟢',
  microsoft_teams: '🟣',
  signal: '🔵',
  matrix: '🟩',
  irc: '⌨️',
}

export function getDefaultInterfaceConfig(type: string): Record<string, any> {
  switch (type) {
    case 'chat_widget':
      return { welcomeMessage: '', primaryColor: '#8b5cf6', position: 'bottom-right', theme: 'auto' }
    case 'slack':
      return { botToken: '', signingSecret: '', channelIds: '' }
    case 'discord':
      return { botToken: '', guildIds: '' }
    case 'telegram':
      return { botToken: '' }
    case 'whatsapp':
      return { accountSid: '', authToken: '', phoneNumber: '' }
    case 'sms':
      return { accountSid: '', authToken: '', phoneNumber: '' }
    case 'whatsapp_cloud':
      return { accessToken: '', phoneNumberId: '', verifyToken: '', appSecret: '' }
    case 'email':
      return { resendApiKey: '', replyFrom: '', receiveAddress: '' }
    case 'webhook':
      return { callbackUrl: '', secret: '' }
    case 'google_chat':
      return { webhookUrl: '', spaceId: '' }
    case 'microsoft_teams':
      return { botId: '', botPassword: '', tenantId: '' }
    case 'signal':
      return { phoneNumber: '', apiUrl: '' }
    case 'matrix':
      return { homeserverUrl: '', accessToken: '', roomId: '' }
    case 'irc':
      return { server: '', port: '6667', channel: '', nick: '' }
    default:
      return {}
  }
}

export function maskSecret(value: string): string {
  if (!value || value.length <= 4) return '****'
  return value.slice(0, 4) + '****'
}

export function getInterfaceConfigSummary(type: string, config: Record<string, any>): { label: string; value: string; secret?: boolean }[] {
  if (!config) return []
  switch (type) {
    case 'chat_widget':
      return [
        { label: 'Welcome', value: config.welcomeMessage || '(default)' },
        { label: 'Color', value: config.primaryColor || '#8b5cf6' },
        { label: 'Position', value: config.position || 'bottom-right' },
        { label: 'Theme', value: config.theme || 'auto' },
      ]
    case 'slack':
      return [
        { label: 'Bot Token', value: config.botToken || '', secret: true },
        { label: 'Signing Secret', value: config.signingSecret || '', secret: true },
        { label: 'Channels', value: config.channelIds || '' },
      ]
    case 'discord':
      return [
        { label: 'Bot Token', value: config.botToken || '', secret: true },
        { label: 'Guild IDs', value: config.guildIds || '' },
      ]
    case 'telegram':
      return [
        { label: 'Bot Token', value: config.botToken || '', secret: true },
      ]
    case 'whatsapp':
      return [
        { label: 'Account SID', value: config.accountSid || '' },
        { label: 'Auth Token', value: config.authToken || '', secret: true },
        { label: 'Phone', value: config.phoneNumber || '' },
      ]
    case 'sms':
      return [
        { label: 'Account SID', value: config.accountSid || '' },
        { label: 'Auth Token', value: config.authToken || '', secret: true },
        { label: 'Phone', value: config.phoneNumber || '' },
      ]
    case 'whatsapp_cloud':
      return [
        { label: 'Access Token', value: config.accessToken || '', secret: true },
        { label: 'Phone Number ID', value: config.phoneNumberId || '' },
        { label: 'Verify Token', value: config.verifyToken || '', secret: true },
        { label: 'App Secret', value: config.appSecret || '', secret: true },
      ]
    case 'email':
      return [
        { label: 'API Key', value: config.resendApiKey || '', secret: true },
        { label: 'Reply From', value: config.replyFrom || '' },
        { label: 'Receive At', value: config.receiveAddress || '' },
      ]
    case 'webhook':
      return [
        { label: 'URL', value: config.callbackUrl || '' },
        { label: 'Secret', value: config.secret || '', secret: true },
      ]
    case 'google_chat':
      return [
        { label: 'Webhook URL', value: config.webhookUrl || '', secret: true },
        { label: 'Space ID', value: config.spaceId || '' },
      ]
    case 'microsoft_teams':
      return [
        { label: 'Bot ID', value: config.botId || '' },
        { label: 'Bot Password', value: config.botPassword || '', secret: true },
        { label: 'Tenant ID', value: config.tenantId || '' },
      ]
    case 'signal':
      return [
        { label: 'Phone Number', value: config.phoneNumber || '' },
        { label: 'API URL', value: config.apiUrl || '' },
      ]
    case 'matrix':
      return [
        { label: 'Homeserver', value: config.homeserverUrl || '' },
        { label: 'Access Token', value: config.accessToken || '', secret: true },
        { label: 'Room ID', value: config.roomId || '' },
      ]
    case 'irc':
      return [
        { label: 'Server', value: config.server || '' },
        { label: 'Port', value: config.port || '6667' },
        { label: 'Channel', value: config.channel || '' },
        { label: 'Nick', value: config.nick || '' },
      ]
    default:
      return []
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export function diffObjects(prev: Record<string, any>, curr: Record<string, any>): { field: string; from: any; to: any }[] {
  const changes: { field: string; from: any; to: any }[] = []
  const allKeys = new Set([...Object.keys(prev || {}), ...Object.keys(curr || {})])
  for (const key of allKeys) {
    if (JSON.stringify(prev?.[key]) !== JSON.stringify(curr?.[key])) {
      changes.push({ field: key, from: prev?.[key], to: curr?.[key] })
    }
  }
  return changes
}

export function formatDiffValue(value: any): string {
  if (value === undefined || value === null) return '(none)'
  if (typeof value === 'object') {
    const str = JSON.stringify(value)
    return str.length > 60 ? str.slice(0, 60) + '...' : str
  }
  const str = String(value)
  return str.length > 60 ? str.slice(0, 60) + '...' : str
}
