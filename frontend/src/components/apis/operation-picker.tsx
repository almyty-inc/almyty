/**
 * Pick the operations to make tools from, for a description with more
 * operations than one description may make tools from (Microsoft Graph's
 * Files area: 1,600+, against a limit of 1,000). Operations are filed by
 * tag, or by path prefix when they have none; a group's box picks every
 * operation in it that the search shows. Used on "Finish connecting"
 * (`pages/api-setup.tsx`) when the import says `selectionRequired`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { pluralized } from '@/lib/utils'
import { groupLabel, groupOperations } from './operation-groups'

interface OperationPickerProps {
  apiId: string
  /** How many operations the description has, from the import result. */
  total: number
  /** How many one description may make tools from, from the import result. */
  limit: number
  /**
   * On a re-import: the operations the description added. The earlier pick
   * starts picked and only these are left to decide.
   */
  newOperationIds?: string[]
  /** Tool generation for the picked operations was queued as this job. */
  onStarted: (jobId: string) => void
}

const number = (n: number) => n.toLocaleString('en-US')

export function OperationPicker({ apiId, total, limit: importLimit, newOperationIds, onStarted }: OperationPickerProps) {
  const outline = useQuery({
    queryKey: ['api-operation-outline', apiId],
    queryFn: () => apisApi.getOperationOutline(apiId),
  })
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const [onlyNew, setOnlyNew] = useState(false)
  const newIds = useMemo(() => new Set(newOperationIds ?? []), [newOperationIds])

  const operations = outline.data?.operations ?? []
  const limit = outline.data?.limit ?? importLimit

  // A re-import keeps the earlier pick: what is still active and not new.
  // A first import starts with nothing picked.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !outline.data || !newOperationIds) return
    seeded.current = true
    setSelected(new Set(outline.data.operations.filter((op) => op.isActive !== false && !newIds.has(op.id)).map((op) => op.id)))
  }, [outline.data, newOperationIds, newIds])

  const shown = useMemo(() => (onlyNew ? operations.filter((op) => newIds.has(op.id)) : operations), [operations, onlyNew, newIds])
  const groups = useMemo(() => groupOperations(shown, search), [shown, search])
  const overLimit = selected.size > limit

  const submit = useMutation({
    mutationFn: () => apisApi.selectOperations(apiId, [...selected]),
    onSuccess: (result) => onStarted(String(result.jobId)),
    onError: (err) => setError(getApiErrorMessage(err, 'The tools were not made.')),
  })

  const setMany = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  const toggleOpen = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <section className="space-y-3" aria-labelledby="pick-operations" data-testid="operation-picker">
      <div>
        <h2 id="pick-operations" className="text-sm font-semibold">
          Pick the operations to make tools from
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This description has {pluralized(total, 'operation')}; one description makes tools from up to {number(limit)}.
          {newIds.size > 0
            ? ` What you picked last time is still picked. ${pluralized(newIds.size, 'operation is', 'operations are')} new: pick the ones your agents need.`
            : ' All of them are imported. Pick the ones your agents need, by area or one by one.'}
        </p>
      </div>

      {outline.isError ? (
        <QueryError error={outline.error} onRetry={() => outline.refetch()} title="Couldn't load the operations" />
      ) : outline.isLoading ? (
        <LoadingSpinner />
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                aria-label="Search operations"
                placeholder="Search by area, path or name"
                className="pl-10"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {newIds.size > 0 && (
              <label className="flex shrink-0 items-center gap-2 text-sm">
                <Checkbox checked={onlyNew} onCheckedChange={(on) => setOnlyNew(on === true)} />
                Only new
              </label>
            )}
            <p className={overLimit ? 'text-sm font-medium text-destructive' : 'text-sm text-muted-foreground'} data-testid="picked-count">
              {number(selected.size)} of {number(limit)} picked
            </p>
          </div>

          <div className="max-h-[28rem] overflow-y-auto rounded-md border" role="group" aria-label="Operations by area">
            {groups.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No operation matches “{search}”.</p>
            ) : (
              groups.map((group) => {
                const ids = group.operations.map((op) => op.id)
                const picked = ids.filter((id) => selected.has(id)).length
                const state = picked === 0 ? false : picked === ids.length ? true : 'indeterminate'
                const expanded = open.has(group.key)
                return (
                  <div key={group.key} className="border-b last:border-b-0">
                    <div className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        checked={state}
                        onCheckedChange={() => setMany(ids, state !== true)}
                        aria-label={`Pick every operation in ${groupLabel(group.key)}`}
                      />
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                        aria-expanded={expanded}
                        onClick={() => toggleOpen(group.key)}
                      >
                        {expanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="truncate font-medium" title={group.key}>{groupLabel(group.key)}</span>
                        <Badge variant="outline" className="ml-auto shrink-0 text-xs">
                          {picked > 0 ? `${picked} / ${ids.length}` : ids.length}
                        </Badge>
                      </button>
                    </div>
                    {expanded && (
                      <ul className="space-y-1 pb-2 pl-10 pr-3">
                        {group.operations.map((op) => (
                          <li key={op.id}>
                            <label
                              className="flex cursor-pointer items-start gap-3 rounded px-1 py-1 text-sm hover:bg-muted"
                              title={op.operationId ?? undefined}
                            >
                              <Checkbox
                                className="mt-0.5"
                                checked={selected.has(op.id)}
                                onCheckedChange={(on) => setMany([op.id], on === true)}
                              />
                              {/* The name its tool will have; the method and path under it. */}
                              <span className="min-w-0 flex-1">
                                <span className="block">{op.displayName || op.name || op.endpoint}</span>
                                <span className="block break-all font-mono text-xs text-muted-foreground">
                                  {op.method ? `${op.method.toUpperCase()} ` : ''}
                                  {op.endpoint}
                                </span>
                              </span>
                              {newIds.has(op.id) && (
                                <Badge variant="outline" className="shrink-0 border-cyan-600 text-xs text-cyan-600 dark:border-cyan-400 dark:text-cyan-400">
                                  New
                                </Badge>
                              )}
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                setError(null)
                submit.mutate()
              }}
              disabled={selected.size === 0 || overLimit || submit.isPending}
            >
              {selected.size > 0 ? `Make ${pluralized(selected.size, 'tool')}` : 'Make tools'}
            </Button>
            {selected.size > 0 && (
              <Button variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            )}
            {overLimit && (
              <p role="alert" className="text-sm text-destructive">
                That is {number(selected.size - limit)} over the limit of {number(limit)}.
              </p>
            )}
            {error && (
              <p role="alert" className="basis-full text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}
