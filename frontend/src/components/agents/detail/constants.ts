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

/**
 * Default (empty) configuration per channel type. Keys MUST be exactly
 * the snake_case keys the backend channel adapters read
 * (backend/src/modules/gateways/channels/adapters/*) — the deploy
 * dialog used to write camelCase (botToken) that no adapter looked at.
 * The chat widget is the one exception: the widget script reads
 * camelCase presentation keys.
 * A completeness test pins these against the adapter-read key list.
 */
export function getDefaultInterfaceConfig(type: string): Record<string, any> {
  switch (type) {
    case 'chat_widget':
      return { welcomeMessage: '', primaryColor: '#8b5cf6', position: 'bottom-right', theme: 'auto' }
    case 'slack':
      return { bot_token: '', signing_secret: '' }
    case 'discord':
      return { bot_token: '' }
    case 'telegram':
      return { bot_token: '' }
    case 'whatsapp':
      return { twilio_account_sid: '', twilio_auth_token: '', phone_number: '' }
    case 'sms':
      return { twilio_account_sid: '', twilio_auth_token: '', phone_number: '' }
    case 'whatsapp_cloud':
      return { access_token: '', phone_number_id: '', verify_token: '', app_secret: '' }
    case 'email':
      return { resend_api_key: '', reply_from: '' }
    case 'webhook':
      return { callback_url: '', secret: '' }
    case 'google_chat':
      return { webhook_url: '', verification_token: '' }
    case 'microsoft_teams':
      return { bot_id: '', bot_password: '' }
    case 'signal':
      return { phone_number: '', api_url: '' }
    case 'matrix':
      return { homeserver_url: '', access_token: '', room_id: '' }
    case 'irc':
      return { webhook_url: '', channel: '', nick: '' }
    default:
      return {}
  }
}

export function maskSecret(value: string): string {
  if (!value || value.length <= 4) return '****'
  return value.slice(0, 4) + '****'
}

/**
 * Card summary per channel type. Reads the canonical snake_case keys
 * (what adapters read); the camelCase fallbacks keep summaries working
 * for channels deployed before the key-casing fix.
 */
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
        { label: 'Bot Token', value: config.bot_token || config.botToken || '', secret: true },
        { label: 'Signing Secret', value: config.signing_secret || config.signingSecret || '', secret: true },
      ]
    case 'discord':
      return [
        { label: 'Bot Token', value: config.bot_token || config.botToken || '', secret: true },
      ]
    case 'telegram':
      return [
        { label: 'Bot Token', value: config.bot_token || config.botToken || '', secret: true },
      ]
    case 'whatsapp':
    case 'sms':
      return [
        { label: 'Account SID', value: config.twilio_account_sid || config.accountSid || '' },
        { label: 'Auth Token', value: config.twilio_auth_token || config.authToken || '', secret: true },
        { label: 'Phone', value: config.phone_number || config.phoneNumber || '' },
      ]
    case 'whatsapp_cloud':
      return [
        { label: 'Access Token', value: config.access_token || config.accessToken || '', secret: true },
        { label: 'Phone Number ID', value: config.phone_number_id || config.phoneNumberId || '' },
        { label: 'Verify Token', value: config.verify_token || config.verifyToken || '', secret: true },
        { label: 'App Secret', value: config.app_secret || config.appSecret || '', secret: true },
      ]
    case 'email':
      return [
        { label: 'API Key', value: config.resend_api_key || config.resendApiKey || '', secret: true },
        { label: 'Reply From', value: config.reply_from || config.replyFrom || '' },
        { label: 'Receive At', value: config.inbound_address || config.receiveAddress || '' },
      ]
    case 'webhook':
      return [
        { label: 'URL', value: config.callback_url || config.callbackUrl || '' },
        { label: 'Secret', value: config.secret || '', secret: true },
      ]
    case 'google_chat':
      return [
        { label: 'Webhook URL', value: config.webhook_url || config.webhookUrl || '', secret: true },
      ]
    case 'microsoft_teams':
      return [
        { label: 'Bot ID', value: config.bot_id || config.botId || '' },
        { label: 'Bot Password', value: config.bot_password || config.botPassword || '', secret: true },
      ]
    case 'signal':
      return [
        { label: 'Phone Number', value: config.phone_number || config.phoneNumber || '' },
        { label: 'API URL', value: config.api_url || config.apiUrl || '' },
      ]
    case 'matrix':
      return [
        { label: 'Homeserver', value: config.homeserver_url || config.homeserverUrl || '' },
        { label: 'Access Token', value: config.access_token || config.accessToken || '', secret: true },
        { label: 'Room ID', value: config.room_id || config.roomId || '' },
      ]
    case 'irc':
      return [
        { label: 'Bridge URL', value: config.webhook_url || config.webhookUrl || '' },
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
