import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const typeStyles: Record<string, string> = {
  openapi: 'bg-blue-50 text-blue-700 border-blue-200',
  graphql: 'bg-pink-50 text-pink-700 border-pink-200',
  soap: 'bg-amber-50 text-amber-700 border-amber-200',
  protobuf: 'bg-violet-50 text-violet-700 border-violet-200',
  other: 'bg-gray-50 text-gray-700 border-gray-200',
}

const typeLabels: Record<string, string> = {
  openapi: 'OpenAPI',
  graphql: 'GraphQL',
  soap: 'SOAP',
  protobuf: 'Protobuf',
  other: 'Other',
}

interface ApiTypeBadgeProps {
  type: string
  className?: string
}

export function ApiTypeBadge({ type, className }: ApiTypeBadgeProps) {
  const key = type.toLowerCase()
  const style = typeStyles[key] || typeStyles.other
  const label = typeLabels[key] || type

  return (
    <Badge variant="outline" className={cn('text-xs font-medium', style, className)}>
      {label}
    </Badge>
  )
}
