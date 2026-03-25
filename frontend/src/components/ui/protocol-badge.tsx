import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const protocolStyles: Record<string, string> = {
  mcp: 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/20 dark:text-violet-300 dark:border-violet-500/30',
  a2a: 'bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-500/20 dark:text-cyan-300 dark:border-cyan-500/30',
  utcp: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-500/30',
  skills: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-500/30',
  soap: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/30',
  graphql: 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-500/20 dark:text-rose-300 dark:border-rose-500/30',
  rest: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/30',
  openapi: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/30',
}

interface ProtocolBadgeProps {
  protocol: string
  className?: string
}

export function ProtocolBadge({ protocol, className }: ProtocolBadgeProps) {
  const key = protocol.toLowerCase()
  const style = protocolStyles[key] || 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-500/20 dark:text-zinc-300 dark:border-zinc-500/30'

  return (
    <Badge variant="outline" className={cn('text-xs font-medium uppercase', style, className)}>
      {protocol.toUpperCase()}
    </Badge>
  )
}
