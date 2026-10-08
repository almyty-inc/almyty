import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Globe, Lock, Shield, Users } from 'lucide-react'

import { organizationsApi } from '@/lib/api'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type AccessScope = 'private' | 'team' | 'org' | 'external_open' | 'external_protected'
export interface AccessScopeValue { accessScope: AccessScope; teamId: string | null }
export const ACCESS_SCOPE_LABELS: Record<AccessScope, string> = {
  private: 'Only you', team: 'One team', org: 'Everyone in the organization',
  external_open: 'Outside, open', external_protected: 'Outside, protected',
}
const choices = [
  { value: 'private', icon: Lock, hint: 'You, signed in to almyty.' },
  { value: 'team', icon: Users, hint: 'Members of one team, signed in to almyty.' },
  { value: 'org', icon: Users, hint: 'People in your organization, signed in to almyty.' },
  { value: 'external_open', icon: Globe, hint: 'Anyone on the internet, without signing in.' },
  { value: 'external_protected', icon: Shield, hint: 'Anyone with a key or sign-in you allow.' },
] as const

export function AccessScopeField({ organizationId, value, onChange, disabled, label = 'Who can use it' }: {
  organizationId: string; value: AccessScopeValue; onChange: (value: AccessScopeValue) => void; disabled?: boolean; label?: string
}) {
  const id = useId()
  const teams = useQuery({
    queryKey: ['organization-teams', organizationId],
    queryFn: () => organizationsApi.getTeams(organizationId), enabled: !!organizationId,
  })
  const available: { id: string; name: string }[] = Array.isArray(teams.data) ? teams.data : []
  return (
    <div className="space-y-3">
      <Label id={id}>{label}</Label>
      <div role="radiogroup" aria-labelledby={id} className="grid gap-2 sm:grid-cols-2">
        {choices.map(({ value: scope, icon: Icon, hint }) => (
          <button key={scope} type="button" role="radio" aria-checked={value.accessScope === scope}
            tabIndex={value.accessScope === scope ? 0 : -1}
            onKeyDown={event => {
              if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const radios = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)') ?? [])
              const index = radios.indexOf(event.currentTarget)
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? radios.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + radios.length) % radios.length
              radios[next]?.focus()
              radios[next]?.click()
            }}
            disabled={disabled || (scope === 'team' && available.length === 0)}
            className={`rounded-md border p-3 text-left disabled:opacity-50 ${value.accessScope === scope ? 'border-primary bg-primary/5' : 'border-input hover:bg-muted/50'}`}
            onClick={() => onChange({ accessScope: scope, teamId: scope === 'team' ? value.teamId ?? available[0]?.id ?? null : null })}>
            <span className="flex items-center gap-2 text-sm font-medium"><Icon className="h-4 w-4" />{ACCESS_SCOPE_LABELS[scope]}</span>
            <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
          </button>
        ))}
      </div>
      {value.accessScope === 'team' && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-team`}>Team</Label>
          <Select value={value.teamId ?? ''} disabled={disabled || teams.isLoading} onValueChange={teamId => onChange({ accessScope: 'team', teamId })}>
            <SelectTrigger id={`${id}-team`}><SelectValue placeholder="Choose a team" /></SelectTrigger>
            <SelectContent>{available.map(team => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent>
          </Select>
          {teams.isError && <p role="alert" className="text-sm text-destructive">Teams could not be loaded. Try again.</p>}
        </div>
      )}
      {value.accessScope === 'external_open' && <p className="text-sm text-muted-foreground">This endpoint is open to everyone. Scripts through code mode are unavailable.</p>}
      {value.accessScope === 'external_protected' && <p className="text-sm text-muted-foreground">Choose one or more sign-in methods below. Access stays closed until a method is ready.</p>}
    </div>
  )
}
