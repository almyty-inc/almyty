import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Protocol and channel identity, not readiness: each kind keeps its own
// readable hue with a light and a dark half (docs/brand/colors.md).
// MCP is the brand blue; REST is slate so the two never read as one.
const BRAND = 'bg-brand-50 text-brand-700 border-brand-200 dark:bg-brand-500/15 dark:text-brand-200 dark:border-brand-500/30'
const TEAL = 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-500/15 dark:text-teal-300 dark:border-teal-500/30'
const EMERALD = 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30'
const SLATE = 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-500/20 dark:text-slate-300 dark:border-slate-500/30'

const protocolStyles: Record<string, string> = {
  mcp: BRAND,
  a2a: TEAL,
  utcp: EMERALD,
  skills: EMERALD,
  tools: BRAND,
  soap: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  graphql: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30',
  rest: SLATE,
  openapi: SLATE,
  slack: BRAND,
  discord: BRAND,
  telegram: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/20 dark:text-sky-300 dark:border-sky-500/30',
  whatsapp: 'bg-green-100 text-green-700 border-green-200 dark:bg-green-500/20 dark:text-green-300 dark:border-green-500/30',
  email: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/20 dark:text-orange-300 dark:border-orange-500/30',
  webhook: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-500/20 dark:text-zinc-300 dark:border-zinc-500/30',
  google_chat: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/30',
  microsoft_teams: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/30',
  signal: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/30',
  matrix: 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/20 dark:text-teal-300 dark:border-teal-500/30',
  irc: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-500/20 dark:text-zinc-300 dark:border-zinc-500/30',
  chat_widget: BRAND,
  whatsapp_cloud: 'bg-green-100 text-green-700 border-green-200 dark:bg-green-500/20 dark:text-green-300 dark:border-green-500/30',
  sms: 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-500/20 dark:text-teal-300 dark:border-teal-500/30',
  imessage_sendblue: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/20 dark:text-sky-300 dark:border-sky-500/30',
  imessage_loopmessage: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/20 dark:text-sky-300 dark:border-sky-500/30',
  // App distribution mediums (the agent factory), so a Web / Terminal /
  // Desktop / Binary badge reads on-brand rather than as the unknown
  // grey fallback.
  web: BRAND,
  tui: TEAL,
  desktop: TEAL,
  binary: TEAL,
  widget: BRAND,
}

const protocolLabels: Record<string, string> = {
  tools: 'MCP · UTCP · Skills',
  google_chat: 'Google Chat',
  microsoft_teams: 'Teams',
  chat_widget: 'Chat Widget',
  whatsapp_cloud: 'WhatsApp Cloud',
  imessage_sendblue: 'iMessage · Sendblue',
  imessage_loopmessage: 'iMessage · LoopMessage',
  tui: 'Terminal',
  web: 'Web',
  widget: 'Widget',
}

interface ProtocolBadgeProps {
  protocol: string
  /** Overrides the text; the colour still comes from `protocol`. */
  label?: string
  className?: string
}

export function ProtocolBadge({ protocol, label, className }: ProtocolBadgeProps) {
  const key = protocol.toLowerCase()
  const style = protocolStyles[key] || 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-500/20 dark:text-zinc-300 dark:border-zinc-500/30'

  return (
    <Badge variant="outline" className={cn('text-xs font-medium uppercase', style, className)}>
      {label ?? (protocolLabels[key] || protocol.replace(/_/g, ' ').toUpperCase())}
    </Badge>
  )
}
