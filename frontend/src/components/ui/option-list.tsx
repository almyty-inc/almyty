/**
 * Pick one from a list: a row per option with its icon, its name and one
 * line saying what it is. A radio group, so arrows move between rows and
 * picking a row only selects it. Whatever the choice leads to happens on
 * the form's own submit, never on the click.
 *
 * The list form of a choice, in place of a grid of tiles: it reads top to
 * bottom on a phone and a desktop alike, and optional group headings keep
 * a long list (the kinds of channel) scannable.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Check } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface OptionListItem<T extends string> {
  value: T
  label: string
  hint?: string
  icon?: ReactNode
  disabled?: boolean
}

export interface OptionListGroup<T extends string> {
  label: string
  options: OptionListItem<T>[]
}

interface OptionListProps<T extends string> {
  /** The group's accessible name ("Kind of channel"). */
  label: string
  /** Flat options, or headed groups of them. */
  options?: OptionListItem<T>[]
  groups?: OptionListGroup<T>[]
  value: T | null
  onChange: (value: T) => void
  disabled?: boolean
  /** data-testid prefix: each row is `${testIdPrefix}-${value}`. */
  testIdPrefix?: string
  className?: string
}

export function OptionList<T extends string>({
  label,
  options,
  groups,
  value,
  onChange,
  disabled = false,
  testIdPrefix,
  className,
}: OptionListProps<T>) {
  const baseId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const sections: OptionListGroup<T>[] = groups ?? [{ label: '', options: options ?? [] }]
  const flat = sections.flatMap((s) => s.options)
  // One tab stop for the whole group: the selected row, else the first.
  const focusValue = flat.find((o) => o.value === value && !o.disabled)?.value ?? flat.find((o) => !o.disabled)?.value

  const move = (from: T, step: 1 | -1) => {
    const enabled = flat.filter((o) => !o.disabled)
    const at = enabled.findIndex((o) => o.value === from)
    const next = enabled[(at + step + enabled.length) % enabled.length]
    if (!next) return
    onChange(next.value)
    rootRef.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, v: T) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      move(v, 1)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      move(v, -1)
    }
  }

  return (
    <div ref={rootRef} role="radiogroup" aria-label={label} className={cn('space-y-5', className)}>
      {sections.map((section, si) => {
        const headingId = `${baseId}-g${si}`
        return (
          <div key={section.label || si} className="space-y-2">
            {section.label && (
              <p id={headingId} className="text-xs font-semibold text-muted-foreground">
                {section.label}
              </p>
            )}
            <ul
              className="divide-y overflow-hidden rounded-xl border bg-card"
              aria-labelledby={section.label ? headingId : undefined}
            >
              {section.options.map((o) => {
                const selected = o.value === value
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-value={o.value}
                      data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
                      tabIndex={o.value === focusValue ? 0 : -1}
                      disabled={disabled || o.disabled}
                      onClick={() => onChange(o.value)}
                      onKeyDown={(e) => onKeyDown(e, o.value)}
                      className={cn(
                        'flex w-full min-h-[56px] items-center gap-3 px-4 py-3 text-left text-sm transition-colors duration-[120ms]',
                        'hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        'disabled:cursor-not-allowed disabled:opacity-60',
                        selected && 'bg-selection text-selection-foreground hover:bg-selection',
                      )}
                    >
                      {o.icon && (
                        <span
                          aria-hidden
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-background [&>svg]:h-5 [&>svg]:w-5"
                        >
                          {o.icon}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">{o.label}</span>
                        {o.hint && <span className="block text-xs text-muted-foreground">{o.hint}</span>}
                      </span>
                      <span
                        aria-hidden
                        className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                        )}
                      >
                        {selected && <Check className="h-3 w-3" />}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
