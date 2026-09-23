import { useQuery } from '@tanstack/react-query'
import { Lock } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { organizationsApi } from '@/lib/api'

export type TeamFilterValue = 'all' | 'org' | 'private' | string // string = teamId

export interface Team {
  id: string
  name: string
  isDefault?: boolean
}

interface TeamLookupResult {
  teams: Team[]
  byId: Record<string, Team>
  isLoading: boolean
}

/**
 * Shared hook for fetching the org's team list and providing an id→team
 * lookup table. Cached under ['organization-teams', orgId] -- the same
 * key Settings -> Members & Teams writes through, so a team created or
 * deleted there shows up in the page filters and per-row badges. This
 * used to have a key of its own over the same endpoint that no mutation
 * ever invalidated.
 */
export function useTeamLookup(organizationId?: string | null): TeamLookupResult {
  const teamsQuery = useQuery<Team[]>({
    queryKey: ['organization-teams', organizationId],
    queryFn: () => organizationsApi.getTeams(organizationId as string),
    enabled: !!organizationId,
  })

  // organizationsApi.getTeams goes through apiGet → extractData, so
  // teamsQuery.data is already the flat array.
  const teams: Team[] = Array.isArray(teamsQuery.data) ? teamsQuery.data : []

  const byId: Record<string, Team> = {}
  for (const t of teams) byId[t.id] = t

  return { teams, byId, isLoading: teamsQuery.isLoading }
}

interface TeamFilterProps {
  organizationId?: string | null
  value: TeamFilterValue
  onChange: (next: TeamFilterValue) => void
  className?: string
  /** Optional aria-label override for the trigger. */
  ariaLabel?: string
}

/**
 * Dropdown for filtering a list of team-scopable resources.
 * Options: "All my teams" (default), "Org-wide only", and one item per
 * team in the org. Pair with `filterByTeamVisibility` below to apply
 * the filter on a row array client-side.
 */
export function TeamFilter({
  organizationId,
  value,
  onChange,
  className,
  ariaLabel,
}: TeamFilterProps) {
  const { teams } = useTeamLookup(organizationId)

  return (
    <Select value={value} onValueChange={(v) => onChange(v as TeamFilterValue)}>
      <SelectTrigger className={className ?? 'w-44'} aria-label={ariaLabel ?? 'Filter by team'}>
        <SelectValue placeholder="Team" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All I can see</SelectItem>
        <SelectItem value="private">Private (just me)</SelectItem>
        <SelectItem value="org">Org-wide only</SelectItem>
        {teams.map((t) => (
          <SelectItem key={t.id} value={t.id}>
            {t.name}
            {t.isDefault && <span className="text-muted-foreground"> (default)</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

interface VisibilityBadgeProps {
  visibility?: 'org' | 'team' | 'private' | null
  teamId?: string | null
  teamLookup?: Record<string, Team>
}

/**
 * Outline badge describing a row's visibility.
 * - private  → "private" with a lock (only the viewer can see it)
 * - org      → neutral "org"
 * - team     → cyan "team: <name>" (looks up name from teamLookup)
 */
export function VisibilityBadge({ visibility, teamId, teamLookup }: VisibilityBadgeProps) {
  if (!visibility) return null

  if (visibility === 'private') {
    return (
      <Badge variant="outline" className="shrink-0 gap-1 text-foreground" title="Only you can see and use this">
        <Lock className="h-3 w-3" aria-hidden="true" />
        private
      </Badge>
    )
  }

  if (visibility === 'team') {
    const name = teamId ? teamLookup?.[teamId]?.name ?? 'team' : 'team'
    return (
      <Badge
        variant="outline"
        className="text-cyan-600 border-cyan-300 dark:border-cyan-800 dark:text-cyan-400 shrink-0"
      >
        team: {name}
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className="shrink-0 text-muted-foreground">
      org
    </Badge>
  )
}

/**
 * Apply the current visibility filter to a row array client-side.
 * - 'all'     → no filtering
 * - 'private' → only the caller's private rows (the server never sends
 *               anyone else's)
 * - 'org'     → only rows with visibility==='org'
 * - teamId    → org-wide rows + rows on that team
 */
export function filterByTeamVisibility<T extends { visibility?: 'org' | 'team' | 'private' | null; teamId?: string | null }>(
  rows: T[],
  filter: TeamFilterValue,
): T[] {
  if (filter === 'all') return rows
  if (filter === 'private') return rows.filter((r) => r.visibility === 'private')
  if (filter === 'org') return rows.filter((r) => r.visibility === 'org')
  return rows.filter((r) => r.visibility === 'org' || r.teamId === filter)
}