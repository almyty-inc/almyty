/**
 * Add a credential: one form, everywhere one is added.
 *
 *   Name           what it is called wherever it is picked
 *   Service        one searchable list of every service (model providers,
 *                  memory, MCP servers, clouds, storage, the general kinds
 *                  of key, and Custom)
 *   ...            the fields that service needs (its key, a URL, a sign-in)
 *   Who can use it Only you, One team or Everyone
 *   Save
 *
 * It renders on the Add credential page (/credentials/new), on Connect a
 * provider under Models (`modelsOnly`), on Add memory account (`kind`
 * memory), and inline under "Create one here" in the pick-or-create
 * control (`embedded`, usually with the service fixed by `connectorKey`).
 *
 * A model provider's key is saved as a provider connection, with its
 * models (`onSaved` gets `provider`); every other service's as a
 * credential (`onSaved` gets `connection`). Both show on Credentials.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SearchableSelect, type SearchableOption } from '@/components/ui/searchable-select'
import { Field } from '@/components/layout/form-page'
import { BrandIcon } from '@/components/brand-icon'
import { ConnectServiceForm, connectorIcon, useConnectors } from '@/components/connections/connect-flow'
import { ConnectProviderForm, type ConnectResult } from '@/components/llm-providers/connect-provider-form'
import { cn } from '@/lib/utils'
import type { Connection, ConnectorKind } from '@/types/connections'
import { CONNECTIONS_QUERY_KEY, CREDENTIALS_QUERY_KEY } from './paths'
import { CUSTOM_KINDS, CUSTOM_SERVICE, SERVICE_GROUPS, credentialServices, type ServiceEntry, type ServiceTarget } from './services'

export type SavedCredential = { connection: Connection; provider?: undefined } | { provider: ConnectResult['provider']; models: ConnectResult['models']; connection?: undefined }

export interface CredentialFormProps {
  /** The picked service (a Service value); with onServiceChange, kept by the caller (in the URL). */
  service?: string | null
  onServiceChange?: (service: string | null) => void
  /** Only model providers. */
  modelsOnly?: boolean
  /** Only this kind's services. */
  kind?: ConnectorKind
  /** Of those, only these connector keys. */
  allowedKeys?: string[]
  /** The service is fixed to this connector: no choice. */
  connectorKey?: string
  /** Leave model providers out (a caller that needs a credential back). */
  withoutModels?: boolean
  /** The name to start with; otherwise the service's name once one is picked. */
  defaultName?: string
  onSaved: (saved: SavedCredential) => void
  /** Present = a Cancel button (inline use). */
  onCancel?: () => void
  /** Inside another form: no <form> elements, in a bordered panel. */
  embedded?: boolean
  /** Told whether a value has been typed and not saved yet. */
  onDirtyChange?: (dirty: boolean) => void
  idPrefix?: string
}

function entryIcon(entry: ServiceEntry) {
  if (entry.target?.kind === 'connector' || !entry.target) return connectorIcon({ key: entry.brand ?? entry.id, displayName: entry.label })
  return <BrandIcon brand={entry.brand} name={entry.label} />
}

