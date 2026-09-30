import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { ArrowLeft, ExternalLink, Loader2, Pencil, Play, RefreshCw } from 'lucide-react'
import { Disclosure } from '@/components/ui/disclosure'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QueryError } from '@/components/ui/query-error'
import { SecretInput } from '@/components/ui/secret-input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { useConfirm } from '@/components/ui/confirm-dialog'
import type { Visibility, VisibilityValue } from '@/components/ui/visibility-field'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { FormSection } from '@/components/layout/form-page'
import { ServiceIcon } from '@/components/connect/service-tiles'
import { AllowedModelsEditor } from '@/components/llm-providers/allowed-models-editor'
import { accessSummary, modelAccessOf } from '@/lib/model-access'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { ModelPicker } from '@/components/model-picker'
import { EditModelForm } from '@/components/models/edit-model-form'
import { HostingPanel } from '@/components/models/hosting/hosting-panel'
import { StartModelForm } from '@/components/models/hosting/start-model-form'
import { useHostingActions } from '@/components/models/use-model-data'
import { CredentialSlot, CredentialRefSummary, isMaskedKey } from '@/components/llm-providers/credential-slot'
import { ProviderStatus, canTurnBackOn, inactiveReason, providerCheck } from '@/components/llm-providers/provider-status'
import { HOSTING_ADAPTER_FOR_TYPE, keyUrlFor, providerTileLabel, takesBaseUrl } from '@/components/llm-providers/provider-catalog'
import { providerLogos, providerUsageApiSupport, usageApiSupported } from '@/components/llm-providers/provider-type-config'
import { BASE_URL_PRIVATE_HOST_HINT, buildProviderUpdateBody } from '@/components/llm-providers/schema'
import { WhoCanUse } from '@/components/connect/who-can-use'
import { llmProvidersApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { modelAdaptersApi, modelDeploymentsApi, readAdapterRefusal } from '@/lib/deployments-api'
import { modelsApi } from '@/lib/models-api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { AdapterRefusal, CreateModelDeploymentBody, ModelAdapter, ModelDeployment } from '@/types/deployments'
import type { ModelCard, UpdateModelBody } from '@/types/models'
import { cn, formatDateTime, pluralized } from '@/lib/utils'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

type CheckOutcome = { ok: true; models: number; reactivated?: boolean } | { ok: false; message: string }

/**
 * One provider connection: its name (renameable), whether its key works,
 * which of its models it offers, and its settings. The Models tab ticks
 * and unticks models and holds the "allow new models automatically"
 * switch; Settings holds the key, who can use it, the default model and
 * everything under Advanced. A cloud account adds a tab for the open
 * models almyty runs on it.
 */
export function ProviderPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id

  const providerQuery = useQuery<any>({ queryKey: ['llm-provider', id], queryFn: () => llmProvidersApi.getById(id), enabled: !!id })
  const modelsQuery = useQuery({
    queryKey: ['models', 'by-provider', id],
    queryFn: async () => {
      const rows = await modelsApi.list({ providerId: id })
      return Array.isArray(rows) ? rows : []
    },
    enabled: !!id,
  })
  const provider = providerQuery.data
  const models: ModelCard[] = useMemo(
    () => [...(modelsQuery.data ?? [])].sort((a, b) => Number(b.selectable) - Number(a.selectable) || a.name.localeCompare(b.name)),
    [modelsQuery.data],
  )
  const hostingAdapter = provider ? HOSTING_ADAPTER_FOR_TYPE[provider.type as keyof typeof HOSTING_ADAPTER_FOR_TYPE] : undefined
  const tabs = ['models', 'settings', ...(hostingAdapter ? ['hosting'] : [])]
  const tab = tabs.includes(searchParams.get('tab') ?? '') ? (searchParams.get('tab') as string) : 'models'
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'models') params.delete('tab')
    else params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  useEffect(() => {
    document.title = provider?.name ? `${provider.name} | Credentials | almyty` : 'Connection | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [provider?.name])

  // /models links a model here as #model-<id>.
  useEffect(() => {
    if (!location.hash || models.length === 0) return
    document.getElementById(location.hash.slice(1))?.scrollIntoView?.({ block: 'center' })
  }, [location.hash, models.length])

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['llm-provider', id] })
    queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
    queryClient.invalidateQueries({ queryKey: ['credentials'] })
  }

  const update = useMutation({
    mutationFn: (body: Record<string, any>) => llmProvidersApi.update(id, body),
    onSuccess: () => refresh(),
    onError: (error) => notifications.error('Could not save', getApiErrorMessage(error, 'The change was not saved.')),
  })

  // Check again: the key, then the model list, then everything that shows them.
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null)
  const check = useMutation({
    mutationFn: async (): Promise<CheckOutcome> => {
      const result: any = await llmProvidersApi.test(id)
      if (!result?.isHealthy) return { ok: false, message: result?.error || 'The provider did not accept the key.' }
      await modelsApi.sync(id)
      const rows = await modelsApi.list({ providerId: id })
      return { ok: true, models: Array.isArray(rows) ? rows.length : 0, reactivated: result?.reactivated === true }
    },
    onSuccess: (next) => {
      setOutcome(next)
      refresh()
    },
    onError: (error) => {
      setOutcome({ ok: false, message: getApiErrorMessage(error, 'The check did not finish.') })
      refresh()
    },
  })

  const remove = useMutation({
    mutationFn: () => llmProvidersApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
      notifications.success('Connection removed', `${provider?.name ?? 'The connection'} and its models are gone.`)
      navigate('/credentials')
    },
    onError: (error) => notifications.error('Could not remove the connection', getApiErrorMessage(error, 'It was not removed.')),
  })

  const back = (
    <Link to="/credentials" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Credentials
    </Link>
  )

  if (providerQuery.isError) {
    return (
      <div className="space-y-4">
        {back}
        <QueryError error={providerQuery.error} onRetry={() => providerQuery.refetch()} title="Couldn't load this connection" />
      </div>
    )
  }
  if (providerQuery.isLoading) {
    return (
      <div className="flex h-96 items-center justify-center" aria-busy="true">
        <LoadingSpinner size="lg" />
      </div>
    )
  }
  if (!provider) {
    return (
      <div className="space-y-4">
        {back}
        <p className="text-muted-foreground">Connection not found.</p>
      </div>
    )
  }

  const status = providerCheck(provider)
  // Off until a check passes: the page says why and how to turn it back on.
  const inactive = provider.status === 'inactive'
  const visibility: VisibilityValue = { visibility: (provider.visibility as Visibility) ?? 'org', teamId: provider.teamId ?? null }
  const listedIds = models.filter((m) => m.status !== 'inactive').map((m) => m.vendorModelId)
  const summary = accessSummary(modelAccessOf(provider), listedIds, (vid) => models.find((m) => m.vendorModelId === vid)?.name ?? vid)

  const askRemove = async () => {
    // Name the agents that lose their model before asking, so nobody removes one blind.
    let using: { agents: Array<{ id: string; name: string }>; others: number } = { agents: [], others: 0 }
    try {
      using = await llmProvidersApi.agents(id)
    } catch {
      // The question still stands without the list; the notices name them afterwards.
    }
    const ok = await confirm({
      title: `Remove ${provider.name}?`,
      description: removeDescription(using.agents.map((a) => a.name), using.others),
      confirmLabel: 'Remove connection',
      destructive: true,
    })
    if (ok) remove.mutate()
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {back}

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <ServiceIcon size="lg">{providerLogos[provider.type] || '⚙️'}</ServiceIcon>
          <div className="min-w-0 space-y-1">
            <EditableName name={provider.name} saving={update.isPending} onSave={(name) => update.mutate({ name })} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{providerTileLabel(provider.type)}</span>
              <ProviderStatus check={status} />
              <span data-testid="connection-model-summary">{summary}</span>
            </div>
          </div>
        </div>
        {!inactive && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending} className="gap-2">
              <RefreshCw className={cn('h-4 w-4', check.isPending && 'animate-spin')} aria-hidden />
              {check.isPending ? 'Checking...' : 'Check again'}
            </Button>
          </div>
        )}
      </header>

      {inactive && (
        <section
          aria-labelledby="provider-inactive-title"
          data-testid="provider-inactive"
          className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4"
        >
          <div className="space-y-1">
            <h2 id="provider-inactive-title" className="text-sm font-semibold">
              This connection is inactive
            </h2>
            <p className="break-words text-sm text-muted-foreground" data-testid="provider-inactive-reason">
              {inactiveReason(provider, formatDateTime)} While it is off, its models are not offered anywhere.
            </p>
          </div>
          <ReplaceKey provider={provider} idPrefix="inactive-replace-key" onSaved={() => check.mutate()} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending} className="gap-2">
              <RefreshCw className={cn('h-4 w-4', check.isPending && 'animate-spin')} aria-hidden />
              {check.isPending ? 'Checking...' : 'Check again'}
            </Button>
            {canTurnBackOn(provider) && (
              <Button variant="outline" onClick={() => update.mutate({ status: 'active' })} disabled={update.isPending}>
                Turn it back on
              </Button>
            )}
          </div>
        </section>
      )}

      {status.error && !outcome && !inactive && (
        <p className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" data-testid="provider-last-error">
          {status.error}
        </p>
      )}
      {outcome && (
        <p
          role="status"
          data-testid="provider-check-result"
          className={cn(
            'break-words rounded-md border p-3 text-sm',
            outcome.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200' : 'border-destructive/30 bg-destructive/5 text-destructive',
          )}
        >
          {outcome.ok ? `Key works.${outcome.reactivated ? ' The connection is active again.' : ''} ${pluralized(outcome.models, 'model')}.` : outcome.message}
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          {hostingAdapter && <TabsTrigger value="hosting">Open models on this account</TabsTrigger>}
        </TabsList>

        <TabsContent value="models" className="space-y-3 pt-2">
          {modelsQuery.isError ? (
            <QueryError error={modelsQuery.error} onRetry={() => modelsQuery.refetch()} title="Couldn't load its models" />
          ) : modelsQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : models.length === 0 ? (
            <EmptyState
              title="No models yet"
              description={takesBaseUrl(provider.type) ? 'Your server lists no models yet. Check again once it is up.' : 'The provider listed no models. Check again to fetch them.'}
              // An inactive connection's one Check again is in the red box above.
              action={
                inactive ? undefined : (
                  <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
                    Check again
                  </Button>
                )
              }
            />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Ticked models are offered in every model chooser and to the router. Untick the ones this connection should not be used for.
              </p>
              <AllowedModelsEditor key={`${provider.updatedAt}-${models.length}`} provider={provider} cards={models} onSaved={() => {
                refresh()
                notifications.success('Saved', 'The models this connection offers are updated.')
              }} />
            </>
          )}
        </TabsContent>

        <TabsContent value="settings" className="space-y-6 pt-2">
          <FormSection title="Key and access">
            <ReplaceKey provider={provider} onSaved={() => check.mutate()} />
            <WhoCanUse value={visibility} onChange={(next) => update.mutate({ visibility: next.visibility, teamId: next.teamId })} disabled={update.isPending} noun="this connection and its models" />
            <div className="max-w-md">
              <ModelPicker
                idPrefix="provider-default"
                providerLocked
                modelOptional
                modelLabel="Default model"
                value={{ providerId: provider.id, model: provider.configuration?.model || '' }}
                onChange={(next) => update.mutate({ configuration: { model: next.model ?? '' } })}
              />
              <p className="mt-1 text-xs text-muted-foreground">Used when an agent picks this connection without naming a model.</p>
            </div>
          </FormSection>

          <Advanced provider={provider} models={models} onSaved={refresh} />

          <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 p-4">
            <div>
              <h2 className="text-sm font-semibold">Remove this connection</h2>
              <p className="text-sm text-muted-foreground">Its key goes too. Agents that use its models stop working until you pick another model.</p>
            </div>
            <Button variant="outline" className="text-destructive hover:text-destructive" disabled={remove.isPending} onClick={askRemove}>
              Remove connection
            </Button>
          </section>
        </TabsContent>

        {hostingAdapter && orgId && (
          <TabsContent value="hosting" className="pt-2">
            <Hosting provider={provider} orgId={orgId} />
          </TabsContent>
        )}
      </Tabs>
      {confirmDialog}
    </div>
  )
}

