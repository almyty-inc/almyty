/**
 * A script's change set (code mode, docs/design/code-mode.md part D): the
 * calls an agent's script wants to make that change or delete data, shown
 * one per row so a person approves or rejects them as a whole. After the
 * decision the same view says what happened to each one.
 */
import { Badge } from '@/components/ui/badge'
import type { ChangeSetEntry } from '@/types'

const OUTCOME: Record<NonNullable<ChangeSetEntry['outcome']>, { label: string; className: string }> = {
  ran: { label: 'ran', className: 'text-emerald-700 border-emerald-300 dark:text-emerald-400 dark:border-emerald-800' },
  failed: { label: 'failed', className: 'text-red-700 border-red-300 dark:text-red-400 dark:border-red-800' },
  not_run: { label: 'did not run', className: 'text-muted-foreground' },
}

/** The arguments in one short line: `id: 7, status: "archived"`. */
export function argumentsLine(args: Record<string, unknown>, max = 160): string {
  const text = Object.entries(args ?? {})
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? 'null'}`)
    .join(', ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || 'no arguments'
}

export function ChangeSetView({ entries }: { entries: ChangeSetEntry[] }) {
  return (
    <ol className="divide-y rounded-md border bg-background text-sm" data-testid="change-set" aria-label="Changes in this set">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-col gap-1 p-2 sm:flex-row sm:items-start sm:gap-3">
          <span className="font-mono text-xs text-muted-foreground sm:w-6 sm:shrink-0">{e.id}</span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{e.title || e.toolName}</span>
              <Badge
                variant="outline"
                className={e.sideEffect === 'destructive' ? 'text-red-700 border-red-300 dark:text-red-400 dark:border-red-800' : 'text-amber-700 border-amber-300 dark:text-amber-400 dark:border-amber-800'}
              >
                {e.sideEffect === 'destructive' ? 'deletes data' : 'changes data'}
              </Badge>
              {e.outcome && (
                <Badge variant="outline" className={OUTCOME[e.outcome].className}>
                  {OUTCOME[e.outcome].label}
                </Badge>
              )}
            </div>
            <div className="break-words font-mono text-xs text-muted-foreground">
              {e.codeName}({argumentsLine(e.arguments)})
            </div>
            {e.rule && <div className="text-xs text-amber-700 dark:text-amber-400">Also needs approval under a rule: {e.rule}</div>}
            {e.error && <div className="text-xs text-red-700 dark:text-red-400">{e.error}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}
