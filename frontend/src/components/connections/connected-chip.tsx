import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Connection } from '@/types/connections'
import { ConnectionHealthBadge } from './health-badge'

/** The connection a consumer dialog picked, with a way to drop it. */
export function ConnectedChip({ connection, onClear, className }: { connection: Connection; onClear?: () => void; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-sm', className)} data-testid="connected-chip">
      <span className="truncate font-medium">{connection.name}</span>
      {connection.accountLabel && <span className="truncate text-xs text-muted-foreground">{connection.accountLabel}</span>}
      <ConnectionHealthBadge health={connection.health} />
      {onClear && (
        <Button type="button" variant="ghost" size="icon" className="ml-auto h-6 w-6" onClick={onClear} aria-label={`Remove ${connection.name}`}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
