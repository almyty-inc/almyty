import { Pin, Route, Users } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'

/**
 * The roles panel: which slot each model fills, and how it was chosen.
 *
 * The thing this surface exists to make obvious is that changing model is
 * a binding change and not a graph edit. So the binding is one click from
 * pinned to resolved, and a pinned role visibly does not involve routing
 * at all. See docs/design/layers.md, L4.
 */
export type RoleBinding =
  | { mode: 'pinned'; modelId: string }
  | { mode: 'resolved'; policy: Record<string, unknown> }

export interface AgentRoleView {
  key: string
  displayName: string
  requirement?: Record<string, unknown>
  binding: RoleBinding
}

export interface ResolvedRoleView {
  key: string
  modelId: string
  via: 'pinned' | 'resolved'
  rationale?: string
}

export interface RolesPanelProps {
  roles: AgentRoleView[]
  /** What each role resolves to right now, when it has been asked. */
  resolved?: ResolvedRoleView[]
  /** Names for model ids, so a slot does not read as a uuid. */
  modelNames?: Record<string, string>
  onAddRole?: () => void
  onEditRole?: (key: string) => void
  onToggleBinding?: (key: string, next: 'pinned' | 'resolved') => void
  loading?: boolean
  error?: string
}

export function RolesPanel({
  roles,
  resolved = [],
  modelNames = {},
  onAddRole,
  onEditRole,
  onToggleBinding,
  loading,
  error,
}: RolesPanelProps) {
  if (loading) {
    return (
      <div data-testid="roles-loading" className="space-y-2 p-4">
        {[0, 1].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg border border-border bg-card" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div data-testid="roles-error" className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
        {error}
      </div>
    )
  }

  if (roles.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No roles yet"
        description="A role names a job in this agent, like principal or verifier, and a binding says which model fills it. Adding one is how you change model later without editing the graph."
        action={onAddRole ? <Button onClick={onAddRole}>Add a role</Button> : undefined}
      />
    )
  }

  // Defended rather than assumed: a resolve that answered with something
  // unexpected should cost the rationale line, not the whole tab. This
  // threw and took the roles, the strategy picker and the orchestrator
  // down with it.
  const resolvedByKey = new Map((Array.isArray(resolved) ? resolved : []).map((r) => [r.key, r] as const))

  return (
    <div data-testid="roles-panel" className="space-y-2">
      {roles.map((role) => {
        const filled = resolvedByKey.get(role.key)
        const binding = role.binding
        const pinned = binding.mode === 'pinned'
        const modelId = binding.mode === 'pinned' ? binding.modelId : filled?.modelId
        return (
          <div
            key={role.key}
            data-testid={`role-${role.key}`}
            className="rounded-lg border border-border bg-card p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{role.displayName}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{role.key}</div>
              </div>
              <Badge
                variant="outline"
                className={cn(
                  'shrink-0 gap-1',
                  pinned ? 'border-violet-500/40 text-violet-600 dark:text-violet-400' : 'border-cyan-500/40 text-cyan-600 dark:text-cyan-400',
                )}
              >
                {pinned ? <Pin className="h-3 w-3" aria-hidden="true" /> : <Route className="h-3 w-3" aria-hidden="true" />}
                {pinned ? 'Pinned' : 'Resolved'}
              </Badge>
            </div>

            <div className="mt-2 text-xs text-muted-foreground">
              {modelId ? (
                <span data-testid={`role-model-${role.key}`}>{modelNames[modelId] ?? modelId}</span>
              ) : (
                <span data-testid={`role-unresolved-${role.key}`}>Not resolved yet</span>
              )}
              {pinned ? (
                // Worth saying out loud on the surface: this is what makes
                // roles usable with routing switched off entirely.
                <span className="ml-2 text-muted-foreground/70">chosen directly, no routing</span>
              ) : filled?.rationale ? (
                <span className="ml-2 text-muted-foreground/70">{filled.rationale}</span>
              ) : null}
            </div>

            <div className="mt-3 flex gap-2">
              {onToggleBinding && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onToggleBinding(role.key, pinned ? 'resolved' : 'pinned')}
                >
                  {pinned ? 'Let routing choose' : 'Pin a model'}
                </Button>
              )}
              {onEditRole && (
                <Button size="sm" variant="ghost" onClick={() => onEditRole(role.key)}>
                  Edit
                </Button>
              )}
            </div>
          </div>
        )
      })}
      {onAddRole && (
        <Button size="sm" variant="outline" className="w-full" onClick={onAddRole}>
          Add a role
        </Button>
      )}
    </div>
  )
}
