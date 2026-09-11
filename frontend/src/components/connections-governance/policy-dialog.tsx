/**
 * Create or edit one connection policy. A kind picker (fixed when editing)
 * switches the per-kind form: connectors for allow and deny lists and
 * rotation, principal kinds and environments for scope rules, day counts
 * for expiry and rotation. The rule body is built by `buildPolicyRule`.
 */
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/lib/connections-api'
import {
  POLICIES_QUERY_KEY,
  buildCreatePolicyBody,
  buildUpdatePolicyBody,
  connectionPoliciesApi,
  emptyPolicyForm,
  policyToForm,
  readPolicyInvalid,
  validatePolicyForm,
  type PolicyFormValues,
} from '@/lib/connections-governance-api'
import { useNotifications } from '@/store/app'
import {
  CONNECTION_POLICY_KINDS,
  POLICY_KIND_DESCRIPTIONS,
  POLICY_KIND_LABELS,
  SCOPE_PRINCIPAL_KINDS,
  SCOPE_PRINCIPAL_KIND_LABELS,
  type ConnectionPolicy,
  type ConnectionPolicyKind,
  type ScopePrincipalKind,
} from '@/types/connections-governance'
import { ConnectorMultiSelect } from './connector-multi-select'

const SELECT_CLASS =
  'flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50'

const ENVIRONMENT_SUGGESTIONS = ['production', 'staging', 'development']

export interface PolicyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Editing this policy; absent means create. */
  policy?: ConnectionPolicy | null
  /** The kind a new policy starts with. */
  initialKind?: ConnectionPolicyKind
  onSaved?: (policy: ConnectionPolicy) => void
}

