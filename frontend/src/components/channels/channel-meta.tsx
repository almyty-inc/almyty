import { Bot, Code2, Globe, Mail, MessageSquare, Monitor, Phone, Terminal, Webhook } from 'lucide-react'

import { cn } from '@/lib/utils'
import { isMessagingChannel, type ChannelStatus, type ChannelType } from '@/lib/agent-channels'

/** How a channel's status reads, the same on the list and on its page. */
export const CHANNEL_STATUS: Record<
  ChannelStatus,
  { label: string; variant: 'success' | 'secondary' | 'warning' | 'outline' | 'destructive' }
> = {
  live: { label: 'Live', variant: 'success' },
  built: { label: 'Built', variant: 'secondary' },
  building: { label: 'Building', variant: 'warning' },
  draft: { label: 'Draft', variant: 'outline' },
  failed: { label: 'Build failed', variant: 'destructive' },
}

/** The icon a channel shows next to its name. */
export function ChannelIcon({ type, className }: { type: ChannelType; className?: string }) {
  const cls = cn('h-4 w-4 text-primary', className)
  if (type === 'web') return <Globe className={cls} aria-hidden="true" />
  if (type === 'widget') return <Code2 className={cls} aria-hidden="true" />
  if (type === 'tui' || type === 'binary') return <Terminal className={cls} aria-hidden="true" />
  if (type === 'desktop') return <Monitor className={cls} aria-hidden="true" />
  if (type === 'a2a') return <Bot className={cls} aria-hidden="true" />
  if (type === 'email') return <Mail className={cls} aria-hidden="true" />
  if (type === 'sms') return <Phone className={cls} aria-hidden="true" />
  if (type === 'webhook') return <Webhook className={cls} aria-hidden="true" />
  if (isMessagingChannel(type)) return <MessageSquare className={cls} aria-hidden="true" />
  return <Globe className={cls} aria-hidden="true" />
}
