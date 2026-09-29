/**
 * The connect flow every place uses: pick a service from the tiles, then
 * give it the one thing it needs (its key, or a sign-in at the service),
 * say who can use it, and it is checked on save. Everything else (other
 * ways to connect, optional settings, pasting a sign-in code) waits under
 * Advanced.
 *
 * It is never a dialog. It renders in one of two places:
 *   - the Connections page, /connections/connect (pages/connections-connect.tsx);
 *   - inline, right under a form's "Connect an account" button
 *     (ConnectAccountButton below), so a half-filled form keeps its state and
 *     gets the new connection handed straight back.
 *
 * Inline, it sits inside the other form's <form>, so it renders no <form>
 * of its own there (a nested form is invalid and would submit the outer
 * one): `embedded` swaps the forms for groups whose buttons and Enter key
 * call the handler directly.
 *
 * With `rotateConnection` the same form replaces the key of an existing
 * connection (POST /connections/:id/rotate) instead of making a new one.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Brain, Cloud, Database, ExternalLink, KeyRound, Loader2, MessageSquare, Package, Plug, Server, Wrench } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { JsonSchemaForm, isSecretProperty, schemaDefaults, validateSchemaValues, type SchemaFormValues } from '@/components/ui/json-schema-form'
import type { VisibilityValue } from '@/components/ui/visibility-field'
import { ServiceIcon, ServiceTileGrid, type ServiceTileGroup } from '@/components/connect/service-tiles'
import { WhoCanUse } from '@/components/connect/who-can-use'
import { providerLogos } from '@/components/llm-providers/provider-type-config'
import { useOrganizationRole } from '@/hooks/use-organization-role'
import { organizationsApi } from '@/lib/api'
import {
  allowUserScopedConnections,
  bestConnectMethod,
  connectionsApi,
  connectorsApi,
  errorMessage,
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
import type { JsonSchemaObject } from '@/types/deployments'
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

/** The catalog's "Other service": a name and one secret box. */
export const OTHER_SERVICE_KEY = 'other'

const KIND_ICONS: Record<ConnectorKind, typeof Plug> = {
  inference: Brain,
  deployment: Server,
  memory: Database,
  mcp: Plug,
  tool_source: Wrench,
  channel: MessageSquare,
  cloud: Cloud,
  registry: Package,
}

/** A connector's logo: the provider's own for AI models, else its kind's icon. */
export function connectorIcon(connector: Pick<Connector, 'key' | 'kind' | 'providerType'> | null | undefined): ReactNode {
  if (!connector) return <Plug className="h-4 w-4 text-primary" />
  const logo = providerLogos[(connector.providerType ?? connector.key) as keyof typeof providerLogos]
  if (logo) return logo
  if (connector.key === OTHER_SERVICE_KEY) return <KeyRound className="h-4 w-4 text-primary" />
  const Icon = KIND_ICONS[connector.kind] ?? Plug
  return <Icon className="h-4 w-4 text-primary" />
}

/** The catalog as tile groups, in gallery order, with "Other service" last on its own. */
export function connectorTileGroups(connectors: Connector[], search: string): ServiceTileGroup[] {
  const shown = connectors.filter((c) => matchesConnectorSearch(c, search))
  const groups: ServiceTileGroup[] = []
  for (const kind of CONNECTOR_KINDS) {
    const tiles = shown
      .filter((c) => c.kind === kind && c.key !== OTHER_SERVICE_KEY)
      .map((c) => ({ key: c.key, label: c.displayName, icon: connectorIcon(c) }))
    if (tiles.length > 0) groups.push({ id: kind, title: CONNECTOR_KIND_LABELS[kind], tiles })
  }
  const other = connectors.find((c) => c.key === OTHER_SERVICE_KEY)
  // "Other service" is the answer to a search that found nothing, so it stays.
  if (other) groups.push({ id: 'other', title: 'Something else', tiles: [{ key: other.key, label: other.displayName, icon: connectorIcon(other) }] })
  return groups
}

export function useConnectors() {
  return useQuery({
    queryKey: CONNECTORS_QUERY_KEY,
    queryFn: async () => {
      const rows = await connectorsApi.list()
      return Array.isArray(rows) ? rows : []
    },
  })
}

