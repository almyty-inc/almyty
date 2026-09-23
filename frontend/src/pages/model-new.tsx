import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, Cloud, KeyRound, Server } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { AddInferenceProviderForm } from '@/components/llm-providers/add-inference-provider-form'
import { ProviderModelForm, isHostedModelPlumbing, type ProviderOption } from '@/components/models/provider-model-form'
import { ServerModelForm, buildServerRequests, type ServerModelValues } from '@/components/models/server-model-form'
import { HostModelForm } from '@/components/models/hosting/host-model-form'
import { llmProvidersApi } from '@/lib/api'
import { llmProvidersQuery } from '@/lib/llm-providers-query'
import { getApiErrorMessage as errorMessage } from '@/lib/api-error'
import { modelAdaptersApi, modelDeploymentsApi, readAdapterRefusal } from '@/lib/deployments-api'
import { modelsApi } from '@/lib/models-api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { AdapterRefusal, CreateModelDeploymentBody, ModelAdapter } from '@/types/deployments'
import type { RegisterModelBody } from '@/types/models'

export type AddModelPath = 'provider' | 'server' | 'cloud'
const PATH_KEYS: AddModelPath[] = ['provider', 'server', 'cloud']

const PATHS: Array<{ key: AddModelPath; title: string; body: string; icon: typeof KeyRound }> = [
  {
    key: 'provider',
    title: "A provider's API",
    body: 'OpenAI, Anthropic, Groq, Mistral and 35 more. Use an inference provider you set up, or set one up here.',
    icon: KeyRound,
  },
  {
    key: 'server',
    title: 'A server you run',
    body: 'Any OpenAI-compatible URL: vLLM, Ollama, TGI, llama.cpp, LiteLLM.',
    icon: Server,
  },
  {
    key: 'cloud',
    title: 'Your cloud account',
    body: 'almyty starts the model on your Hugging Face, AWS, Google Cloud, Modal or other account, and stops it when you say. Your cloud bills you by the hour.',
    icon: Cloud,
  },
]

const HEADINGS: Record<AddModelPath | 'choose', { title: string; description: string }> = {
  choose: { title: 'Add model', description: 'Where does it run?' },
  provider: { title: "Add a model from a provider's API", description: 'Pick the inference provider and the model. It becomes usable after a validation run passes.' },
  server: { title: 'Connect a server you run', description: 'Any OpenAI-compatible server. It becomes usable after a validation run passes.' },
  cloud: { title: 'Host a model on your cloud', description: 'Say which model and which cloud. almyty starts it in your account and shows its state and cost on the model.' },
}

function errorCode(error: unknown): string | undefined {
  const body = (error as { response?: { data?: any } })?.response?.data
  return body?.error?.code ?? body?.code
}

/**
 * The one way to add a model, on a page of its own. The first step asks
 * where the model runs; each answer is its own URL (?via=), so Back goes
 * back a step and a link can open straight onto it. Setting up an
 * inference provider happens inline here, never in a dialog.
 */
