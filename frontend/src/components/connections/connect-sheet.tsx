/**
 * The inline connect flow every consumer opens: pick a connector (filtered
 * by kind), then run its best method. Form methods (api_key, service_account,
 * cloud_iam) post the JsonSchemaForm values and show a live validation
 * failure inline with retry. OAuth methods open the provider in a new tab
 * and poll by state until the callback lands, with a paste-the-code fallback.
 *
 * The connection is handed back through `onConnected`; the caller decides
 * what to select. With `rotateConnection` the same UI re-runs the method
 * against POST /connections/:id/rotate.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertCircle, ArrowLeft, Check, ExternalLink, Loader2, Plug, RefreshCw, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { JsonSchemaForm, schemaDefaults, validateSchemaValues, type SchemaFormValues } from '@/components/ui/json-schema-form'
import { organizationsApi } from '@/lib/api'
import {
  allowUserScopedConnections,
  bestConnectMethod,
  connectionsApi,
  connectorsApi,
  errorMessage,
  groupConnectorsByKind,
  isConnectForm,
  isConnectRedirect,
  isFormMethod,
  isRedirectMethod,
  matchesConnectorSearch,
  pollForConnection,
  readValidationFailure,
  type PollTarget,
} from '@/lib/connections-api'
import { cn } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import {
  CONNECTOR_KINDS,
  CONNECTOR_KIND_LABELS,
  CONNECT_METHOD_LABELS,
  type ConnectMethod,
  type ConnectRedirect,
  type ConnectResult,
  type Connection,
  type ConnectionOwner,
  type Connector,
  type ConnectorKind,
} from '@/types/connections'

export const CONNECTORS_QUERY_KEY = ['connectors'] as const

export interface ConnectSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Only connectors of this kind are offered. */
  kind?: ConnectorKind
  /** Skip the picker and go straight to this connector. */
  connectorKey?: string
  owner?: ConnectionOwner
  onConnected: (connection: Connection) => void
  /** Re-run the method for this connection instead of creating a new one. */
  rotateConnection?: Connection | null
  /** How often the OAuth poll asks for the connection. */
  pollIntervalMs?: number
}

type OAuthPhase =
  | { phase: 'idle' }
  | { phase: 'waiting'; authorizeUrl: string; state: string }
  | { phase: 'timeout'; authorizeUrl: string; state: string }

