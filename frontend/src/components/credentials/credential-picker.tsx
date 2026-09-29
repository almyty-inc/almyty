/**
 * CredentialPicker: the one way a form uses a credential, everywhere.
 *
 * Pick one of the credentials already on the Credentials page, or create
 * one right here. "Create one here" opens the same add flow the
 * Credentials page uses, inline under the field, so a half-filled form
 * keeps its state; the new credential lands on the Credentials page like
 * any other and comes straight back selected. "Open" links to the picked
 * credential's own page, in a new tab so the work here survives.
 *
 * The look is the reference for every "pick an existing one or create one
 * here" control (models, memory accounts, tools, agents, runners):
 *   - label, then a full-width select of the existing ones;
 *   - one line of text actions under it: "+ Create one here", and
 *     "Open <name>" once one is picked;
 *   - the hint line, then the error line, as on any other field;
 *   - creating opens a bordered, muted panel under the field with its own
 *     Save and Cancel; saving selects the new one and folds the panel.
 */
import { useId, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ExternalLink, Plus } from 'lucide-react'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConnectFlow } from '@/components/connections/connect-flow'
import { useConnectionOptions } from '@/components/connections/connection-select'
import { connectionCheck } from '@/components/connections/connection-status'
import { CONNECTIONS_QUERY_KEY, CREDENTIALS_QUERY_KEY, credentialPath } from '@/components/credentials/paths'
import { cn } from '@/lib/utils'
import type { Connection, ConnectorKind } from '@/types/connections'

export interface CredentialPickerProps {
  /** Id of the select; the label, hint and error hang off it. */
  id: string
  label?: ReactNode
  /** The picked credential's id; '' for none. */
  value: string
  /** The picked credential, or null when the choice is cleared. */
  onChange: (credential: Connection | null) => void
  /** Only credentials of this kind are listed, and creating offers this kind's services. */
  kind?: ConnectorKind
  /** Creating goes straight to this service; its credentials are listed first. */
  connectorKey?: string
  /** The name a new "Other service" key starts with, e.g. "Acme API key". */
  defaultName?: string
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  disabled?: boolean
  placeholder?: string
  /** Offer "None" as the first choice, which clears the value. */
  allowNone?: boolean
  /** Skip the fetch and list these instead (tests, callers that already hold the list). */
  connections?: Connection[]
  className?: string
}

/** What a credential is, after its name, in the list: the service and the account. */
export function credentialOptionDetail(credential: Connection): string {
  const service = credential.connectorDisplayName ?? credential.connectorKey
  return credential.accountLabel ? `${service}, ${credential.accountLabel}` : service
}

const NONE = '__none__'

/** The service's own credentials first, then the rest, each by name. */
export function sortCredentialOptions(credentials: Connection[], connectorKey?: string): Connection[] {
  const rank = (c: Connection) => (connectorKey && c.connectorKey === connectorKey ? 0 : 1)
  return [...credentials].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function CredentialPicker({
  id,
  label = 'Credential',
  value,
  onChange,
  kind,
  connectorKey,
  defaultName,
  hint,
  error,
  required,
  disabled,
  placeholder = 'Pick a credential',
  allowNone = false,
  connections,
  className,
}: CredentialPickerProps) {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  // A credential made here, until the list is refetched with it in.
  const [created, setCreated] = useState<Connection | null>(null)
  const options = useConnectionOptions({ kind, connections })
  const list = useMemo(() => sortCredentialOptions(created && !options.connections.some((c) => c.id === created.id) ? [created, ...options.connections] : options.connections, connectorKey), [created, options.connections, connectorKey])
  const selected = list.find((c) => c.id === value) ?? null
  const empty = !options.isLoading && list.length === 0
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const panelId = useId()

  return (
    <div className={cn('space-y-1.5', className)} data-invalid={error ? 'true' : undefined} data-testid="credential-picker">
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      <Select
        value={selected ? selected.id : allowNone && !value ? NONE : ''}
        // Radix reports '' when the value is briefly not among its items (a
        // credential made here, before the list is refetched): not a choice.
        onValueChange={(next) => {
          if (!next) return
          onChange(next === NONE ? null : list.find((c) => c.id === next) ?? null)
        }}
        disabled={disabled || (empty && !allowNone)}
      >
        <SelectTrigger id={id} aria-invalid={error ? true : undefined} aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}>
          <SelectValue placeholder={empty ? 'No credentials yet' : placeholder} />
        </SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>None</SelectItem>}
          {list.map((c) => {
            const failing = connectionCheck(c).state === 'failed'
            return (
              <SelectItem key={c.id} value={c.id}>
                <span className="font-medium">{c.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {credentialOptionDetail(c)}
                  {failing && ' · needs attention'}
                </span>
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
      {!creating && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
            onClick={() => setCreating(true)}
            disabled={disabled}
            aria-expanded={false}
            aria-controls={panelId}
            data-testid="credential-picker-create"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Create one here
          </button>
          {selected && (
            <Link
              to={credentialPath(selected.id)}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
              data-testid="credential-picker-open"
            >
              Open {selected.name}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </p>
      )}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {creating && (
        <div id={panelId} className="pt-1">
          <ConnectFlow
            embedded
            kind={kind}
            connectorKey={connectorKey}
            defaultName={defaultName}
            onCancel={() => setCreating(false)}
            onConnected={(credential) => {
              setCreating(false)
              setCreated(credential)
              queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
              queryClient.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY })
              onChange(credential)
            }}
          />
        </div>
      )}
    </div>
  )
}
