/**
 * SearchableSelect: a select with a search box, for lists too long to
 * scroll (every service a credential can be for). The trigger looks like
 * any other select; opening it shows a search box and the options, in
 * groups, each with an icon and a short line after its name. Arrow keys
 * move, Enter picks, Escape closes. The list opens under the field, in
 * the page, the way the model chooser does.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface SearchableOption {
  value: string
  label: string
  /** A short line after the label, e.g. what a custom service covers. */
  hint?: string
  icon?: ReactNode
  /** Heading of the group it is listed under. */
  group?: string
  /** Extra words a search finds it by. */
  keywords?: string[]
}

export interface SearchableSelectProps {
  id: string
  value: string | null
  onChange: (value: string) => void
  options: SearchableOption[]
  placeholder?: string
  searchPlaceholder?: string
  /** Shown when nothing matches the search. */
  empty?: ReactNode
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
  testId?: string
}

/** Every word typed is somewhere in the label, hint, value or keywords. */
export function optionMatches(option: SearchableOption, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = [option.label, option.hint, option.value, option.group, ...(option.keywords ?? [])].filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => text.includes(w))
}

export function SearchableSelect({ id, value, onChange, options, placeholder = 'Choose', searchPlaceholder = 'Search', empty, disabled, invalid, describedBy, testId = 'searchable-select' }: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const selected = options.find((o) => o.value === value) ?? null
  const shown = useMemo(() => options.filter((o) => optionMatches(o, search)), [options, search])
  const groups = useMemo(() => {
    const out: Array<{ heading?: string; items: SearchableOption[] }> = []
    for (const o of shown) {
      const last = out[out.length - 1]
      if (last && last.heading === o.group) last.items.push(o)
      else out.push({ heading: o.group, items: [o] })
    }
    return out
  }, [shown])

  useEffect(() => setActive(0), [search, open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (option: SearchableOption) => {
    setOpen(false)
    setSearch('')
    onChange(option.value)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, shown.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const option = shown[active]
      if (option) choose(option)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div className="space-y-1" ref={rootRef}>
      <button
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-testid={`${testId}-trigger`}
        disabled={disabled}
        onClick={() => {
          setOpen((v) => !v)
          window.setTimeout(() => searchRef.current?.focus(), 0)
        }}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm shadow-sm',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60',
          invalid && 'border-destructive',
        )}
      >
        <span className={cn('flex min-w-0 items-center gap-2', !selected && 'text-muted-foreground')}>
          {selected?.icon}
          <span className="truncate" data-testid={`${testId}-value`}>
            {selected ? selected.label : placeholder}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
      </button>

      {open && (
        <div className="rounded-md border bg-popover text-popover-foreground shadow-md" data-testid={`${testId}-panel`}>
          <div className="flex items-center border-b px-2.5">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              aria-label={searchPlaceholder}
              aria-controls={listId}
              aria-activedescendant={shown[active] ? `${listId}-${shown[active].value}` : undefined}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div id={listId} role="listbox" className="max-h-80 overflow-y-auto p-1">
            {shown.length === 0 && <div className="px-2 py-3 text-center text-sm text-muted-foreground">{empty ?? 'Nothing matches.'}</div>}
            {groups.map((g, gi) => (
              <div key={`${g.heading ?? ''}-${gi}`} role="group" aria-label={g.heading} className="py-0.5">
                {g.heading && <div className="px-2 pb-0.5 pt-1.5 text-xs font-medium text-muted-foreground">{g.heading}</div>}
                {g.items.map((option) => {
                  const idx = shown.indexOf(option)
                  const isSelected = option.value === value
                  return (
                    <div
                      key={option.value}
                      id={`${listId}-${option.value}`}
                      role="option"
                      aria-selected={isSelected}
                      data-active={idx === active || undefined}
                      data-testid={`${testId}-option-${option.value}`}
                      onMouseEnter={() => setActive(idx)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(option)}
                      className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm', idx === active && 'bg-accent text-accent-foreground')}
                    >
                      {option.icon ?? <span className="h-4 w-4 shrink-0" />}
                      <span className="min-w-0 flex-1 truncate">
                        {option.label}
                        {option.hint && <span className="ml-1.5 text-xs text-muted-foreground">{option.hint}</span>}
                      </span>
                      <Check className={cn('h-3.5 w-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} aria-hidden />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