export function ConnectSheet({ open, onOpenChange, kind, connectorKey, owner: ownerProp, onConnected, rotateConnection, pollIntervalMs = 2000 }: ConnectSheetProps) {
  const { currentOrganization } = useOrganizationStore()
  const targetKey = rotateConnection?.connectorKey ?? connectorKey

  const [search, setSearch] = useState('')
  const [pickedKey, setPickedKey] = useState<string | null>(targetKey ?? null)
  const [methodType, setMethodType] = useState<ConnectMethod['type'] | null>(null)
  const [owner, setOwner] = useState<ConnectionOwner>(ownerProp ?? 'org')
  const [values, setValues] = useState<SchemaFormValues>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<{ message: string; connection?: Connection } | null>(null)
  const [oauth, setOauth] = useState<OAuthPhase>({ phase: 'idle' })
  const [pasteMode, setPasteMode] = useState(false)
  const [code, setCode] = useState('')
  const pollAbort = useRef<AbortController | null>(null)

  const connectorsQuery = useQuery({
    queryKey: CONNECTORS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectorsApi.list()
      return Array.isArray(rows) ? rows : []
    },
    enabled: open,
  })

  const orgQuery = useQuery({
    queryKey: ['organization-details', currentOrganization?.id],
    queryFn: () => organizationsApi.getById(currentOrganization!.id),
    enabled: open && !!currentOrganization?.id,
  })
  const allowUserScoped = allowUserScopedConnections(orgQuery.data)

  const connectors: Connector[] = useMemo(
    () => (connectorsQuery.data ?? []).filter((c) => !kind || c.kind === kind),
    [connectorsQuery.data, kind],
  )
  const connector = useMemo(() => (pickedKey ? (connectorsQuery.data ?? []).find((c) => c.key === pickedKey) ?? null : null), [connectorsQuery.data, pickedKey])

  // One match for the requested kind: skip the picker.
  useEffect(() => {
    if (open && !targetKey && !pickedKey && connectors.length === 1) setPickedKey(connectors[0].key)
  }, [open, targetKey, pickedKey, connectors])
  const method: ConnectMethod | null = useMemo(() => {
    if (!connector) return null
    return connector.connect.find((m) => m.type === methodType) ?? bestConnectMethod(connector)
  }, [connector, methodType])
  const keyPageUrl = method?.keyPageUrl ?? connector?.keyPageUrl ?? null

  const stopPolling = () => {
    pollAbort.current?.abort()
    pollAbort.current = null
  }

  // Reset per open; the picker is skipped when a key is fixed.
  useEffect(() => {
    if (!open) {
      stopPolling()
      return
    }
    setSearch('')
    setPickedKey(targetKey ?? null)
    setMethodType(null)
    setOwner(ownerProp ?? 'org')
    setValues({})
    setFieldErrors({})
    setFailure(null)
    setOauth({ phase: 'idle' })
    setPasteMode(false)
    setCode('')
  }, [open, targetKey, ownerProp])

  useEffect(() => () => stopPolling(), [])

  // Seed the form with schema defaults whenever the method changes.
  useEffect(() => {
    setValues(schemaDefaults(method?.schema))
    setFieldErrors({})
    setFailure(null)
  }, [method?.type, connector?.key])

  const finish = (connection: Connection) => {
    stopPolling()
    onConnected(connection)
    onOpenChange(false)
  }

  const startPolling = (redirect: ConnectRedirect) => {
    stopPolling()
    const controller = new AbortController()
    pollAbort.current = controller
    const { authorizeUrl, state } = redirect
    setOauth({ phase: 'waiting', authorizeUrl, state })
    // The provider prints the code instead of calling back: go straight to paste mode.
    if (redirect.completeWith === 'code') setPasteMode(true)
    const target: PollTarget = { connectorKey: connector!.key, since: Date.now() - 1000, connectionId: rotateConnection?.id }
    void pollForConnection(target, { intervalMs: pollIntervalMs, signal: controller.signal, list: () => connectionsApi.list() }).then((found) => {
      if (controller.signal.aborted) return
      if (found) finish(found)
      else setOauth({ phase: 'timeout', authorizeUrl, state })
    })
  }

  const handleResult = (result: ConnectResult) => {
    if (isConnectRedirect(result)) {
      window.open(result.authorizeUrl, '_blank', 'noopener')
      startPolling(result)
      return
    }
    if (isConnectForm(result)) {
      setFailure({ message: 'Fill in the form and try again.' })
      return
    }
    if (result?.connection) finish(result.connection)
  }

  const connect = useMutation({
    mutationFn: (input?: Record<string, unknown>) => {
      if (rotateConnection) return connectionsApi.rotate(rotateConnection.id, input ? { input } : {})
      return connectionsApi.connect(connector!.key, { method: method?.type, owner, ...(input ? { input } : {}) })
    },
    onSuccess: handleResult,
    onError: (error: unknown) => {
      const validation = readValidationFailure(error)
      setFailure(validation ? { message: validation.message, connection: validation.connection } : { message: errorMessage(error, 'The account could not be connected') })
    },
  })

  const complete = useMutation({
    mutationFn: (payload: { state: string; code: string }) => connectionsApi.complete(connector!.key, payload),
    onSuccess: (connection) => {
      if (connection?.id) finish(connection)
    },
    onError: (error: unknown) => setFailure({ message: errorMessage(error, 'The code was not accepted') }),
  })

  // The sheet is portaled but still nested in the consumer's React tree; a
  // submit here must not bubble into a consumer dialog's own <form>.
  const submitForm = (e: FormEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!connector || !method) return
    const check = validateSchemaValues(method.schema, values, { mode: 'create' })
    if (!check.ok) {
      setFieldErrors(check.errors)
      return
    }
    setFieldErrors({})
    setFailure(null)
    connect.mutate(check.value)
  }

  const startOAuth = () => {
    setFailure(null)
    connect.mutate(undefined)
  }

  const submitCode = (e: FormEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (oauth.phase === 'idle' || !code.trim()) return
    setFailure(null)
    complete.mutate({ state: oauth.state, code: code.trim() })
  }

  const title = rotateConnection ? `Rotate ${rotateConnection.name}` : connector ? `Connect ${connector.displayName}` : 'Connect an account'
  const busy = connect.isPending || complete.isPending

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Plug className="h-5 w-5 text-violet-500" aria-hidden="true" />
            {title}
          </SheetTitle>
          <SheetDescription>
            {connector
              ? connector.description || `Connect ${connector.displayName} once and reuse it wherever almyty needs it.`
              : `Pick what to connect${kind ? ` for ${CONNECTOR_KIND_LABELS[kind].toLowerCase()}` : ''}. Secrets are encrypted at rest and never shown again.`}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {connectorsQuery.isLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading connectors
            </p>
          )}
          {connectorsQuery.isError && (
            <p role="alert" className="text-sm text-destructive">{errorMessage(connectorsQuery.error, 'Connectors could not be loaded')}</p>
          )}

          {!connectorsQuery.isLoading && !connector && (
            <ConnectorPicker connectors={connectors} search={search} onSearch={setSearch} onPick={(c) => { setPickedKey(c.key); setMethodType(null) }} />
          )}

          {connector && (
            <>
              {!targetKey && (
                <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1 text-muted-foreground" onClick={() => setPickedKey(null)}>
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> All connectors
                </Button>
              )}

              {connector.connect.length > 1 && (
                <div className="space-y-1.5">
                  <Label>Method</Label>
                  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Connect method">
                    {connector.connect.map((m) => (
                      <button
                        key={m.type}
                        type="button"
                        role="radio"
                        aria-checked={method?.type === m.type}
                        onClick={() => setMethodType(m.type)}
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                          method?.type === m.type ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {m.label || CONNECT_METHOD_LABELS[m.type]}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {!rotateConnection && allowUserScoped && (
                <div className="space-y-1.5">
                  <Label>Owner</Label>
                  <div className="flex gap-2" role="radiogroup" aria-label="Owner">
                    {(['org', 'user'] as ConnectionOwner[]).map((o) => (
                      <button
                        key={o}
                        type="button"
                        role="radio"
                        aria-checked={owner === o}
                        onClick={() => setOwner(o)}
                        className={cn(
                          'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                          owner === o ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {o === 'org' ? 'Whole organization' : 'Only me'}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{owner === 'org' ? 'Anyone you grant access can use it.' : 'A personal connection only you can use.'}</p>
                </div>
              )}

              {method?.description && (
                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground whitespace-pre-wrap" data-testid="connect-instructions">
                  {method.description}
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                {keyPageUrl && (
                  <a href={keyPageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <ExternalLink className="h-3 w-3" aria-hidden="true" /> Get your {method?.type === 'service_account' ? 'service account' : 'key'}
                  </a>
                )}
                {method?.quickCreateUrl && (
                  <a href={method.quickCreateUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <ExternalLink className="h-3 w-3" aria-hidden="true" /> Quick-create the role
                  </a>
                )}
                {connector.docsUrl && (
                  <a href={connector.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
                    <ExternalLink className="h-3 w-3" aria-hidden="true" /> Docs
                  </a>
                )}
              </div>

              {failure && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" data-testid="connect-failure">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="font-medium text-destructive">Validation failed</p>
                    <p className="text-muted-foreground">{failure.message}</p>
                    {failure.connection && (
                      <p className="text-xs text-muted-foreground">The connection was kept as failed. Fix the value and try again, or find it under Settings and rotate it later.</p>
                    )}
                  </div>
                </div>
              )}

              {method && isFormMethod(method.type) && (
                <form onSubmit={submitForm} className="space-y-4" noValidate data-testid="connect-form">
                  <JsonSchemaForm schema={method.schema} value={values} onChange={setValues} errors={fieldErrors} mode="create" disabled={busy} />
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
                    <Button type="submit" disabled={busy}>
                      {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : failure ? <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
                      {failure ? 'Retry' : rotateConnection ? 'Rotate' : 'Connect'}
                    </Button>
                  </div>
                </form>
              )}

              {method && isRedirectMethod(method.type) && (
                <div className="space-y-4">
                  {method.scopes && method.scopes.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Scopes requested</p>
                      <div className="flex flex-wrap gap-1">
                        {method.scopes.map((s) => (
                          <span key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{s}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {oauth.phase === 'idle' && (
                    <Button type="button" onClick={startOAuth} disabled={busy} className="w-full">
                      {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />}
                      Continue with {connector.displayName}
                    </Button>
                  )}

                  {oauth.phase === 'waiting' && (
                    <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="oauth-waiting">
                      <p className="flex items-center gap-2 font-medium">
                        <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" /> Waiting for {connector.displayName}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">Finish signing in on the tab that opened. This closes on its own once the account is linked.</p>
                      <a href={oauth.authorizeUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                        <ExternalLink className="h-3 w-3" aria-hidden="true" /> Open the sign-in tab again
                      </a>
                    </div>
                  )}

                  {oauth.phase === 'timeout' && (
                    <div role="alert" className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
                      <p className="font-medium">Still waiting</p>
                      <p className="mt-1 text-xs text-muted-foreground">No callback arrived. Start over or paste the code the provider showed.</p>
                      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setOauth({ phase: 'idle' })}>Start over</Button>
                    </div>
                  )}

                  {oauth.phase !== 'idle' && !pasteMode && (
                    <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setPasteMode(true)}>
                      Paste the code instead
                    </button>
                  )}

                  {oauth.phase !== 'idle' && pasteMode && (
                    <form onSubmit={submitCode} className="space-y-2" data-testid="paste-code-form">
                      <Label htmlFor="connect-oauth-code">Authorization code</Label>
                      <div className="flex gap-2">
                        <Input id="connect-oauth-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code from the provider" autoComplete="off" className="font-mono" />
                        <Button type="submit" disabled={busy || !code.trim()}>
                          {complete.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
                          <span className="ml-1">Finish</span>
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">For headless setups where the callback cannot reach this browser.</p>
                    </form>
                  )}
                </div>
              )}

              {connector.connect.length === 0 && (
                <p className="text-sm text-muted-foreground">This connector has no connect method configured.</p>
              )}
            </>
          )}

          {!connectorsQuery.isLoading && !connector && !targetKey && connectors.length === 0 && !connectorsQuery.isError && (
            <p className="text-sm text-muted-foreground">Nothing to connect{kind ? ` for ${CONNECTOR_KIND_LABELS[kind].toLowerCase()}` : ''} yet.</p>
          )}
          {!connectorsQuery.isLoading && targetKey && !connector && !connectorsQuery.isError && (
            <p role="alert" className="text-sm text-destructive">Connector {targetKey} is not available.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ConnectorPicker({ connectors, search, onSearch, onPick }: { connectors: Connector[]; search: string; onSearch: (s: string) => void; onPick: (c: Connector) => void }) {
  const filtered = connectors.filter((c) => matchesConnectorSearch(c, search))
  const groups = groupConnectorsByKind(filtered, CONNECTOR_KINDS)
  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search connectors" className="pl-9" aria-label="Search connectors" />
      </div>
      {groups.length === 0 && connectors.length > 0 && <p className="text-sm text-muted-foreground">No connector matches.</p>}
      {groups.map((group) => (
        <div key={group.kind} className="space-y-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{CONNECTOR_KIND_LABELS[group.kind]}</p>
          <div className="grid grid-cols-1 gap-2">
            {group.connectors.map((c) => {
              const best = bestConnectMethod(c)
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => onPick(c)}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:border-primary/60 hover:bg-accent"
                  data-testid={`connector-option-${c.key}`}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{c.displayName}</div>
                    {c.description && <div className="truncate text-xs text-muted-foreground">{c.description}</div>}
                  </div>
                  {best && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{CONNECT_METHOD_LABELS[best.type]}</span>}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

export interface ConnectAccountButtonProps {
  kind?: ConnectorKind
  connectorKey?: string
  owner?: ConnectionOwner
  onConnected: (connection: Connection) => void
  label?: string
  variant?: 'outline' | 'ghost' | 'link' | 'secondary' | 'default'
  size?: 'sm' | 'default'
  className?: string
}

/**
 * A button that opens the connect sheet: what every consumer dialog embeds
 * next to its own credential field.
 */
export function ConnectAccountButton({ kind, connectorKey, owner, onConnected, label = 'Connect an account', variant = 'outline', size = 'sm', className }: ConnectAccountButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" variant={variant} size={size} className={cn('gap-1.5', className)} onClick={() => setOpen(true)}>
        <Plug className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </Button>
      {/* Mounted only while open: consumers render outside a QueryClientProvider in some tests, and nothing is needed until then. */}
      {open && <ConnectSheet open={open} onOpenChange={setOpen} kind={kind} connectorKey={connectorKey} owner={owner} onConnected={onConnected} />}
    </>
  )
}
