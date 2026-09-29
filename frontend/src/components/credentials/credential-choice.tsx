import { useQuery } from '@tanstack/react-query'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { credentialsApi } from '@/lib/api'

/** Stands in for "enter the keys here", because a Select cannot take ''. */
const ENTER_HERE = 'enter-here'

/** A credential as the list shows it: enough to pick one, never its values. */
export interface CredentialOption {
  id: string
  name: string
  connectorKey?: string | null
  metadata?: { managedBy?: { kind: string; id?: string } } | null
}

export interface CredentialChoiceProps {
  /** Id of the select, for its label. */
  id: string
  label?: string
  /**
   * Only credentials filed under this connector are offered, e.g.
   * `channel-slack` for Slack keys. Leave out to offer every credential.
   */
  connectorKey?: string
  /** The credential picked, or null when the keys are entered here. */
  value: string | null
  onChange: (credentialId: string | null) => void
  /** What the "enter them here" choice is called. */
  enterLabel?: string
  hint?: string
}

/**
 * Pick a credential from Credentials, or enter the keys here.
 *
 * The keys a form needs either come from a credential the organization
 * already keeps, or are typed on the form and then kept as a credential
 * of their own. This is the choice between the two, the same on every
 * form that takes keys. The typed fields themselves stay with the form
 * that knows what they are; this only says whether they are needed.
 */
export function CredentialChoice({
  id,
  label = 'Keys',
  connectorKey,
  value,
  onChange,
  enterLabel = 'Enter the keys here',
  hint,
}: CredentialChoiceProps) {
  const { data } = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.getAll(),
  })
  const all: CredentialOption[] = (Array.isArray(data) ? data : (data as any)?.data ?? (data as any)?.credentials ?? []) as CredentialOption[]
  const options = all.filter((c) => {
    if (connectorKey && c.connectorKey !== connectorKey) return false
    // Keys a form kept for itself go away with it, so they are never
    // offered to another; they show as "entered here" on their own form.
    return !c.metadata?.managedBy
  })
  // A credential in use that the list does not offer (another connector,
  // or not loaded yet) still shows as chosen rather than as "enter here".
  if (value && !options.some((c) => c.id === value)) {
    options.push({ id: value, name: all.find((c) => c.id === value)?.name ?? 'A credential from Credentials' })
  }
  const picked = value

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={picked ?? ENTER_HERE} onValueChange={(v) => onChange(v === ENTER_HERE ? null : v)}>
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ENTER_HERE}>{enterLabel}</SelectItem>
          {options.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{hint ?? 'Keys entered here are kept as a credential too.'}</p>
    </div>
  )
}