function EditableName({ name, saving, onSave }: { name: string; saving: boolean; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <h1 className={cn(DETAIL_TITLE_CLASSES, 'truncate')}>{name}</h1>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Rename"
          onClick={() => {
            setDraft(name)
            setEditing(true)
          }}
        >
          <Pencil className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    )
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (draft.trim() && draft.trim() !== name) onSave(draft.trim())
        setEditing(false)
      }}
    >
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Name" className="h-9 w-64" autoFocus />
      <Button type="submit" size="sm" disabled={saving || !draft.trim()}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  )
}

/** "Replace key": paste a new one, or switch to a connected account. Saving checks it again. */
function ReplaceKey({ provider, onSaved, idPrefix = 'replace-key' }: { provider: any; onSaved: () => void; idPrefix?: string }) {
  const notifications = useNotifications()
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const ownServer = takesBaseUrl(provider.type)
  const keyUrl = keyUrlFor(provider.type)
  const save = useMutation({
    mutationFn: (body: Record<string, any>) => llmProvidersApi.update(provider.id, body),
    onSuccess: () => {
      setOpen(false)
      setKey('')
      onSaved()
    },
    onError: (error) => notifications.error('Could not replace the key', getApiErrorMessage(error, 'The key was not saved.')),
  })

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-muted-foreground">{ownServer ? 'Key (optional):' : 'Key:'}</span>
        <CredentialRefSummary credentialRef={provider.credentialRef} hasStoredKey={isMaskedKey(provider.configuration?.apiKey)} className="border-0 p-0" />
        {!open && (
          <button type="button" className="text-primary hover:underline" onClick={() => setOpen(true)}>
            Replace key
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-3 rounded-lg border p-3">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (key.trim()) save.mutate({ credentialId: null, configuration: { apiKey: key.trim() } })
            }}
          >
            <div className="min-w-[16rem] flex-1">
              <Label htmlFor={idPrefix}>New key</Label>
              <SecretInput id={idPrefix} className="mt-1" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the new key" />
            </div>
            <Button type="submit" disabled={save.isPending || !key.trim()}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Save and check
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            {keyUrl && (
              <a href={keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                Get a key
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            )}
          </div>
          <CredentialPicker
            id={`${idPrefix}-saved`}
            label="Or use a saved key"
            value={provider.credentialRef?.id ?? ''}
            onChange={(credential) => {
              if (credential && credential.id !== provider.credentialRef?.id) save.mutate({ credentialId: credential.id })
            }}
            kind="inference"
            connectorKey={provider.type}
            placeholder="Pick a saved key"
            hint="Saving it checks the key again."
          />
        </div>
      )}
    </div>
  )
}

