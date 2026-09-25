import type { ReactNode } from 'react'
import { Search } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * The connect pages' building blocks, shared by Models (/models/connect)
 * and Connections (/connections/connect): a searchable grid of tiles, the
 * card a picked tile opens into, and the list of what is connected.
 */

export interface ServiceTile {
  key: string
  label: string
  icon: ReactNode
}

export interface ServiceTileGroup {
  id: string
  title: string
  tiles: ServiceTile[]
}

/** The square a logo sits in, on tiles, cards and page headers. */
export function ServiceIcon({ children, size = 'sm' }: { children: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md bg-primary/10',
        size === 'sm' && 'h-7 w-7 text-base',
        size === 'md' && 'h-10 w-10 rounded-lg text-xl',
        size === 'lg' && 'h-12 w-12 rounded-lg text-2xl',
      )}
      aria-hidden
    >
      {children}
    </span>
  )
}

export interface ServiceTileGridProps {
  groups: ServiceTileGroup[]
  search: string
  onSearch: (next: string) => void
  onPick: (key: string) => void
  /** Placeholder and accessible name of the search box, e.g. "Search providers". */
  searchLabel: string
  /** Shown when no group is left after the search. */
  empty?: ReactNode
  /** Shown under the search box, above the tiles (e.g. "nothing matched, but..."). */
  notice?: ReactNode
  /** Each tile's data-testid is `${testIdPrefix}-${key}`. */
  testIdPrefix: string
}

export function ServiceTileGrid({ groups, search, onSearch, onPick, searchLabel, empty, notice, testIdPrefix }: ServiceTileGridProps) {
  return (
    <div className="space-y-6">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input className="pl-9" value={search} onChange={(e) => onSearch(e.target.value)} placeholder={searchLabel} aria-label={searchLabel} />
      </div>
      {groups.length === 0 && empty}
      {groups.length > 0 && notice}
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`tiles-${group.id}`} className="space-y-2">
          <h2 id={`tiles-${group.id}`} className="text-sm font-medium text-muted-foreground">
            {group.title}
          </h2>
          <ChoiceTiles>
            {group.tiles.map((tile) => (
              <ChoiceTile key={tile.key} testId={`${testIdPrefix}-${tile.key}`} icon={tile.icon} label={tile.label} onClick={() => onPick(tile.key)} />
            ))}
          </ChoiceTiles>
        </section>
      ))}
    </div>
  )
}

/** The picked tile, opened into a card: its logo and name, a way back, and the form. */
export function PickedService({
  icon,
  title,
  onChooseAnother,
  chooseAnotherLabel,
  children,
}: {
  icon: ReactNode
  title: string
  /** Absent once there is nothing to go back to (the result is showing). */
  onChooseAnother?: () => void
  chooseAnotherLabel: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <ServiceIcon size="md">{icon}</ServiceIcon>
            <h2 className="text-lg font-semibold">{title}</h2>
          </div>
          {onChooseAnother && (
            <Button variant="ghost" size="sm" onClick={onChooseAnother}>
              {chooseAnotherLabel}
            </Button>
          )}
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

/**
 * One tile in a grid of them: the connect pages' provider tiles, and any
 * other pick-one list (a sign-in provider, who can open an app).
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

/** The grid tiles sit in. */
export function ChoiceTiles({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-label={label}>
      {children}
    </ul>
  )
}