export function ModelNewPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('via')
  const path: AddModelPath | null = PATH_KEYS.includes(requested as AddModelPath) ? (requested as AddModelPath) : null
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notify = useNotifications()
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id
  const [settingUpProvider, setSettingUpProvider] = useState(false)
  const [newProviderId, setNewProviderId] = useState<string | undefined>()
  const [refusal, setRefusal] = useState<AdapterRefusal | null>(null)

  useEffect(() => {
    document.title = 'Add model | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const choose = (next: AddModelPath) => {
    const params = new URLSearchParams(searchParams)
    params.set('via', next)
    setSearchParams(params)
  }

  const providersQuery = useQuery(llmProvidersQuery)
  // A model hosted on your cloud gets a provider row written for it by
  // the reconcile loop (metadata.managedBy.kind model_endpoint). It is that
  // model's plumbing, not an API to add other models from.
  const providers: ProviderOption[] = (providersQuery.data || [])
    .filter((p: any) => !isHostedModelPlumbing(p))
    .map((p: any) => ({ id: p.id, name: p.name, type: p.type }))

  const adaptersQuery = useQuery<ModelAdapter[]>({
    queryKey: ['model-adapters', orgId],
    queryFn: async () => {
      const d = await modelAdaptersApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: path === 'cloud' && !!orgId,
    staleTime: 5 * 60_000,
  })

  const openModel = (id: string | null | undefined) => {
    queryClient.invalidateQueries({ queryKey: ['models'] })
    navigate(id ? `/models/${id}` : '/models')
  }

  const registerModel = useMutation({
    mutationFn: (body: RegisterModelBody) => modelsApi.register(body),
    onSuccess: (card) => {
      notify.success('Model added', `${card?.name || 'The model'} is in the list. Validate it to make it usable.`)
      openModel(card?.id)
    },
    onError: (error: any) => notify.error('Could not add the model', errorMessage(error, 'The model was not saved')),
  })

  const connectServer = useMutation({
    mutationFn: async (values: ServerModelValues) => {
      const { provider, model } = buildServerRequests(values)
      const created: any = await llmProvidersApi.create(provider)
      if (!created?.id) throw new Error('The server was not saved')
      try {
        return await modelsApi.register({ ...model, providerId: created.id })
      } catch (error) {
        // Saving the provider imports what the server lists, so the model
        // may already be there by the time this call lands.
        if (errorCode(error) === 'MODEL_EXISTS') return { id: null, name: values.name }
        throw error
      }
    },
    onSuccess: (card: any) => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      notify.success('Server connected', `${card?.name || 'The model'} is in the list. Validate it to make it usable.`)
      openModel(card?.id)
    },
    onError: (error: any) => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      notify.error('Could not connect the server', errorMessage(error, 'The server was not saved'))
    },
  })

  const hostModel = useMutation({
    mutationFn: (body: CreateModelDeploymentBody) => modelDeploymentsApi.create(body),
    onMutate: () => setRefusal(null),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['model-deployments'] })
      notify.success('Starting your model', 'It is in the list now and starts on your cloud within a few minutes.')
      // The server creates the model with the request and links it.
      openModel(created?.modelId)
    },
    onError: (error) => {
      // A refusal names what the cloud does accept; keep it on the form.
      setRefusal(readAdapterRefusal(error))
      notify.error('Could not host the model', errorMessage(error, 'The server rejected the request.'))
    },
  })

  const heading = HEADINGS[path ?? 'choose']
  const backToChoice = (
    <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => navigate('/models/new')}>
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Back
    </Button>
  )
  const cancel = () => navigate('/models')

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link to={path ? '/models/new' : '/models'} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {path ? 'Where does it run?' : 'Models'}
        </Link>
        <h1 className={cn("mt-1", DETAIL_TITLE_CLASSES)}>{heading.title}</h1>
        <p className="text-muted-foreground">{heading.description}</p>
      </div>

      {path === null && (
        <ul className="space-y-2" aria-label="Where does it run?">
          {PATHS.map(({ key, title, body, icon: Icon }) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => choose(key)}
                className="flex w-full items-start gap-3 rounded-lg border bg-card p-4 text-left transition-colors hover:border-violet-500/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-600 dark:text-violet-400">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{title}</span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">{body}</span>
                </span>
                <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {path === 'provider' && (
        <>
          {settingUpProvider && (
            <section aria-labelledby="setup-provider-heading" className="space-y-3">
              <h2 id="setup-provider-heading" className="text-lg font-semibold">Set up an inference provider</h2>
              <Card>
                <CardContent className="pt-6">
                  <AddInferenceProviderForm
                    onCreated={(p) => {
                      setNewProviderId(p.id)
                      setSettingUpProvider(false)
                    }}
                    onCancel={() => setSettingUpProvider(false)}
                  />
                </CardContent>
              </Card>
            </section>
          )}
          {!settingUpProvider && (
            <Card>
              <CardContent className="pt-6">
                <ProviderModelForm
                  providers={providers}
                  providersLoading={providersQuery.isLoading}
                  selectedProviderId={newProviderId}
                  onSetUpProvider={() => setSettingUpProvider(true)}
                  onSubmit={(b) => registerModel.mutateAsync(b).catch(() => undefined)}
                  onCancel={cancel}
                  submitting={registerModel.isPending}
                  footerStart={backToChoice}
                />
              </CardContent>
            </Card>
          )}
        </>
      )}

      {path === 'server' && (
        <Card>
          <CardContent className="pt-6">
            <ServerModelForm onSubmit={(v) => connectServer.mutateAsync(v).catch(() => undefined)} onCancel={cancel} submitting={connectServer.isPending} footerStart={backToChoice} />
          </CardContent>
        </Card>
      )}

      {path === 'cloud' && (
        <Card>
          <CardContent className="pt-6">
            {adaptersQuery.isLoading ? (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : (
              <HostModelForm
                adapters={adaptersQuery.data ?? []}
                onSubmit={(b) => hostModel.mutate(b)}
                onCancel={cancel}
                submitting={hostModel.isPending}
                refusal={refusal}
                footerStart={backToChoice}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