/**
 * Who may keep what. Organization connections need an admin; "only you"
 * needs the organization to allow personal keys. A role that is not known
 * yet offers both and lets the server decide, as it always does.
 */
export function useConnectOwners(): { options: Array<'org' | 'private'>; loading: boolean } {
  const { currentOrganization } = useOrganizationStore()
  const { role, canManage } = useOrganizationRole()
  const orgQuery = useQuery({
    queryKey: ['organization-details', currentOrganization?.id],
    queryFn: () => organizationsApi.getById(currentOrganization!.id),
    enabled: !!currentOrganization?.id,
  })
  const options: Array<'org' | 'private'> = []
  if (role === null || canManage) options.push('org')
  if (allowUserScopedConnections(orgQuery.data)) options.push('private')
  return { options, loading: orgQuery.isLoading }
}

export interface ConnectFlowProps {
  /** Only connectors of this kind are offered. */
  kind?: ConnectorKind
  /** Skip the tiles and go straight to this connector. */
  connectorKey?: string
  onConnected: (connection: Connection) => void
  /** Cancel, inline. */
  onCancel: () => void
  /** Replace the key of this connection instead of making a new one. */
  rotateConnection?: Connection | null
  /** How often the sign-in wait asks for the connection. */
  pollIntervalMs?: number
  /** Inline inside another form: no <form> elements, and a title of its own. */
  embedded?: boolean
  /** Picking a tile. On a page this navigates to the tile's URL; absent, the pick is kept here. */
  onPick?: (connector: Connector) => void
}

type SignIn =
  | { phase: 'idle' }
  | { phase: 'waiting'; authorizeUrl: string; state: string; byCode: boolean }
  | { phase: 'timeout'; authorizeUrl: string; state: string; byCode: boolean }

interface Failure {
  message: string
  detail?: string
  /** The server kept the connection with failed health; the next try replaces its key. */
  connection?: Connection
}

/** What a connect is about to do, as a title. */
export function connectTitle(connector: Connector | null | undefined, rotateConnection?: Connection | null): string {
  if (rotateConnection) return `Replace the key of ${rotateConnection.name}`
  return connector ? `Connect ${connector.displayName}` : 'Connect a service'
}

/** A <form> on a page; a group that submits on its buttons and Enter when embedded. */
function FormBox({ embedded, onSubmit, children, className, testId, label }: { embedded?: boolean; onSubmit: (e: SyntheticEvent) => void; children: ReactNode; className?: string; testId?: string; label?: string }) {
  if (!embedded) {
    return (
      <form onSubmit={onSubmit} className={className} noValidate data-testid={testId} aria-label={label}>
        {children}
      </form>
    )
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') onSubmit(e)
  }
  return (
    <div role="group" className={className} data-testid={testId} aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  )
}

/** The fields a first connect asks for (required and secret ones), and the rest for Advanced. */
export function splitConnectSchema(schema: JsonSchemaObject | null | undefined): { main: JsonSchemaObject; extra: JsonSchemaObject | null } {
  const props = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const main: Record<string, any> = {}
  const extra: Record<string, any> = {}
  for (const [key, prop] of Object.entries(props)) {
    if (required.has(key) || isSecretProperty(prop)) main[key] = prop
    else extra[key] = prop
  }
  // A schema with nothing required and nothing secret still asks for something.
  if (Object.keys(main).length === 0) return { main: { ...(schema ?? { type: 'object' }), properties: props } as JsonSchemaObject, extra: null }
  return {
    main: { ...(schema as JsonSchemaObject), properties: main, required: [...required].filter((k) => k in main) },
    extra: Object.keys(extra).length > 0 ? ({ ...(schema as JsonSchemaObject), properties: extra, required: [] } as JsonSchemaObject) : null,
  }
}

/** A refused connect, in plain words; the service's own answer goes under Details. */
function readFailure(error: unknown, connector: Connector): Failure {
  const validation = readValidationFailure(error)
  if (validation) {
    const status = validation.connection?.health?.status
    const message =
      status === 'quota'
        ? `${connector.displayName} accepted the key, but the account is out of credit or over its limit.`
        : status === 'expired' || status === 'revoked'
          ? `${connector.displayName} says this key is ${status}.`
          : `${connector.displayName} did not accept this.`
    return { message, detail: validation.message, connection: validation.connection }
  }
  return { message: errorMessage(error, `${connector.displayName} could not be connected.`) }
}

