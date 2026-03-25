import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const protocolStyles: Record<string, string> = {
  mcp: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  a2a: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  utcp: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  skills: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  soap: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  graphql: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
  rest: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  openapi: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
}

interface ProtocolBadgeProps {
  protocol: string
  className?: string
}

export function ProtocolBadge({ protocol, className }: ProtocolBadgeProps) {
  const key = protocol.toLowerCase()
  const style = protocolStyles[key] || 'bg-gray-50 text-gray-700 border-gray-200'

  return (
    <Badge variant="outline" className={cn('text-xs font-medium uppercase', style, className)}>
      {protocol.toUpperCase()}
    </Badge>
  )
}
