/**
 * A run's lifecycle state, from the design system's run-status map: one
 * label, tone and icon per state of the runtime union, with `sleeping` a
 * pause rather than an end. An unknown status reads "Status unavailable",
 * never a guessed state.
 *
 * Lifecycle only: a completed run is not proof that the work it asked for
 * succeeded, so failed or staged steps stay visible beside this badge.
 */
import {
  Activity,
  CircleCheck,
  CircleHelp,
  CirclePause,
  CircleSlash,
  CircleX,
  Clock,
  Loader2,
  MessageCircle,
  Moon,
  TimerOff,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { presentationForRun, type RunTone } from '@/lib/run-status'
import { cn } from '@/lib/utils'

const ICONS: Record<string, LucideIcon> = {
  clock: Clock,
  activity: Activity,
  'message-circle': MessageCircle,
  'pause-circle': CirclePause,
  moon: Moon,
  'circle-check': CircleCheck,
  'circle-x': CircleX,
  'circle-slash': CircleSlash,
  'timer-off': TimerOff,
  'circle-help': CircleHelp,
}

const VARIANT: Record<RunTone, 'neutral' | 'info' | 'warning' | 'success' | 'destructive'> = {
  neutral: 'neutral',
  info: 'info',
  warning: 'warning',
  success: 'success',
  danger: 'destructive',
}

export function RunStatusBadge({ status, className }: { status: string; className?: string }) {
  const p = presentationForRun(status)
  // A running run spins; the rest hold still.
  const Icon = status === 'running' ? Loader2 : ICONS[p.icon] ?? CircleHelp
  return (
    <Badge variant={VARIANT[p.tone]} className={className} data-status={status}>
      <Icon className={cn('h-3.5 w-3.5 shrink-0', status === 'running' && 'animate-spin')} aria-hidden />
      {p.label}
    </Badge>
  )
}
