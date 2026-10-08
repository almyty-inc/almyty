import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Small shared pieces of the pick-something screens: the square a logo
 * sits in, and a grid of choice tiles (a kind of API, a channel, who can
 * open an app).
 */

/** The square a logo sits in, on tiles, cards and page headers. */
export function ServiceIcon({ children, size = 'sm' }: { children: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md border bg-background',
        size === 'sm' && 'h-7 w-7 text-base',
        size === 'md' && 'h-10 w-10 rounded-lg text-xl [&>svg]:h-5 [&>svg]:w-5 [&>[data-brand-fallback]]:h-6 [&>[data-brand-fallback]]:w-6 [&>[data-brand-fallback]]:text-xs',
        size === 'lg' && 'h-12 w-12 rounded-lg text-2xl [&>svg]:h-6 [&>svg]:w-6 [&>[data-brand-fallback]]:h-7 [&>[data-brand-fallback]]:w-7 [&>[data-brand-fallback]]:text-sm',
      )}
      aria-hidden
    >
      {children}
    </span>
  )
}

/**
 * One tile in a grid of them: any pick-one list (a kind of API, a sign-in
 * provider, who can open an app).
 * `selected` marks the current choice; `hint` is one short line under the label.
 */
export function ChoiceTile({
  icon,
  label,
  hint,
  selected,
  disabled = false,
  onClick,
  testId,
}: {
  icon?: ReactNode
  label: string
  hint?: string
  /** Leave unset for a plain pick (a link onward); true/false for a choice. */
  selected?: boolean
  disabled?: boolean
  onClick: () => void
  testId?: string
}) {
  return (
    <li>
      <button
        type="button"
        data-testid={testId}
        // The label and hint are cut to one line each; the whole text shows on hover.
        title={hint ? `${label}: ${hint}` : label}
        aria-pressed={selected}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-left text-sm transition-colors',
          'hover:border-primary/50 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          'disabled:cursor-not-allowed disabled:opacity-60',
          selected && 'border-primary bg-primary/5',
        )}
      >
        {icon && <ServiceIcon>{icon}</ServiceIcon>}
        <span className="min-w-0">
          <span className="block truncate font-medium">{label}</span>
          {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
        </span>
      </button>
    </li>
  )
}

/** The grid tiles sit in; `className` narrows it where tiles carry long labels. */
export function ChoiceTiles({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <ul className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4', className)} aria-label={label}>
      {children}
    </ul>
  )
}