export function ConnectFlow({ kind, connectorKey, onConnected, onCancel, rotateConnection, pollIntervalMs = 2000, embedded = false, onPick }: ConnectFlowProps) {
  const targetKey = rotateConnection?.connectorKey ?? connectorKey
  const [search, setSearch] = useState('')
  const [pickedKey, setPickedKey] = useState<string | null>(targetKey ?? null)
  const connectorsQuery = useConnectors()

  const connectors: Connector[] = useMemo(() => (connectorsQuery.data ?? []).filter((c) => !kind || c.kind === kind), [connectorsQuery.data, kind])
  const connector = useMemo(() => (pickedKey ? (connectorsQuery.data ?? []).find((c) => c.key === pickedKey) ?? null : null), [connectorsQuery.data, pickedKey])

  // A different fixed connector starts over.
  useEffect(() => {
    setSearch('')
    setPickedKey(targetKey ?? null)
  }, [targetKey])

  // One match for the requested kind: skip the tiles.
  useEffect(() => {
    if (!targetKey && !pickedKey && connectors.length === 1) setPickedKey(connectors[0].key)
  }, [targetKey, pickedKey, connectors])

  const pick = (key: string) => {
    const c = connectors.find((x) => x.key === key)
    if (!c) return
    if (onPick) onPick(c)
    else setPickedKey(c.key)
  }

  return (
    <div className={cn('space-y-5', embedded && 'rounded-lg border bg-muted/30 p-4')} data-testid="connect-flow">
      {embedded && (
        <div className="flex items-center gap-2">
          {connector && <ServiceIcon>{connectorIcon(connector)}</ServiceIcon>}
          <h3 className="text-sm font-semibold">{connectTitle(connector, rotateConnection)}</h3>
        </div>
      )}

      {connectorsQuery.isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading services
        </p>
      )}
      {connectorsQuery.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(connectorsQuery.error, 'The list of services could not be loaded.')}
        </p>
      )}

      {!connectorsQuery.isLoading && !connectorsQuery.isError && !connector && !targetKey && (
        <ServiceTileGrid
          groups={connectorTileGroups(connectors, search)}
          search={search}
          onSearch={setSearch}
          onPick={pick}
          searchLabel="Search services"
          testIdPrefix="service-tile"
          empty={<p className="text-sm text-muted-foreground">Nothing to connect here yet.</p>}
        />
      )}

      {connector && (
        <ConnectServiceForm
          key={connector.key}
          connector={connector}
          embedded={embedded}
          rotateConnection={rotateConnection}
          pollIntervalMs={pollIntervalMs}
          onConnected={onConnected}
          onCancel={embedded ? onCancel : undefined}
          onChooseAnother={embedded && !targetKey ? () => setPickedKey(null) : undefined}
        />
      )}

      {!connectorsQuery.isLoading && targetKey && !connector && !connectorsQuery.isError && (
        <p role="alert" className="text-sm text-destructive">
          This service is not available.
        </p>
      )}

      {embedded && !connector && (
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}

export interface ConnectServiceFormProps {
  connector: Connector
  onConnected: (connection: Connection) => void
  embedded?: boolean
  rotateConnection?: Connection | null
  pollIntervalMs?: number
  /** Inline only: fold the flow away. */
  onCancel?: () => void
  /** Inline only: back to the tiles. */
  onChooseAnother?: () => void
}

/**
 * One service: its key (or a sign-in at the service), who can use it, and
 * Connect. Saving checks it with the service; a refusal is said in plain
 * words next to the key and the form stays filled.
 */
export function ConnectServiceForm({ connector, onConnected, embedded = false, rotateConnection, pollIntervalMs = 2000, onCancel, onChooseAnother }: ConnectServiceFormProps) {
  const owners = useConnectOwners()
  const [methodType, setMethodType] = useState<ConnectMethod['type'] | null>(rotateConnection?.method ?? null)
  const [who, setWho] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [name, setName] = useState('')
  const [values, setValues] = useState<SchemaFormValues>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<Failure | null>(null)
  const [signIn, setSignIn] = useState<SignIn>({ phase: 'idle' })
  const [code, setCode] = useState('')
  const pollAbort = useRef<AbortController | null>(null)

  const method: ConnectMethod | null = useMemo(() => connector.connect.find((m) => m.type === methodType) ?? bestConnectMethod(connector), [connector, methodType])
  const { main, extra } = useMemo(() => splitConnectSchema(method?.schema), [method?.schema])
  const keyPageUrl = method?.keyPageUrl ?? connector.keyPageUrl ?? null
  const isOther = connector.key === OTHER_SERVICE_KEY && !rotateConnection
  const shapeOnly = connector.validation?.kind === 'format'

  // Whoever cannot keep an organization connection keeps a private one.
  useEffect(() => {
    if (owners.options.length > 0 && !owners.options.includes(who.visibility as 'org' | 'private')) setWho({ visibility: owners.options[0], teamId: null })
  }, [owners.options.join(','), who.visibility])

  useEffect(() => {
    setValues(schemaDefaults(method?.schema))
    setFieldErrors({})
    setFailure(null)
  }, [method?.type])

  const stopPolling = () => {
    pollAbort.current?.abort()
    pollAbort.current = null
  }
  useEffect(() => () => stopPolling(), [])

  const finish = (connection: Connection) => {
    stopPolling()
    onConnected(connection)
  }

  const startPolling = (redirect: ConnectRedirect) => {
    stopPolling()
    const controller = new AbortController()
    pollAbort.current = controller
    const byCode = redirect.completeWith === 'code'
    setSignIn({ phase: 'waiting', authorizeUrl: redirect.authorizeUrl, state: redirect.state, byCode })
    const target: PollTarget = { connectorKey: connector.key, since: Date.now() - 1000, connectionId: rotateConnection?.id }
    void pollForConnection(target, { intervalMs: pollIntervalMs, signal: controller.signal, list: () => connectionsApi.list() }).then((found) => {
      if (controller.signal.aborted) return
      if (found) finish(found)
      else setSignIn({ phase: 'timeout', authorizeUrl: redirect.authorizeUrl, state: redirect.state, byCode })
    })
  }

  const handleResult = (result: ConnectResult) => {
    if (isConnectRedirect(result)) {
      window.open(result.authorizeUrl, '_blank', 'noopener')
      startPolling(result)
      return
    }
    if (isConnectForm(result)) {
      setFailure({ message: 'Fill in the key and try again.' })
      return
    }
    if (result?.connection) finish(result.connection)
  }

  const owner: ConnectionOwner = who.visibility === 'private' ? 'private' : 'org'
  const connect = useMutation({
    mutationFn: (input?: Record<string, unknown>) => {
      // A key the service refused was kept as a failed connection: the next
      // try replaces its key rather than leaving a second, broken one behind.
      const existing = rotateConnection ?? failure?.connection ?? null
      if (existing) return connectionsApi.rotate(existing.id, input ? { input } : {})
      return connectionsApi.connect(connector.key, { method: method?.type, owner, ...(isOther ? { name: name.trim() } : {}), ...(input ? { input } : {}) })
    },
    onSuccess: handleResult,
    onError: (error: unknown) => setFailure((prev) => {
      const next = readFailure(error, connector)
      return { ...next, connection: next.connection ?? prev?.connection }
    }),
  })

  const complete = useMutation({
    mutationFn: (payload: { state: string; code: string }) => connectionsApi.complete(connector.key, payload),
    onSuccess: (connection) => {
      if (connection?.id) finish(connection)
    },
    onError: (error: unknown) => setFailure({ message: errorMessage(error, 'The code was not accepted.') }),
  })

  const submitForm = (e: SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!method) return
    const errors: Record<string, string> = {}
    if (isOther && !name.trim()) errors.__name = 'Give it a name you will recognise'
    const check = validateSchemaValues(method.schema, values, { mode: 'create' })
    if (!check.ok) Object.assign(errors, check.errors)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return
    connect.mutate(check.value)
  }

  const startSignIn = () => {
    setFailure(null)
    connect.mutate(undefined)
  }

  const submitCode = (e: SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (signIn.phase === 'idle' || !code.trim()) return
    setFailure(null)
    complete.mutate({ state: signIn.state, code: code.trim() })
  }

  const busy = connect.isPending || complete.isPending
  const submitType = embedded ? 'button' : 'submit'
  const redirect = !!method && isRedirectMethod(method.type)
  const others = connector.connect.filter((m) => m.type !== method?.type)

  if (!method) return <p className="text-sm text-muted-foreground">This service has no way to connect yet.</p>

  if (!rotateConnection && !owners.loading && owners.options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="connect-admins-only">
        Only admins can connect services for your organization. Ask one to connect {connector.displayName}, or to allow personal keys.
      </p>
    )
  }

  const failureBox = failure && (
    <div id="connect-failure" role="alert" className="space-y-1 text-sm text-destructive" data-testid="connect-failure">
      <p>{failure.message}</p>
      {failure.detail && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <span className="break-words">{failure.detail}</span>
        </details>
      )}
    </div>
  )

  const keyLink = keyPageUrl && (
    <a href={keyPageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
      {method.type === 'service_account' ? 'Get a service account key' : 'Get a key'}
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  )

  const whoLine = !rotateConnection && (
    <WhoCanUse value={who} onChange={setWho} disabled={busy} noun="this connection" options={owners.options.length > 0 ? owners.options : ['org']} />
  )

  const advanced = (others.length > 0 || extra || method.description || (redirect && signIn.phase !== 'idle' && !signIn.byCode)) && (
    <Disclosure title="Advanced" testId="connect-advanced">
      {others.length > 0 && (
        <div className="space-y-1.5">
          <Label>Another way to connect</Label>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Another way to connect">
            {connector.connect.map((m) => (
              <Button key={m.type} type="button" size="sm" variant={m.type === method.type ? 'default' : 'outline'} role="radio" aria-checked={m.type === method.type} onClick={() => setMethodType(m.type)}>
                {m.label || CONNECT_METHOD_LABELS[m.type]}
              </Button>
            ))}
          </div>
        </div>
      )}
      {method.description && (
        <div className="space-y-1">
          <p className="text-sm font-medium">Where to find it</p>
          <p className="whitespace-pre-wrap text-xs text-muted-foreground" data-testid="connect-instructions">
            {method.description}
          </p>
        </div>
      )}
      {extra && !redirect && <JsonSchemaForm schema={extra} value={values} onChange={setValues} errors={fieldErrors} mode="create" disabled={busy} />}
      {redirect && signIn.phase !== 'idle' && !signIn.byCode && <PasteCode embedded={embedded} code={code} onCode={setCode} onSubmit={submitCode} busy={busy} submitType={submitType} pending={complete.isPending} />}
    </Disclosure>
  )

  if (redirect) {
    return (
      <div className="space-y-4" data-testid="connect-form">
        <p className="text-sm text-muted-foreground">You sign in at {connector.displayName} and come back here. Nothing to paste.</p>
        {failureBox}
        {signIn.phase === 'idle' && (
          <>
            {whoLine}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={startSignIn} disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <ExternalLink className="mr-2 h-4 w-4" aria-hidden />}
                Connect
              </Button>
              {onCancel && (
                <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
                  Cancel
                </Button>
              )}
            </div>
          </>
        )}
        {signIn.phase === 'waiting' && (
          <div className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="oauth-waiting">
            <p className="flex items-center gap-2 font-medium">
              <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden /> Waiting for {connector.displayName}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Finish signing in on the tab that opened. This moves on by itself.</p>
            <a href={signIn.authorizeUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <ExternalLink className="h-3 w-3" aria-hidden /> Open the sign-in tab again
            </a>
          </div>
        )}
        {signIn.phase === 'timeout' && (
          <div role="alert" className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
            <p className="font-medium">Still waiting</p>
            <p className="mt-1 text-xs text-muted-foreground">Nothing came back from {connector.displayName}. Try again.</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setSignIn({ phase: 'idle' })}>
              Start over
            </Button>
          </div>
        )}
        {signIn.phase !== 'idle' && signIn.byCode && <PasteCode embedded={embedded} code={code} onCode={setCode} onSubmit={submitCode} busy={busy} submitType={submitType} pending={complete.isPending} />}
        {advanced}
        {onChooseAnother && <ChooseAnother onClick={onChooseAnother} />}
      </div>
    )
  }

  if (!isFormMethod(method.type)) return <p className="text-sm text-muted-foreground">This service has no way to connect yet.</p>

  return (
    <FormBox embedded={embedded} onSubmit={submitForm} className="space-y-4" testId="connect-form" label={connectTitle(connector, rotateConnection)}>
      {isOther && (
        <div>
          <Label htmlFor="connect-other-name">Name</Label>
          <Input
            id="connect-other-name"
            className="mt-1"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setFieldErrors((prev) => ({ ...prev, __name: '' }))
            }}
            placeholder="e.g. Acme CRM"
            aria-invalid={!!fieldErrors.__name}
            disabled={busy}
          />
          {fieldErrors.__name && (
            <p className="mt-1 text-xs text-destructive" role="alert">
              {fieldErrors.__name}
            </p>
          )}
        </div>
      )}
      <JsonSchemaForm schema={main} value={values} onChange={setValues} errors={fieldErrors} mode="create" disabled={busy} />
      {failureBox}
      {keyLink}
      {whoLine}
      {advanced}
      <div className="flex flex-wrap items-center gap-3">
        <Button type={submitType} onClick={embedded ? submitForm : undefined} disabled={busy}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {busy ? (shapeOnly ? 'Saving...' : 'Checking your key...') : rotateConnection ? 'Replace key' : 'Connect'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        {busy && !shapeOnly && <span className="text-xs text-muted-foreground">This takes a few seconds.</span>}
      </div>
      {onChooseAnother && <ChooseAnother onClick={onChooseAnother} />}
    </FormBox>
  )
}

