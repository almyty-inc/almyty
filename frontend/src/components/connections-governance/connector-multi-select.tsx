/**
 * Pick connectors from the catalog (GET /connectors): a filter box over a
 * checkbox list, with the picked keys shown as removable chips above it.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'

import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { CONNECTORS_QUERY_KEY } from '@/components/connections/connect-sheet'
import { connectorsApi, matchesConnectorSearch } from '@/lib/connections-api'
import { CONNECTOR_KIND_LABELS, type Connector } from '@/types/connections'

export interface ConnectorMultiSelectProps {
  value: string[]
  onChange: (keys: string[]) => void
  disabled?: boolean
  /** Label for the list, also the accessible name. */
  label?: string
}

export function ConnectorMultiSelect({ value, onChange, disabled, label = 'Connectors' }: ConnectorMultiSelectProps) {
  const [search, setSearch] = useState('')
  const connectorsQuery = useQuery({
    queryKey: CONNECTORS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectorsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
  const connectors = connectorsQuery.data ?? []
  const byKey = useMemo(() => new Map(connectors.map((c) => [c.key, c])), [connectors])

  // Keys the catalog no longer lists still need to be visible and removable.
  const unknown = value.filter((k) => !byKey.has(k))
  const visible = useMemo(() => connectors.filter((c) => matchesConnectorSearch(c, search)), [connectors, search])

  const toggle = (key: string, checked: boolean) => {
    if (checked) onChange(value.includes(key) ? value : [...value, key])
    else onChange(value.filter((k) => k !== key))
  }

  return (
    <div className="space-y-2" data-testid="connector-multi-select">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={`Selected ${label.toLowerCase()}`}>
          {value.map((key) => (
            <span key={key} className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-xs" data-testid={`connector-chip-${key}`}>
              {byKey.get(key)?.displayName ?? key}
              {!disabled && (
                <button type="button" onClick={() => toggle(key, false)} className="rounded-full text-muted-foreground hover:text-foreground" aria-label={`Remove ${byKey.get(key)?.displayName ?? key}`}>
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter connectors" className="pl-9" aria-label={`Filter ${label.toLowerCase()}`} disabled={disabled} />
      </div>
      <div className="max-h-48 overflow-y-auto rounded-md border" role="group" aria-label={label}>
        {connectorsQuery.isLoading && <p className="p-3 text-xs text-muted-foreground">Loading connectors</p>}
        {connectorsQuery.isError && <p role="alert" className="p-3 text-xs text-destructive">Connectors could not be loaded</p>}
        {!connectorsQuery.isLoading && !connectorsQuery.isError && visible.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">{connectors.length === 0 ? 'The catalog is empty' : 'No connector matches'}</p>
        )}
        {visible.map((c: Connector) => {
          const id = `connector-pick-${c.key}`
          const checked = value.includes(c.key)
          return (
            <label key={c.key} htmlFor={id} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-accent" data-testid={id}>
              <Checkbox id={id} checked={checked} onCheckedChange={(v) => toggle(c.key, v === true)} disabled={disabled} aria-label={c.displayName} />
              <span className="min-w-0 flex-1 truncate">{c.displayName}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{CONNECTOR_KIND_LABELS[c.kind] ?? c.kind}</span>
            </label>
          )
        })}
        {unknown.length > 0 && (
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            Not in the catalog any more: {unknown.join(', ')}
          </p>
        )}
      </div>
    </div>
  )
}