export function PolicyDialog({ open, onOpenChange, policy, initialKind, onSaved }: PolicyDialogProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const editing = !!policy

  const [values, setValues] = useState<PolicyFormValues>(() => (policy ? policyToForm(policy) : emptyPolicyForm(initialKind)))
  const [errors, setErrors] = useState<string[]>([])

  // Fresh form each time the dialog opens or the edited policy changes.
  useEffect(() => {
    if (!open) return
    setValues(policy ? policyToForm(policy) : emptyPolicyForm(initialKind))
    setErrors([])
  }, [open, policy, initialKind])

  const patch = (next: Partial<PolicyFormValues>) => setValues((prev) => ({ ...prev, ...next }))

  const save = useMutation({
    mutationFn: () => (policy ? connectionPoliciesApi.update(policy.id, buildUpdatePolicyBody(values)) : connectionPoliciesApi.create(buildCreatePolicyBody(values))),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: POLICIES_QUERY_KEY })
      notifications.success(editing ? 'Policy updated' : 'Policy added', `${POLICY_KIND_LABELS[values.kind]} is ${editing ? 'saved' : 'active'}.`)
      onSaved?.(saved)
      onOpenChange(false)
    },
    onError: (error: unknown) => {
      const invalid = readPolicyInvalid(error)
      setErrors(invalid ? (invalid.errors.length ? invalid.errors : [invalid.message]) : [errorMessage(error, 'The policy was not saved')])
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const problems = validatePolicyForm(values)
    setErrors(problems)
    if (problems.length) return
    save.mutate()
  }

  const busy = save.isPending

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="policy-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit policy' : 'Add policy'}</DialogTitle>
          <DialogDescription>{POLICY_KIND_DESCRIPTIONS[values.kind]}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4" noValidate data-testid="policy-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="policy-kind">Kind</Label>
              <select id="policy-kind" className={SELECT_CLASS} value={values.kind} onChange={(e) => patch({ kind: e.target.value as ConnectionPolicyKind })} disabled={editing || busy}>
                {CONNECTION_POLICY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{POLICY_KIND_LABELS[kind]}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="policy-name">Name <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="policy-name" value={values.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Production only" maxLength={128} disabled={busy} />
            </div>
          </div>

          {(values.kind === 'connector_allowlist' || values.kind === 'connector_denylist') && (
            <>
              <div className="space-y-1.5">
                <Label>Connectors</Label>
                <ConnectorMultiSelect value={values.connectorKeys} onChange={(connectorKeys) => patch({ connectorKeys })} disabled={busy} />
              </div>
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">Applies to</legend>
                <div className="flex flex-wrap gap-4" data-testid="policy-owners">
                  <OwnerCheckbox id="policy-owner-org" label="Organization connections" owner="org" values={values} patch={patch} disabled={busy} />
                  <OwnerCheckbox id="policy-owner-user" label="Personal connections" owner="user" values={values} patch={patch} disabled={busy} />
                </div>
                <p className="text-xs text-muted-foreground">Both when neither is ticked.</p>
              </fieldset>
            </>
          )}

          {values.kind === 'scope_rule' && (
            <>
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">Principal kinds</legend>
                <div className="flex flex-wrap gap-4" data-testid="policy-principal-kinds">
                  {SCOPE_PRINCIPAL_KINDS.map((kind) => {
                    const id = `policy-principal-${kind}`
                    return (
                      <div key={kind} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={values.principalKinds.includes(kind)}
                          onCheckedChange={(v) => patch({ principalKinds: togglePrincipal(values.principalKinds, kind, v === true) })}
                          disabled={busy}
                        />
                        <Label htmlFor={id} className="font-normal">{SCOPE_PRINCIPAL_KIND_LABELS[kind]}</Label>
                      </div>
                    )
                  })}
                </div>
              </fieldset>
              <div className="space-y-1.5">
                <Label htmlFor="policy-environment-input">Environments <span className="font-normal text-muted-foreground">(optional, everywhere when empty)</span></Label>
                <EnvironmentChips value={values.environments} onChange={(environments) => patch({ environments })} disabled={busy} />
              </div>
              <div className="flex items-center gap-3">
                <Switch id="policy-approved-only" checked={values.approvedConnectorsOnly} onCheckedChange={(approvedConnectorsOnly) => patch({ approvedConnectorsOnly })} disabled={busy} />
                <Label htmlFor="policy-approved-only" className="font-normal">Approved connectors only (needs an allowed-connectors policy for organization connections)</Label>
              </div>
              <p className="text-xs text-muted-foreground">Scope rules always require organization-owned connections; personal connections are refused for these principals.</p>
            </>
          )}

          {values.kind === 'expiry_rule' && (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="policy-max-age">Maximum age (days)</Label>
                  <Input id="policy-max-age" type="number" min={1} step={1} value={values.maxAgeDays} onChange={(e) => patch({ maxAgeDays: toInt(e.target.value) })} disabled={busy} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="policy-warn-days">Warn ahead (days)</Label>
                  <Input id="policy-warn-days" type="number" min={0} step={1} value={values.warnDays} onChange={(e) => patch({ warnDays: toInt(e.target.value) })} disabled={busy} />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Switch id="policy-enforce" checked={values.enforce} onCheckedChange={(enforce) => patch({ enforce })} disabled={busy} />
                <Label htmlFor="policy-enforce" className="font-normal">Revoke grants on expiry</Label>
              </div>
            </>
          )}

          {values.kind === 'rotation_rule' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="policy-every-days">Rotate every (days)</Label>
                <Input id="policy-every-days" type="number" min={1} step={1} value={values.everyDays} onChange={(e) => patch({ everyDays: toInt(e.target.value) })} disabled={busy} />
              </div>
              <div className="space-y-1.5">
                <Label>Connectors <span className="font-normal text-muted-foreground">(optional, every connector when empty)</span></Label>
                <ConnectorMultiSelect value={values.connectorKeys} onChange={(connectorKeys) => patch({ connectorKeys })} disabled={busy} />
              </div>
            </>
          )}

          {errors.length > 0 && (
            <ul role="alert" className="space-y-0.5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive" data-testid="policy-errors">
              {errors.map((err) => <li key={err}>{err}</li>)}
            </ul>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {editing ? 'Save policy' : 'Add policy'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function toInt(raw: string): number {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : 0
}

function togglePrincipal(list: ScopePrincipalKind[], kind: ScopePrincipalKind, on: boolean): ScopePrincipalKind[] {
  if (on) return list.includes(kind) ? list : [...list, kind]
  return list.filter((k) => k !== kind)
}

function OwnerCheckbox({ id, label, owner, values, patch, disabled }: { id: string; label: string; owner: 'org' | 'user'; values: PolicyFormValues; patch: (next: Partial<PolicyFormValues>) => void; disabled?: boolean }) {
  const checked = values.owners.includes(owner)
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => patch({ owners: v === true ? (checked ? values.owners : [...values.owners, owner]) : values.owners.filter((o) => o !== owner) })}
        disabled={disabled}
      />
      <Label htmlFor={id} className="font-normal">{label}</Label>
    </div>
  )
}

/** Environment names as chips: type one and press Enter or comma, or take a suggestion. */
export function EnvironmentChips({ value, onChange, disabled }: { value: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState('')

  const add = (raw: string) => {
    const name = raw.trim().toLowerCase()
    if (!name) return
    if (!value.includes(name)) onChange([...value, name])
    setDraft('')
  }
  const remove = (name: string) => onChange(value.filter((v) => v !== name))

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(draft)
    } else if (e.key === 'Backspace' && !draft && value.length) {
      remove(value[value.length - 1])
    }
  }

  const suggestions = ENVIRONMENT_SUGGESTIONS.filter((s) => !value.includes(s))

  return (
    <div className="space-y-2" data-testid="environment-chips">
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5">
        {value.map((name) => (
          <span key={name} className="inline-flex items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/5 px-2 py-0.5 text-xs" data-testid={`environment-chip-${name}`}>
            {name}
            {!disabled && (
              <button type="button" onClick={() => remove(name)} className="rounded-full text-muted-foreground hover:text-foreground" aria-label={`Remove ${name}`}>
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </span>
        ))}
        <input
          id="policy-environment-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(draft)}
          placeholder={value.length ? '' : 'production'}
          className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          disabled={disabled}
          aria-label="Add environment"
        />
      </div>
      {suggestions.length > 0 && !disabled && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => add(s)} className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
