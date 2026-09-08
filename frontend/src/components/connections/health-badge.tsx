import { Badge } from '@/components/ui/badge'
import type { ConnectionHealth, ConnectionHealthStatus } from '@/types/connections'

const HEALTH: Record<ConnectionHealthStatus, { label: string; variant: 'success' | 'warning' | 'destructive' | 'outline' | 'secondary' }> = {
  valid: { label: 'Valid', variant: 'success' },
  expired: { label: 'Expired', variant: 'warning' },
  quota: { label: 'Quota', variant: 'warning' },
  revoked: { label: 'Revoked', variant: 'destructive' },
  failed: { label: 'Failed', variant: 'destructive' },
  unknown: { label: 'Unchecked', variant: 'outline' },
}

export function healthLabel(status: ConnectionHealthStatus | undefined): string {
  return HEALTH[status ?? 'unknown']?.label ?? 'Unchecked'
}

export function ConnectionHealthBadge({ health, className }: { health: ConnectionHealth | undefined; className?: string }) {
  const status = health?.status ?? 'unknown'
  const meta = HEALTH[status] ?? HEALTH.unknown
  return (
    <Badge variant={meta.variant} className={className} title={health?.error || undefined} data-testid="connection-health" data-status={status}>
      {meta.label}
    </Badge>
  )
}
