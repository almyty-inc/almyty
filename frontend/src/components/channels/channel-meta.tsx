import type { LucideIcon } from 'lucide-react'
import { Bot, Code2, Globe, Hash, Mail, MessagesSquare, Monitor, Smartphone, Terminal, Users, Webhook } from 'lucide-react'

import { BRAND_ICONS, BrandIcon } from '@/components/brand-icon'
import { cn } from '@/lib/utils'
import type { ChannelStatus, ChannelType } from '@/lib/agent-channels'

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

/**
 * The icon for each kind of channel that has no brand mark to draw: the
 * platform's own mark is used where the icon set has one (BRAND_ICONS),
 * and these cover the rest, so no two kinds share one generic chat bubble.
 */
const CHANNEL_GLYPHS: Partial<Record<ChannelType, LucideIcon>> = {
  web: Globe,
  widget: Code2,
  tui: Terminal,
  desktop: Monitor,
  a2a: Bot,
  email: Mail,
  sms: Smartphone,
  webhook: Webhook,
  slack: Hash,
  microsoft_teams: Users,
  irc: MessagesSquare,
}

/** The icon a channel shows next to its name. */
export function ChannelIcon({ type, className }: { type: ChannelType; className?: string }) {
  if (BRAND_ICONS[type]) return <BrandIcon brand={type} name={type} className={className} />
  const Glyph = CHANNEL_GLYPHS[type] ?? Globe
  return <Glyph className={cn('h-4 w-4 text-primary', className)} aria-hidden="true" data-channel-icon={type} />
}