function ChooseAnother({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={onClick}>
      Choose another service
    </button>
  )
}

function PasteCode({ embedded, code, onCode, onSubmit, busy, submitType, pending }: { embedded: boolean; code: string; onCode: (v: string) => void; onSubmit: (e: SyntheticEvent) => void; busy: boolean; submitType: 'button' | 'submit'; pending: boolean }) {
  return (
    <FormBox embedded={embedded} onSubmit={onSubmit} className="space-y-2" testId="paste-code-form">
      <Label htmlFor="connect-oauth-code">Code from the service</Label>
      <div className="flex gap-2">
        <Input id="connect-oauth-code" value={code} onChange={(e) => onCode(e.target.value)} placeholder="Paste the code" autoComplete="off" data-1p-ignore="true" data-lpignore="true" className="font-mono" />
        <Button type={submitType} onClick={embedded ? onSubmit : undefined} disabled={busy || !code.trim()}>
          {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          Finish
        </Button>
      </div>
    </FormBox>
  )
}

export interface ConnectAccountButtonProps {
  kind?: ConnectorKind
  connectorKey?: string
  onConnected: (connection: Connection) => void
  label?: string
  variant?: 'outline' | 'ghost' | 'link' | 'secondary' | 'default'
  size?: 'sm' | 'default'
  className?: string
}

/**
 * "Connect an account" next to a form's own key field. The connect flow
 * opens inline under the button, so the half-filled form stays where it is
 * and the new connection is handed straight back through `onConnected`.
 */
export function ConnectAccountButton({ kind, connectorKey, onConnected, label = 'Connect an account', variant = 'outline', size = 'sm', className }: ConnectAccountButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('space-y-3', open && 'w-full basis-full')}>
      {!open && (
        <Button type="button" variant={variant} size={size} className={cn('gap-1.5', className)} onClick={() => setOpen(true)} aria-expanded={false}>
          <Plug className="h-3.5 w-3.5" aria-hidden />
          {label}
        </Button>
      )}
      {/* Mounted only while open: some forms render outside a QueryClientProvider in tests, and nothing is needed until then. */}
      {open && (
        <ConnectFlow
          embedded
          kind={kind}
          connectorKey={connectorKey}
          onCancel={() => setOpen(false)}
          onConnected={(connection) => {
            setOpen(false)
            onConnected(connection)
          }}
        />
      )}
    </div>
  )
}
