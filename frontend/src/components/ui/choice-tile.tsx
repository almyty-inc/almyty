import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * One choice in a grid of tiles: the look of the provider tiles on
 * Models > Connect a provider, for any pick-one list (a sign-in
 * provider, who can use an app). `selected` marks the current choice;
 * `hint` is one short line under the label.
 */
export function ChoiceTile({
  icon,
  label,
  hint,
  selected = false,
  disabled = false,
  onClick,
  testId,
}: {
  icon?: ReactNode
  label: string
  hint?: string
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
        {icon && (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-base" aria-hidden>
            {icon}
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate font-medium">{label}</span>
          {hint && <span className="block truncate text-xs text-muted-foreground">{hint}</span>}
        </span>
      </button>
    </li>
  )
}

/** The grid the tiles sit in, as on Connect a provider. */
export function ChoiceTiles({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-label={label}>
      {children}
    </ul>
  )
}
