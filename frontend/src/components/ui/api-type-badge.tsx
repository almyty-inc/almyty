import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const typeStyles: Record<string, string> = {
  openapi: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/30',
  graphql: 'bg-pink-100 text-pink-700 border-pink-200 dark:bg-pink-500/20 dark:text-pink-300 dark:border-pink-500/30',
  soap: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/30',
  protobuf: 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-500/20 dark:text-violet-300 dark:border-violet-500/30',
  other: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-500/20 dark:text-zinc-300 dark:border-zinc-500/30',
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
