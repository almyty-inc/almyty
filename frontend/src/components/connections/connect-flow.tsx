/**
 * The fields of one service's credential: its key (or a sign-in at the
 * service), who can use it, and Save, checked with the service on save.
 * Optional settings and other ways to sign in wait under "More options".
 *
 * The add-credential form (components/credentials/credential-form.tsx)
 * puts its Name and Service fields above this; the credential page uses it
 * to replace a key (`rotateConnection`).
 *
 * Inline inside another form (`embedded`) it renders no <form> of its own
 * (a nested form is invalid and would submit the outer one): its buttons
 * and Enter key call the handler directly.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ExternalLink, KeyRound, Loader2, LockKeyhole, LogIn, Plug, Settings2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { JsonSchemaForm, isSecretProperty, schemaDefaults, validateSchemaValues, type SchemaFormValues } from '@/components/ui/json-schema-form'
import type { VisibilityValue } from '@/components/ui/visibility-field'
import { WhoCanUse } from '@/components/connect/who-can-use'
import { BrandIcon } from '@/components/brand-icon'
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
  pollForConnection,
  readValidationFailure,
  type PollTarget,
} from '@/lib/connections-api'
import { useOrganizationStore } from '@/store/organization'
import type { JsonSchemaObject } from '@/types/deployments'
import {
  CONNECT_METHOD_LABELS,
  type ConnectMethod,
  type ConnectRedirect,
  type ConnectResult,
  type Connection,
  type ConnectionOwner,
  type Connector,
} from '@/types/connections'

export const CONNECTORS_QUERY_KEY = ['connectors'] as const

/** The catalog's "Other service": a name and one secret box. */
export const OTHER_SERVICE_KEY = 'other'

const TEAM_MISSING = 'Pick the team that can use it.'

/** The general kinds of key have no brand: a plain icon says what they are. */
const GENERAL_ICONS: Record<string, typeof Plug> = {
  [OTHER_SERVICE_KEY]: KeyRound,
  'basic-auth': LockKeyhole,
  oauth2: LogIn,
  custom: Settings2,
}

