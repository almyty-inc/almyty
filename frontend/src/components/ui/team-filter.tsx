import { useQuery } from '@tanstack/react-query'

import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { teamsApi } from '@/lib/api'

export type TeamFilterValue = 'all' | 'org' | string // string = teamId

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
 * lookup table. Cached via react-query under ['teams', orgId] so the
 * page filter and per-row badges share one fetch.
 */
export function useTeamLookup(organizationId?: string | null): TeamLookupResult {
  const teamsQuery = useQuery<{ data: Team[] } | Team[]>({
    queryKey: ['teams', organizationId],
    queryFn: () => teamsApi.list(organizationId as string),
    enabled: !!organizationId,
  })

  const teams: Team[] = Array.isArray(teamsQuery.data)
    ? (teamsQuery.data as Team[])
    : ((teamsQuery.data as any)?.data ?? [])

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
        <SelectItem value="all">All my teams</SelectItem>
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
  visibility?: 'org' | 'team' | null
  teamId?: string | null
  teamLookup?: Record<string, Team>
}

/**
 * Outline badge describing a row's team visibility.
 * - org      → neutral "org"
 * - team     → cyan "team: <name>" (looks up name from teamLookup)
 */
export function VisibilityBadge({ visibility, teamId, teamLookup }: VisibilityBadgeProps) {
  if (!visibility) return null

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
 * Apply the current team filter to a row array client-side.
 * - 'all'   → no filtering
 * - 'org'   → only rows with visibility==='org'
 * - teamId  → org-wide rows + rows on that team
 */
export function filterByTeamVisibility<T extends { visibility?: 'org' | 'team' | null; teamId?: string | null }>(
  rows: T[],
  filter: TeamFilterValue,
): T[] {
  if (filter === 'all') return rows
  if (filter === 'org') return rows.filter((r) => r.visibility === 'org')
  return rows.filter((r) => r.visibility === 'org' || r.teamId === filter)
}