/**
 * Open models almyty runs on this provider's cloud account: the running
 * ones with their state and controls, and "Start a model", which asks only
 * which model.
 */
function Hosting({ provider, orgId }: { provider: any; orgId: string }) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const adapterKey = HOSTING_ADAPTER_FOR_TYPE[provider.type as keyof typeof HOSTING_ADAPTER_FOR_TYPE]
  const [starting, setStarting] = useState(false)
  const [refusal, setRefusal] = useState<AdapterRefusal | null>(null)
  const actions = useHostingActions(orgId)

  const adaptersQuery = useQuery<ModelAdapter[]>({
    queryKey: ['model-adapters', orgId],
    queryFn: async () => {
      const d = await modelAdaptersApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!adapterKey,
    staleTime: 5 * 60_000,
  })
  const deploymentsQuery = useQuery<ModelDeployment[]>({
    queryKey: ['model-deployments', orgId],
    queryFn: async () => {
      const d = await modelDeploymentsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!adapterKey,
  })
  const adapters = adaptersQuery.data ?? []
  const adapter = adapters.find((a) => a.key === adapterKey)
  const running = (deploymentsQuery.data ?? []).filter((d) => d.providerType === adapterKey && d.state !== 'torn_down')

  const start = useMutation({
    mutationFn: (body: CreateModelDeploymentBody) => modelDeploymentsApi.create(body),
    onSuccess: () => {
      setStarting(false)
      setRefusal(null)
      queryClient.invalidateQueries({ queryKey: ['model-deployments', orgId] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      notifications.success('Starting', 'It shows up as a model once your cloud reports it running.')
    },
    onError: (error) => {
      const refused = readAdapterRefusal(error)
      if (refused) setRefusal(refused)
      else notifications.error('Could not start it', getApiErrorMessage(error, 'Your cloud did not accept the request.'))
    },
  })

  if (!adapter) {
    return adaptersQuery.isLoading ? <Skeleton className="h-24 w-full" /> : <p className="text-sm text-muted-foreground">This almyty server cannot start open models on this kind of account.</p>
  }

  return (
    <section aria-labelledby="provider-hosting-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="provider-hosting-heading" className="text-lg font-semibold">
          Open models on this account
        </h2>
        {!starting && (
          <Button variant="outline" className="gap-2" onClick={() => setStarting(true)}>
            <Play className="h-4 w-4" aria-hidden />
            Start a model
          </Button>
        )}
      </div>
      {starting && (
        <Card>
          <CardContent className="pt-6">
            <StartModelForm
              adapter={adapter}
              credentialId={provider.credentialRef?.id}
              onSubmit={(body) => start.mutate(body)}
              onCancel={() => {
                setStarting(false)
                setRefusal(null)
              }}
              submitting={start.isPending}
              refusal={refusal}
            />
          </CardContent>
        </Card>
      )}
      {running.length === 0 && !starting ? (
        <p className="text-sm text-muted-foreground">Nothing running here. Start an open model and it appears as a model once it is up.</p>
      ) : (
        running.map((d) => (
          <Card key={d.id}>
            <CardContent className="pt-6">
              <HostingPanel deployment={d} adapters={adapters} onScale={actions.onScale} onTeardown={actions.onTeardown} busy={actions.busy} />
            </CardContent>
          </Card>
        ))
      )}
    </section>
  )
}

/**
 * The line under "Remove X?": which agents lose their model. Names the ones
 * the viewer can see, counts the rest.
 */
export function removeDescription(names: string[], others: number): string {
  const base = 'Its key and its models go with it.'
  const total = names.length + others
  if (total === 0) return `${base} No agent uses its models.`
  const parts = [...names.map((n) => `"${n}"`), ...(others > 0 ? [pluralized(others, 'other agent')] : [])]
  const who = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
  const one = total === 1
  return `${base} ${who} ${one ? 'uses' : 'use'} its models and ${one ? 'stops' : 'stop'} working until given another model; their owners are told.`
}

/** Everything a first connection does not need: call settings, the usage key, and per-model settings. */
function Advanced({ provider, models, onSaved }: { provider: any; models: ModelCard[]; onSaved: () => void }) {
  const notifications = useNotifications()
  const [modelId, setModelId] = useState('')
  const picked = models.find((m) => m.id === modelId) ?? null

  const form = useForm<any>({
    defaultValues: {
      maxTokens: provider.configuration?.maxTokens ?? '',
      temperature: provider.configuration?.temperature ?? '',
      apiUrl: provider.configuration?.apiUrl ?? '',
      usageApiKey: '',
      usageCredentialId: undefined,
    },
  })

  const saveSettings = useMutation({
    mutationFn: (data: any) => {
      const num = (v: unknown) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v))
      return llmProvidersApi.update(
        provider.id,
        buildProviderUpdateBody({
          name: provider.name,
          maxTokens: num(data.maxTokens),
          temperature: num(data.temperature),
          apiUrl: data.apiUrl,
          usageApiKey: data.usageApiKey,
          usageCredentialId: data.usageCredentialId,
        }),
      )
    },
    onSuccess: (_result, data) => {
      // Saved is clean again, so leaving no longer asks.
      form.reset({ ...data, usageApiKey: '', usageCredentialId: undefined })
      notifications.success('Saved', 'Provider settings saved.')
      onSaved()
    },
    onError: (error) => notifications.error('Could not save', getApiErrorMessage(error, 'The settings were not saved.')),
  })

  // Unsaved settings ask before a navigation throws them away.
  const guard = useLeaveGuard(form.formState.isDirty && !saveSettings.isPending)

  const saveModel = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateModelBody }) => modelsApi.update(id, body),
    onSuccess: () => {
      notifications.success('Saved', 'Model settings saved.')
      onSaved()
    },
    onError: (error) => notifications.error('Could not save', getApiErrorMessage(error, 'The model settings were not saved.')),
  })

  return (
    <Disclosure title="Advanced">
      <form className="space-y-4" onSubmit={form.handleSubmit((data) => saveSettings.mutate(data))} aria-label="Provider settings">
        <h3 className="text-sm font-semibold">Call settings</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="adv-temperature">Temperature</Label>
            <Input id="adv-temperature" className="mt-1" type="number" step="0.1" min="0" max="2" placeholder="Provider default" {...form.register('temperature')} />
          </div>
          <div>
            <Label htmlFor="adv-max-tokens">Max tokens</Label>
            <Input id="adv-max-tokens" className="mt-1" type="number" min="1" placeholder="Provider default" {...form.register('maxTokens')} />
          </div>
          {takesBaseUrl(provider.type) && (
            <div className="sm:col-span-2">
              <Label htmlFor="adv-api-url">Server URL</Label>
              <Input id="adv-api-url" className="mt-1" placeholder={provider.type === 'custom' ? 'https://llm.example.com/v1' : 'http://localhost:11434'} {...form.register('apiUrl')} />
              <p className="mt-1 text-xs text-muted-foreground">{BASE_URL_PRIVATE_HOST_HINT}</p>
            </div>
          )}
        </div>
        {usageApiSupported(provider.type) && (
          <CredentialSlot
            label="Usage key"
            credentialRef={provider.usageCredentialRef}
            hasStoredKey={isMaskedKey(provider.configuration?.usageApiKey)}
            connectorKey={provider.type}
            form={form}
            idField="usageCredentialId"
            keyField="usageApiKey"
            keyInputId="adv-usage-key"
            keyLabel="Admin key, to read your usage and cost reports"
            keyPlaceholder="Leave empty to keep the current one"
            keyHelp={
              <a href={providerUsageApiSupport[provider.type]?.docsUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                About admin keys
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            }
          />
        )}
        <Button type="submit" size="sm" disabled={saveSettings.isPending}>
          {saveSettings.isPending ? 'Saving...' : 'Save settings'}
        </Button>
      </form>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Per-model settings</h3>
        <p className="text-xs text-muted-foreground">Your own price, context length, privacy, region and capabilities for one model.</p>
        {models.length === 0 ? (
          <p className="text-sm text-muted-foreground">No models yet.</p>
        ) : (
          <select
            aria-label="Model to change"
            className="flex h-9 w-full max-w-md rounded-lg border border-input bg-background px-3 text-sm"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            <option value="">Choose a model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        {picked && <EditModelForm key={picked.id} card={picked} onSubmit={(cardId, body) => saveModel.mutateAsync({ id: cardId, body }).catch(() => undefined)} submitting={saveModel.isPending} />}
      </div>
      {guard.element}
    </Disclosure>
  )
}
