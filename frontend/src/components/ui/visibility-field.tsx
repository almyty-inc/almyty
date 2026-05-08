import { useQuery } from '@tanstack/react-query'
import { Globe, Users } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { teamsApi } from '@/lib/api'

export interface VisibilityValue {
  visibility: 'org' | 'team'
  teamId: string | null
}

interface Team {
  id: string
  name: string
  isDefault: boolean
}

interface Props {
  organizationId: string
  value: VisibilityValue
  onChange: (next: VisibilityValue) => void
  /**
   * Restrict the team picker to teams the caller can park resources in.
   * GitHub-style: members can only target teams they're team_admin of.
   * Pass the user's `team_admin` membership list; if undefined, all
   * teams in the org are shown (admin/owner case).
   */
  teamAdminOf?: string[] | null
  disabled?: boolean
}

/**
 * Standard visibility + team picker. Drop into any create dialog.
 * - Org-wide → teamId=null, visibility='org'.
 * - Team    → teamId required; pickable from team list.
 *
 * Listens on the org's teams via teamsApi.list (cached by react-query
 * with key ['teams', organizationId] so multiple instances on a page
 * share one fetch).
 */
export function VisibilityField({ organizationId, value, onChange, teamAdminOf, disabled }: Props) {
  const teamsQuery = useQuery<{ data: Team[] } | Team[]>({
    queryKey: ['teams', organizationId],
    queryFn: () => teamsApi.list(organizationId),
    enabled: !!organizationId,
  })

  const allTeams: Team[] = Array.isArray(teamsQuery.data)
    ? teamsQuery.data as Team[]
    : (teamsQuery.data as any)?.data ?? []

  const pickableTeams = teamAdminOf
    ? allTeams.filter(t => teamAdminOf.includes(t.id))
    : allTeams

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-sm font-medium">Visibility</Label>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <button
            type="button"
            disabled={disabled}
            className={`p-3 border rounded-md text-left transition-colors ${
              value.visibility === 'org'
                ? 'border-primary bg-primary/5'
                : 'border-input hover:bg-muted/50'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
            onClick={() => onChange({ visibility: 'org', teamId: null })}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4" /> Org-wide
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Visible to everyone in the organization.
            </p>
          </button>
          <button
            type="button"
            disabled={disabled || pickableTeams.length === 0}
            className={`p-3 border rounded-md text-left transition-colors ${
              value.visibility === 'team'
                ? 'border-primary bg-primary/5'
                : 'border-input hover:bg-muted/50'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
            onClick={() => {
              const first = pickableTeams[0]
              onChange({ visibility: 'team', teamId: first?.id ?? null })
            }}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4" /> Team
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Only members of the team can see + use this.
              {pickableTeams.length === 0 && (
                <span className="block text-amber-600 dark:text-amber-400 mt-1">
                  You're not a team_admin of any team.
                </span>
              )}
            </p>
          </button>
        </div>
      </div>

      {value.visibility === 'team' && (
        <div>
          <Label className="text-sm font-medium">Team</Label>
          <Select
            value={value.teamId ?? ''}
            onValueChange={(teamId) => onChange({ visibility: 'team', teamId })}
            disabled={disabled || pickableTeams.length === 0}
          >
            <SelectTrigger>
              <SelectValue placeholder="Pick a team" />
            </SelectTrigger>
            <SelectContent>
              {pickableTeams.map(t => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                  {t.isDefault && <span className="text-muted-foreground"> (default)</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}
