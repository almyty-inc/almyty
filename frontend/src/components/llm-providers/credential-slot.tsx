/**
 * One credential of a provider (the inference key or the usage key) in the
 * edit dialog: what backs it today (a connection, a pasted key, nothing)
 * and the ways to change it. The form fields it writes are read by the
 * page's update mutation:
 *
 *   `<idField>`: undefined = keep, a connection id = point at it, null = clear
 *   `<keyField>`: a pasted key; blank means keep
 *
 * The masked marker the API returns for a stored key is never a value here.
 */
import { useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { ConnectedChip } from '@/components/connections/connected-chip'
import { ConnectionHealthBadge } from '@/components/connections/health-badge'
import { ConnectionSelect } from '@/components/connections/connection-select'
import { cn } from '@/lib/utils'
import type { Connection, ConnectionHealthStatus } from '@/types/connections'

import type { LlmProviderCredentialRef } from './schema'

/** The API's placeholder for a stored key; never a value to send back. */
export const MASKED_KEY = '***masked***'

export function isMaskedKey(value: unknown): boolean {
  return typeof value === 'string' && /^\*+masked\*+$/.test(value)
}

export type CredentialSlotMode = 'keep' | 'connection' | 'paste' | 'clear'

export interface CredentialSlotProps {
  /** Heading of the slot, e.g. "API key". */
  label: string
  /** The connection backing this slot now, from the provider view. */
  credentialRef?: LlmProviderCredentialRef | null
  /** True when a pasted key is stored inline (the view shows it masked). */
  hasStoredKey?: boolean
  /** The vendor, used to pick matching connections first. */
  connectorKey?: string
  form: UseFormReturn<any>
  idField: 'credentialId' | 'usageCredentialId'
  keyField: 'apiKey' | 'usageApiKey'
  keyInputId: string
  keyLabel: string
  keyPlaceholder?: string
  /** Rendered under the paste field (docs links, caveats). */
  keyHelp?: React.ReactNode
  /** Whether "Remove" is offered; the inference key of most vendors cannot be cleared. */
  allowClear?: boolean
  className?: string
}

/** Read-only view of what backs a slot; also used by the details sheet. */
export function CredentialRefSummary({ credentialRef, hasStoredKey, className }: { credentialRef?: LlmProviderCredentialRef | null; hasStoredKey?: boolean; className?: string }) {
  if (credentialRef) {
    return (
      <div className={cn('flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm', className)} data-testid="credential-ref">
        <span className="font-medium">{credentialRef.name || 'Connection'}</span>
        {credentialRef.connectorKey && <span className="font-mono text-xs text-muted-foreground">{credentialRef.connectorKey}</span>}
        <ConnectionHealthBadge health={{ status: (credentialRef.healthStatus as ConnectionHealthStatus | null) ?? 'unknown' }} />
      </div>
    )
  }
  return (
    <p className={cn('text-sm text-muted-foreground', className)} data-testid="credential-ref-none">
      {hasStoredKey ? 'A pasted key, stored encrypted. It is not shown again.' : 'No key on file.'}
    </p>
  )
}

export function CredentialSlot({ label, credentialRef, hasStoredKey, connectorKey, form, idField, keyField, keyInputId, keyLabel, keyPlaceholder, keyHelp, allowClear = true, className }: CredentialSlotProps) {
  // A slot with nothing behind it opens on the paste field, as before;
  // one backed by a connection or a stored key opens on "keep".
  const [mode, setMode] = useState<CredentialSlotMode>(credentialRef || hasStoredKey ? 'keep' : 'paste')
  const [picked, setPicked] = useState<Connection | null>(null)

  const choose = (next: CredentialSlotMode) => {
    setMode(next)
    setPicked(null)
    form.setValue(keyField, '')
    if (next === 'clear') form.setValue(idField, null)
    else form.setValue(idField, undefined)
  }
  const pick = (connection: Connection | null) => {
    setPicked(connection)
    form.setValue(idField, connection ? connection.id : undefined)
    form.setValue(keyField, '')
  }

  const option = (value: CredentialSlotMode, text: string) => (
    <Button type="button" size="sm" variant={mode === value ? 'default' : 'outline'} aria-pressed={mode === value} onClick={() => choose(value)}>
      {text}
    </Button>
  )

  return (
    <div className={cn('space-y-2 rounded-lg border p-3', className)} data-testid={`credential-slot-${idField}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex flex-wrap gap-1" role="group" aria-label={`${label} source`}>
          {(credentialRef || hasStoredKey) && option('keep', 'Keep current')}
          {option('connection', 'Use existing connection')}
          {option('paste', 'Paste a key')}
          {allowClear && (credentialRef || hasStoredKey) && option('clear', 'Remove')}
        </div>
      </div>

      {mode === 'keep' && <CredentialRefSummary credentialRef={credentialRef} hasStoredKey={hasStoredKey} />}

      {mode === 'connection' && (
        picked ? (
          <ConnectedChip connection={picked} onClear={() => pick(null)} />
        ) : (
          <div className="space-y-2">
            <ConnectionSelect id={`${keyInputId}-connection`} kind="inference" preferConnectorKey={connectorKey} value="" onChange={pick} helper="Connections of this vendor come first." />
            <ConnectAccountButton kind="inference" connectorKey={connectorKey} onConnected={pick} />
          </div>
        )
      )}

      {mode === 'paste' && (
        <div>
          <Label htmlFor={keyInputId}>{keyLabel}</Label>
          <Input id={keyInputId} type="password" autoComplete="off" {...form.register(keyField)} placeholder={keyPlaceholder} />
          {keyHelp}
        </div>
      )}

      {mode === 'clear' && (
        <p className="text-sm text-muted-foreground" data-testid="credential-slot-clear">
          The key is removed on save. A vendor that needs one refuses to be left without it.
        </p>
      )}
    </div>
  )
}