/** A service's logo: its brand's mark, or the first letter of its name. */
export function connectorIcon(connector: (Pick<Connector, 'key'> & Partial<Pick<Connector, 'providerType' | 'displayName'>>) | null | undefined): ReactNode {
  if (!connector) return <Plug className="h-4 w-4 text-muted-foreground" aria-hidden />
  const General = GENERAL_ICONS[connector.key]
  if (General && !connector.providerType) return <General className="h-4 w-4 text-muted-foreground" aria-hidden />
  return <BrandIcon brand={connector.providerType ?? connector.key} name={connector.displayName ?? connector.key} />
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
 * needs the organization to allow personal keys; "one team" needs a team
 * to pick (the server then checks the caller may use that team, as it
 * does for a provider connection). A role that is not known yet offers
 * the organization and lets the server decide, as it always does.
 */
export function useConnectOwners(): { options: Array<'org' | 'team' | 'private'>; loading: boolean; firstTeamId: string | null } {
  const { currentOrganization } = useOrganizationStore()
  const { role, canManage } = useOrganizationRole()
  const orgQuery = useQuery({
    queryKey: ['organization-details', currentOrganization?.id],
    queryFn: () => organizationsApi.getById(currentOrganization!.id),
    enabled: !!currentOrganization?.id,
  })
  // The key VisibilityField reads the same teams under.
  const teamsQuery = useQuery<Array<{ id: string }>>({
    queryKey: ['organization-teams', currentOrganization?.id],
    queryFn: () => organizationsApi.getTeams(currentOrganization!.id),
    enabled: !!currentOrganization?.id,
  })
  const teams = Array.isArray(teamsQuery.data) ? teamsQuery.data : []
  const options: Array<'org' | 'team' | 'private'> = []
  if (role === null || canManage) options.push('org')
  if (allowUserScopedConnections(orgQuery.data)) options.push('private')
  if (teams.length > 0) options.push('team')
  return { options, loading: orgQuery.isLoading || teamsQuery.isLoading, firstTeamId: teams[0]?.id ?? null }
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
  if (connector?.key === OTHER_SERVICE_KEY) return 'Add a key'
  return connector ? `Add ${connector.displayName}` : 'Add credential'
}

/** A <form> on a page; a group that submits on its buttons and Enter when embedded. */
export function FormBox({ embedded, onSubmit, children, className, testId, label }: { embedded?: boolean; onSubmit: (e: SyntheticEvent) => void; children: ReactNode; className?: string; testId?: string; label?: string }) {
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

/** The fields a first connect asks for (required and secret ones), and the rest (and anything marked x-advanced) for Advanced. */
export function splitConnectSchema(schema: JsonSchemaObject | null | undefined): { main: JsonSchemaObject; extra: JsonSchemaObject | null } {
  const props = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const main: Record<string, any> = {}
  const extra: Record<string, any> = {}
  for (const [key, prop] of Object.entries(props)) {
    if (prop['x-advanced'] && !required.has(key)) extra[key] = prop
    else if (required.has(key) || isSecretProperty(prop)) main[key] = prop
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
  return { message: errorMessage(error, `${connector.displayName} was not saved.`) }
}

export interface ConnectServiceFormProps {
  connector: Connector
  onConnected: (connection: Connection) => void
  embedded?: boolean
  rotateConnection?: Connection | null
  pollIntervalMs?: number
  /** Inline only: fold the flow away. */
  onCancel?: () => void
  /** The name the new credential is saved under (the form's Name field). */
  name?: string
  /** Called instead of saving when `name` is given but empty, so the Name field can say so. */
  onNameMissing?: () => void
  /** Told whether a value has been typed and not saved yet. */
  onDirtyChange?: (dirty: boolean) => void
}

/**
 * One service: its key (or a sign-in at the service), who can use it, and
 * Save. Saving checks it with the service; a refusal is said in plain
 * words next to the key and the form stays filled.
 */
export function ConnectServiceForm({ connector, onConnected, embedded = false, rotateConnection, pollIntervalMs = 2000, onCancel, name, onNameMissing, onDirtyChange }: ConnectServiceFormProps) {
  const owners = useConnectOwners()
  const [methodType, setMethodType] = useState<ConnectMethod['type'] | null>(rotateConnection?.method ?? null)
  const [who, setWho] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [values, setValues] = useState<SchemaFormValues>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<Failure | null>(null)
  const [signIn, setSignIn] = useState<SignIn>({ phase: 'idle' })
  const [code, setCode] = useState('')
  const pollAbort = useRef<AbortController | null>(null)

  const method: ConnectMethod | null = useMemo(() => connector.connect.find((m) => m.type === methodType) ?? bestConnectMethod(connector), [connector, methodType])
  const { main, extra } = useMemo(() => splitConnectSchema(method?.schema), [method?.schema])
  const keyPageUrl = method?.keyPageUrl ?? connector.keyPageUrl ?? null
  const newName = !rotateConnection && name !== undefined ? name.trim() : undefined
  const nameMissing = newName !== undefined && !newName
  const shapeOnly = connector.validation?.kind === 'format'

  // Whoever cannot keep an organization connection keeps a private one.
  useEffect(() => {
    if (owners.options.length > 0 && !owners.options.includes(who.visibility)) {
      setWho(owners.options[0] === 'team' ? { visibility: 'team', teamId: owners.firstTeamId } : { visibility: owners.options[0], teamId: null })
    }
  }, [owners.options.join(','), who.visibility])

  useEffect(() => {
    setValues(schemaDefaults(method?.schema))
    setFieldErrors({})
    setFailure(null)
  }, [method?.type])

  // Something typed that is not a default yet: a half-entered key.
  const defaults = useMemo(() => schemaDefaults(method?.schema), [method?.schema])
  const dirty = Object.entries(values).some(([k, v]) => v !== undefined && v !== '' && v !== defaults[k])
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty])
  useEffect(() => () => onDirtyChange?.(false), [])

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

  const owner: ConnectionOwner = who.visibility === 'private' ? 'private' : who.visibility === 'team' ? 'team' : 'org'
  // "One team" names the team; a new credential without one is not sent.
  const teamMissing = !rotateConnection && owner === 'team' && !who.teamId
  const connect = useMutation({
    mutationFn: (input?: Record<string, unknown>) => {
      // A key the service refused was kept as a failed connection: the next
      // try replaces its key rather than leaving a second, broken one behind.
      const existing = rotateConnection ?? failure?.connection ?? null
      if (existing) return connectionsApi.rotate(existing.id, input ? { input } : {})
      return connectionsApi.connect(connector.key, { method: method?.type, owner, ...(owner === 'team' && who.teamId ? { teamId: who.teamId } : {}), ...(newName ? { name: newName } : {}), ...(input ? { input } : {}) })
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
    const check = validateSchemaValues(method.schema, values, { mode: 'create' })
    if (!check.ok) Object.assign(errors, check.errors)
    setFieldErrors(errors)
    if (nameMissing) onNameMissing?.()
    if (Object.keys(errors).length > 0 || nameMissing) return
    if (teamMissing) {
      setFailure({ message: TEAM_MISSING })
      return
    }
    connect.mutate(check.value)
  }

  const startSignIn = () => {
    if (nameMissing) {
      onNameMissing?.()
      return
    }
    if (teamMissing) {
      setFailure({ message: TEAM_MISSING })
      return
    }
    setFailure(null)
    // A sign-in that needs to know where first (an MCP server's address).
    // Signing in again reuses what the connection already has.
    if (method && !rotateConnection && Object.keys(method.schema?.properties ?? {}).length > 0) {
      const check = validateSchemaValues(method.schema, values, { mode: 'create' })
      setFieldErrors(check.ok ? {} : check.errors)
      if (!check.ok) return
      connect.mutate(check.value)
      return
    }
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
  // A sign-in that asks where first (an MCP server): its form comes before the button.
  const signInForm = redirect && !rotateConnection && Object.keys(method?.schema?.properties ?? {}).length > 0
  const others = connector.connect.filter((m) => m.type !== method?.type)

  if (!method) return <p className="text-sm text-muted-foreground">This service can't be added yet.</p>

  if (!rotateConnection && !owners.loading && owners.options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="connect-admins-only">
        Only admins can add credentials for your organization. Ask one to add {connector.displayName}, or to allow personal keys.
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
    <WhoCanUse value={who} onChange={setWho} disabled={busy} noun="this credential" options={owners.options.length > 0 ? owners.options : ['org']} />
  )

  const advanced = (others.length > 0 || extra || method.description || (redirect && signIn.phase !== 'idle' && !signIn.byCode)) && (
    <Disclosure title="More options" testId="connect-advanced">
      {others.length > 0 && (
        <div className="space-y-1.5">
          <Label>Another way to sign in</Label>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Another way to sign in">
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
      {extra && (!redirect || signInForm) && signIn.phase === 'idle' && <JsonSchemaForm schema={extra} value={values} onChange={setValues} errors={fieldErrors} mode="create" disabled={busy} />}
      {redirect && signIn.phase !== 'idle' && !signIn.byCode && <PasteCode embedded={embedded} code={code} onCode={setCode} onSubmit={submitCode} busy={busy} submitType={submitType} pending={complete.isPending} />}
    </Disclosure>
  )

  if (redirect) {
    return (
      <div className="space-y-4" data-testid="connect-form">
        <p className="text-sm text-muted-foreground">
          {signInForm
            ? `Enter where it is, then sign in at ${connector.displayName} and come back here.`
            : `You sign in at ${connector.displayName} and come back here. Nothing to paste.`}
        </p>
        {failureBox}
        {signIn.phase === 'idle' && (
          <>
            {signInForm && <JsonSchemaForm schema={main} value={values} onChange={setValues} errors={fieldErrors} mode="create" disabled={busy} />}
            {whoLine}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={startSignIn} disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <ExternalLink className="mr-2 h-4 w-4" aria-hidden />}
                Sign in
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
      </div>
    )
  }

  if (!isFormMethod(method.type)) return <p className="text-sm text-muted-foreground">This service can't be added yet.</p>

  return (
    <FormBox embedded={embedded} onSubmit={submitForm} className="space-y-4" testId="connect-form" label={connectTitle(connector, rotateConnection)}>
      <JsonSchemaForm schema={main} value={values} onChange={setValues} errors={fieldErrors} mode="create" disabled={busy} />
      {failureBox}
      {keyLink}
      {whoLine}
      {advanced}
      <div className="flex flex-wrap items-center gap-3">
        <Button type={submitType} onClick={embedded ? submitForm : undefined} disabled={busy}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {busy ? (shapeOnly ? 'Saving...' : 'Checking your key...') : rotateConnection ? 'Replace key' : 'Save'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        {busy && !shapeOnly && <span className="text-xs text-muted-foreground">This takes a few seconds.</span>}
      </div>
    </FormBox>
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
