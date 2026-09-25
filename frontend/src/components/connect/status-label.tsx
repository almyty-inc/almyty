import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react'

import { cn } from '@/lib/utils'

/** Whether something connected works, in two words. */
export interface ServiceCheck {
  state: 'ok' | 'rejected' | 'failed' | 'unchecked'
  label: string
  /** The service's own words, when the last check failed. */
  error?: string
}

/**
 * The status line every connected thing shows: green when it works, red
 * when it needs attention, grey when nobody checked yet. Models says "Key
 * works" / "Key rejected"; Connections says "Works" / "Needs attention".
 */
export function StatusLabel({ check, className, testId = 'service-status' }: { check: ServiceCheck; className?: string; testId?: string }) {
  const Icon = check.state === 'ok' ? CheckCircle2 : check.state === 'unchecked' ? CircleDashed : XCircle
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        check.state === 'ok' && 'text-emerald-700 dark:text-emerald-400',
        (check.state === 'rejected' || check.state === 'failed') && 'text-destructive',
        check.state === 'unchecked' && 'text-muted-foreground',
        className,
      )}
      title={check.error}
      data-testid={testId}
      data-state={check.state}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {check.label}
    </span>
  )
}
