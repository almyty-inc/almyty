import { useQuery } from '@tanstack/react-query'
import { Globe, Lock, Users } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { organizationsApi } from '@/lib/api'

export type Visibility = 'private' | 'team' | 'org'

export interface VisibilityValue {
  visibility: Visibility
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
  /** What the thing is called in the option copy ("runner", "agent"...). */
  noun?: string
  /** Which choices to offer; all three when absent. */
  options?: Visibility[]
}

/**
 * Standard visibility + team picker. Drop into any create dialog.
 * - Private  → teamId=null, visibility='private'. Owner only; the backend
 *              refuses everyone else, org admins included.
 * - Team     → teamId required; pickable from team list.
 * - Org-wide → teamId=null, visibility='org'.
 *
 * Reads the org's teams under ['organization-teams', organizationId] --
 * the same key Settings -> Members & Teams writes through, so creating
 * or deleting a team there shows up in every picker. It used to have a
 * second key of its own over the same endpoint, which no mutation
 * invalidated, so a team you had just created was missing here.
 */
export function VisibilityField({ organizationId, value, onChange, teamAdminOf, disabled, noun = 'this', options }: Props) {
  const offered = (v: Visibility) => !options || options.includes(v)
  const columns = ['sm:grid-cols-1', 'sm:grid-cols-1', 'sm:grid-cols-2', 'sm:grid-cols-3'][options ? options.length : 3]
  const teamsQuery = useQuery<Team[]>({
    queryKey: ['organization-teams', organizationId],
    queryFn: () => organizationsApi.getTeams(organizationId),
    enabled: !!organizationId,
  })

  // organizationsApi.getTeams goes through apiGet → extractData, so
  // teamsQuery.data is already the flat array.
  const allTeams: Team[] = Array.isArray(teamsQuery.data) ? teamsQuery.data : []

  const pickableTeams = teamAdminOf
    ? allTeams.filter(t => teamAdminOf.includes(t.id))
    : allTeams

  const optionClass = (selected: boolean) =>
    `p-3 border rounded-md text-left transition-colors ${
      selected ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/50'
    } disabled:opacity-50 disabled:cursor-not-allowed`

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-sm font-medium" id="visibility-label">Visibility</Label>
        <div className={`grid grid-cols-1 ${columns} gap-2 mt-2`} role="radiogroup" aria-labelledby="visibility-label">
          {offered('private') && (
            <button
              type="button"
              role="radio"
              aria-checked={value.visibility === 'private'}
              disabled={disabled}
              className={optionClass(value.visibility === 'private')}
              onClick={() => onChange({ visibility: 'private', teamId: null })}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Lock className="h-4 w-4" /> Private
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Only you can see and use {noun}. Not even org admins.
              </p>
            </button>
          )}
          {offered('team') && (
            <button
              type="button"
              role="radio"
              aria-checked={value.visibility === 'team'}
              disabled={disabled || pickableTeams.length === 0}
              className={optionClass(value.visibility === 'team')}
              onClick={() => {
                const first = pickableTeams[0]
                onChange({ visibility: 'team', teamId: first?.id ?? null })
              }}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Users className="h-4 w-4" /> Team
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Only members of the team can see and use {noun}.
                {pickableTeams.length === 0 && (
                  <span className="block text-amber-600 dark:text-amber-400 mt-1">
                    You're not a team_admin of any team.
                  </span>
                )}
              </p>
            </button>
          )}
          {offered('org') && (
            <button
              type="button"
              role="radio"
              aria-checked={value.visibility === 'org'}
              disabled={disabled}
              className={optionClass(value.visibility === 'org')}
              onClick={() => onChange({ visibility: 'org', teamId: null })}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Globe className="h-4 w-4" /> Org-wide
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Everyone in the organization can see and use {noun}.
              </p>
            </button>
          )}
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
