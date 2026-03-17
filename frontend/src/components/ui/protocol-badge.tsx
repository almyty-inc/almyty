import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const protocolStyles: Record<string, string> = {
  mcp: 'bg-blue-50 text-blue-700 border-blue-200',
  a2a: 'bg-purple-50 text-purple-700 border-purple-200',
  utcp: 'bg-orange-50 text-orange-700 border-orange-200',
  skills: 'bg-green-50 text-green-700 border-green-200',
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