export function CredentialForm({
  service: controlled,
  onServiceChange,
  modelsOnly,
  kind,
  allowedKeys,
  connectorKey,
  withoutModels,
  defaultName,
  onSaved,
  onCancel,
  embedded = false,
  onDirtyChange,
  idPrefix = 'credential',
}: CredentialFormProps) {
  const queryClient = useQueryClient()
  const connectorsQuery = useConnectors()
  const connectors = useMemo(() => connectorsQuery.data ?? [], [connectorsQuery.data])
  const [own, setOwn] = useState<string | null>(connectorKey ?? null)
  const picked = connectorKey ?? (controlled !== undefined ? controlled : own)
  const [customKind, setCustomKind] = useState<string | null>(null)
  const [name, setName] = useState(defaultName ?? '')
  const [nameTouched, setNameTouched] = useState(!!defaultName)
  const [nameError, setNameError] = useState('')
  const [fieldsDirty, setFieldsDirty] = useState(false)

  const entries = useMemo(() => {
    if (connectorKey) {
      const connector = connectors.find((c) => c.key === connectorKey)
      return connector ? credentialServices([connector], { kind: connector.kind }) : []
    }
    return credentialServices(connectors, { modelsOnly, kind, allowedKeys, withoutModels })
  }, [connectors, connectorKey, modelsOnly, kind, allowedKeys?.join(','), withoutModels])
  const entry = entries.find((e) => e.id === picked) ?? null
  const custom = entry?.id === CUSTOM_SERVICE ? CUSTOM_KINDS.find((k) => k.id === customKind) ?? null : null
  const target: ServiceTarget | null = entry?.target ?? custom?.target ?? null

  // The name follows the service until someone types one of their own.
  const suggested = custom ? custom.label : entry && entry.id !== CUSTOM_SERVICE && entry.group !== SERVICE_GROUPS.general ? entry.label : ''
  useEffect(() => {
    if (!nameTouched) setName(suggested)
  }, [suggested, nameTouched])

  useEffect(() => {
    onDirtyChange?.((nameTouched && !!name.trim() && name !== defaultName) || fieldsDirty)
  }, [nameTouched, name, fieldsDirty])

  const pick = (next: string | null) => {
    setCustomKind(null)
    if (onServiceChange) onServiceChange(next)
    else setOwn(next)
  }

  const options: SearchableOption[] = useMemo(
    () => entries.map((e) => ({ value: e.id, label: e.label, hint: e.hint, icon: entryIcon(e), keywords: e.keywords })),
    [entries],
  )

  const saved = (result: SavedCredential) => {
    queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY })
    queryClient.invalidateQueries({ queryKey: CREDENTIALS_QUERY_KEY })
    if (result.provider) {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    }
    onSaved(result)
  }

  const nameMissing = () => setNameError('Give it a name')
  const connector = target?.kind === 'connector' ? connectors.find((c) => c.key === target.connectorKey) ?? null : null
  const id = (field: string) => `${idPrefix}-${field}`

  return (
    <div className={cn('space-y-5', embedded && 'rounded-lg border bg-muted/30 p-4')} data-testid="credential-form">
      <Field id={id('name')} label="Name" error={nameError} hint={embedded ? undefined : 'How it is listed wherever it is picked.'}>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setNameTouched(true)
            setNameError('')
          }}
          placeholder="e.g. Production OpenAI key"
          autoComplete="off"
        />
      </Field>

      <Field id={id('service')} label={modelsOnly ? 'Provider' : 'Service'}>
        {connectorsQuery.isLoading && !modelsOnly ? (
          <p className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading services
          </p>
        ) : (
          <SearchableSelect
            id={id('service')}
            value={picked}
            onChange={pick}
            options={options}
            disabled={!!connectorKey}
            placeholder={modelsOnly ? 'Choose a provider' : 'Choose a service'}
            searchPlaceholder={modelsOnly ? 'Search providers' : 'Search services'}
            empty={modelsOnly ? 'No provider matches. If it speaks the OpenAI API, pick Your own server.' : 'No service matches. Pick API key or token, or Custom.'}
            testId="service-select"
          />
        )}
      </Field>
      {connectorsQuery.isError && !modelsOnly && (
        <p role="alert" className="text-sm text-destructive">
          The list of services could not be loaded. Reload the page to try again.
        </p>
      )}
      {picked && !entry && !connectorsQuery.isLoading && !connectorsQuery.isError && (
        <p role="alert" className="text-sm text-destructive">
          This service is not available.
        </p>
      )}

      {entry?.id === CUSTOM_SERVICE && (
        <Field id={id('custom-kind')} label="What is it">
          <Select value={customKind ?? ''} onValueChange={(v) => v && setCustomKind(v)}>
            <SelectTrigger data-testid="custom-kind">
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent>
              {CUSTOM_KINDS.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {target?.kind === 'provider' && (
        <ConnectProviderForm
          key={target.providerType}
          type={target.providerType}
          name={name}
          onNameMissing={nameMissing}
          embedded={embedded}
          onCancel={onCancel}
          idPrefix={id('provider')}
          onConnected={(result) => saved({ provider: result.provider, models: Array.isArray(result.models) ? result.models : [] })}
        />
      )}

      {target?.kind === 'connector' && connector && (
        <ConnectServiceForm
          key={connector.key}
          connector={connector}
          name={name}
          onNameMissing={nameMissing}
          embedded={embedded}
          onCancel={onCancel}
          onDirtyChange={setFieldsDirty}
          onConnected={(connection) => saved({ connection })}
        />
      )}

      {!target && onCancel && (
        <div className="flex">
          <button type="button" className="text-sm text-muted-foreground hover:text-foreground hover:underline" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
