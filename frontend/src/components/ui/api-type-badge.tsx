import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

// Schema identity, matching ProtocolBadge: OpenAPI/REST slate, GraphQL
// rose, SOAP amber, Protobuf/gRPC fuchsia (docs/brand/colors.md).
const typeStyles: Record<string, string> = {
  openapi: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-500/20 dark:text-slate-300 dark:border-slate-500/30',
  graphql: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30',
  soap: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  protobuf: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-500/15 dark:text-fuchsia-300 dark:border-fuchsia-500/30',
  grpc: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-500/15 dark:text-fuchsia-300 dark:border-fuchsia-500/30',
  http: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-500/30',
  sdk: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-500/20 dark:text-orange-300 dark:border-orange-500/30',
  other: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-500/20 dark:text-zinc-300 dark:border-zinc-500/30',
}

const typeLabels: Record<string, string> = {
  openapi: 'OpenAPI',
  graphql: 'GraphQL',
  soap: 'SOAP',
  protobuf: 'Protobuf',
  grpc: 'gRPC',
  http: 'Custom HTTP',
  sdk: 'SDK / npm',
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
