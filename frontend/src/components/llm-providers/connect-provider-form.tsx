import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SecretInput } from '@/components/ui/secret-input'
import type { VisibilityValue } from '@/components/ui/visibility-field'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { ChoiceTile, ChoiceTiles } from '@/components/connect/service-tiles'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { llmProvidersApi } from '@/lib/api'
import type { Connection } from '@/types/connections'
import type { ModelCard } from '@/types/models'
import { buildProviderCreateBody, createProviderSchema, structuralFieldsFor } from './schema'
import { defaultProviderName, keyUrlFor, needsModelName, providerTileLabel, readConnectFailure, takesBaseUrl, type ConnectFailure, type ProviderTypeInfo } from './provider-catalog'
import { providerLogos } from './provider-type-config'
import { WhoCanUse } from '@/components/connect/who-can-use'

/** What POST /llm-providers/connect answers with once the key works. */
export interface ConnectResult {
  provider: { id: string; name: string; type: string; [key: string]: any }
  models: ModelCard[]
  check?: { ok: boolean; responseTime?: number }
}

type Structural = Partial<Record<'region' | 'resourceName' | 'deploymentName' | 'projectId' | 'location' | 'endpointId', string>>

/** Ollama's own hosted API. Its models are listed at /api/tags and it answers only with a key. */
export const OLLAMA_CLOUD_URL = 'https://ollama.com'
export const OLLAMA_CLOUD_KEY_URL = 'https://ollama.com/settings/keys'

/** Where an Ollama connection points: Ollama Cloud (the default) or a server you run. */
export type OllamaMode = 'cloud' | 'own'

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** What the private-host rule is for a server you run, per type. */
function privateHostHint(type: string): string {
  const flag = type === 'ollama' ? 'OLLAMA_ALLOW_PRIVATE_URLS' : 'LLM_ALLOW_PRIVATE_URLS'
  return `Private or LAN hosts (10.x, 192.168.x, .internal, localhost) need ${flag}=true on the almyty server.`
}

export interface ConnectProviderFormProps {
  type: string
  onConnected: (result: ConnectResult) => void
  /** Present = a Cancel button next to Connect (inline use, in a model chooser). */
  onCancel?: () => void
  /** Prefix for element ids, so two forms on one screen stay distinct. */
  idPrefix?: string
}

/**
 * Connect one provider: a name, its key (Ollama: an Ollama Cloud key, or
 * the URL of a server you run), only the settings that provider cannot
 * work without, and who can use it. Saving checks the key first; nothing
 * is saved when it fails, and the form stays filled so the key can be
 * fixed in place.
 */
export function ConnectProviderForm({ type, onConnected, onCancel, idPrefix = 'connect' }: ConnectProviderFormProps) {
  const [name, setName] = useState(defaultProviderName(type))
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [ollamaMode, setOllamaMode] = useState<OllamaMode>('cloud')
  const [model, setModel] = useState('')
  const [structural, setStructural] = useState<Structural>({})
  const [account, setAccount] = useState<Connection | null>(null)
  // Paste a key (the default), or pick one already in Credentials.
  const [useSaved, setUseSaved] = useState(false)
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<ConnectFailure | null>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const modelRef = useRef<HTMLInputElement>(null)

  const ollama = type === 'ollama'
  const ollamaCloud = ollama && ollamaMode === 'cloud'
  // A server URL is asked for your own server, and for Ollama run on your own machine.
  const ownServer = takesBaseUrl(type) && !ollamaCloud
  const keyOptional = ownServer
  const fields = structuralFieldsFor(type)
  const typesQuery = useQuery({
    queryKey: ['llm-provider-types'],
    queryFn: async () => {
      const rows = await llmProvidersApi.providerTypes()
      return (Array.isArray(rows) ? rows : []) as ProviderTypeInfo[]
    },
    staleTime: 10 * 60_000,
    retry: false,
  })
  // A refusal for a missing model belongs to the model field; anything
  // else to the key.
  const modelFailure = failure?.code === 'MODEL_REQUIRED' ? failure : null
  const keyFailure = modelFailure ? null : failure
  const needsModel = needsModelName(type, typesQuery.data) || !!modelFailure
  const keyUrl = failure?.keyUrl || (ollama ? (ollamaCloud ? OLLAMA_CLOUD_KEY_URL : undefined) : keyUrlFor(type))
  const id = (field: string) => `${idPrefix}-${field}`

  const connect = useMutation({
    mutationFn: (body: Record<string, any>) => llmProvidersApi.connect(body) as Promise<ConnectResult>,
    onSuccess: (result) => {
      setFailure(null)
      onConnected(result)
    },
    onError: (error) => {
      const next = readConnectFailure(error)
      setFailure(next)
      // Put the cursor where the fix goes: the model when one is missing,
      // otherwise the key, which is what almost always needs fixing.
      window.setTimeout(() => (next.code === 'MODEL_REQUIRED' ? modelRef : keyRef).current?.focus(), 0)
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const next: Record<string, string> = {}
    const url = ollamaCloud ? OLLAMA_CLOUD_URL : apiUrl.trim() || undefined
    // The same rules the backend applies, so a missing field is said here
    // rather than after a round trip.
    const parsed = createProviderSchema.safeParse({
      name: name.trim() || defaultProviderName(type),
      type,
      apiKey: account ? undefined : apiKey.trim() || undefined,
      apiUrl: url,
      credentialId: account?.id,
      model: needsModel ? model : undefined,
      ...structural,
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '')
        if (key && !next[key]) next[key] = issue.message
      }
    }
    if (!name.trim()) next.name = 'Give the connection a name'
    if (ollamaCloud && !account && !apiKey.trim() && !next.apiKey) next.apiKey = useSaved ? 'Pick a saved key' : 'Paste your Ollama Cloud API key'
    if (useSaved && !account) next.apiKey = 'Pick a saved key, or paste one instead'
    if (ollama && !ollamaCloud && !isHttpUrl(apiUrl)) next.apiUrl = 'Enter the server URL, starting with http:// or https://'
    if (needsModel && !model.trim() && !next.model) next.model = 'Enter the model you want to use'
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setFailure(null)
    const body = buildProviderCreateBody({
      name: name.trim(),
      type,
      apiKey: account ? '' : apiKey.trim(),
      apiUrl: url,
      credentialId: account?.id,
      model: needsModel ? model : undefined,
      ...structural,
      visibility: visibility.visibility,
      teamId: visibility.teamId,
    })
    connect.mutate(body)
  }

  const failureBox = (withId: boolean) =>
    keyFailure ? (
      <div id={withId ? id('failure') : undefined} role="alert" className="mt-1.5 space-y-1 text-sm text-destructive" data-testid="connect-failure">
        <p>{keyFailure.message}</p>
        {keyFailure.detail && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Details</summary>
            <span className="break-words">{keyFailure.detail}</span>
          </details>
        )}
      </div>
    ) : null

  return (
    <form onSubmit={submit} className="space-y-5" noValidate aria-label={`Connect ${providerTileLabel(type)}`}>
      <Field id={id('name')} label="Name" hint={'Shown wherever a model is picked. Name it for what it is for, e.g. "HF - Llama 70B only".'} error={errors.name}>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setErrors((prev) => ({ ...prev, name: '' }))
          }}
        />
      </Field>

      {ollama && (
        <div className="space-y-1.5">
          <Label>Where Ollama runs</Label>
          <ChoiceTiles label="Where Ollama runs">
            <ChoiceTile
              testId={id('ollama-cloud')}
              icon={providerLogos.ollama}
              label="Ollama Cloud"
              hint="ollama.com, with an API key"
              selected={ollamaMode === 'cloud'}
              onClick={() => {
                setOllamaMode('cloud')
                setErrors({})
                setFailure(null)
              }}
            />
            <ChoiceTile
              testId={id('ollama-own')}
              icon="🖥️"
              label="Your own server"
              hint="An Ollama you run, at its URL"
              selected={ollamaMode === 'own'}
              onClick={() => {
                setOllamaMode('own')
                setErrors({})
                setFailure(null)
              }}
            />
          </ChoiceTiles>
        </div>
      )}

      {ownServer && (
        <Field
          id={id('api-url')}
          label="Server URL"
          hint={`${type === 'custom' ? 'Any server that speaks the OpenAI API: vLLM, LM Studio, llama.cpp, a gateway. ' : 'The address your Ollama answers on. '}${privateHostHint(type)}`}
          error={errors.apiUrl}
        >
          <Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder={type === 'custom' ? 'https://llm.example.com/v1' : 'http://localhost:11434'} />
        </Field>
      )}

      {fields.map((field) => (
        <Field key={field.name} id={id(field.name)} label={`${field.label}${field.required ? '' : ' (optional)'}`} hint={field.hint} error={errors[field.name]}>
          <Input value={structural[field.name] ?? ''} onChange={(e) => setStructural((prev) => ({ ...prev, [field.name]: e.target.value }))} placeholder={field.placeholder} />
        </Field>
      ))}

      {needsModel && (
        <Field
          id={id('model')}
          label="Model"
          hint={`${providerTileLabel(type)} does not list its models, so name the one to use.`}
          error={errors.model || modelFailure?.message}
        >
          <Input
            ref={modelRef}
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              setErrors((prev) => ({ ...prev, model: '' }))
            }}
            placeholder={type === 'vertex_ai' ? 'google/gemini-3.5-flash' : 'The model id, as the provider names it'}
          />
        </Field>
      )}

      {useSaved ? (
        <div className="space-y-1.5">
          <CredentialPicker
            id={id('saved-key')}
            label="Saved key"
            value={account?.id ?? ''}
            onChange={(credential) => {
              setAccount(credential)
              setFailure(null)
              setErrors((prev) => ({ ...prev, apiKey: '' }))
            }}
            kind="inference"
            connectorKey={type}
            placeholder="Pick a saved key"
            error={errors.apiKey}
            hint="A key already in Credentials, or one you add here. It stays in Credentials under its own name."
          />
          {failureBox(false)}
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setUseSaved(false)
              setAccount(null)
            }}
          >
            Paste a key instead
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <Field
            id={id('api-key')}
            label={type === 'vertex_ai' ? 'Service account key (JSON)' : ollamaCloud ? 'Ollama Cloud API key' : keyOptional ? 'API key (optional)' : 'API key'}
            error={errors.apiKey}
          >
            <SecretInput
              ref={keyRef}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setErrors((prev) => ({ ...prev, apiKey: '' }))
              }}
              placeholder={keyOptional ? 'Only if your server asks for one' : 'Paste your key'}
            />
          </Field>
          {failureBox(true)}
          {keyUrl && (
            <a href={keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Get a key
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
          {!ownServer && (
            <button
              type="button"
              className="block text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setUseSaved(true)
                setApiKey('')
                setFailure(null)
              }}
            >
              Use a saved key instead
            </button>
          )}
        </div>
      )}

      <WhoCanUse value={visibility} onChange={setVisibility} disabled={connect.isPending} noun="this connection and its models" />

      {onCancel ? (
        <InlineFormActions onCancel={onCancel} submitLabel={connect.isPending ? 'Checking your key...' : 'Connect'} submitting={connect.isPending} />
      ) : (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={connect.isPending}>
            {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {connect.isPending ? 'Checking your key...' : 'Connect'}
          </Button>
        </div>
      )}
      {connect.isPending && <p className="text-xs text-muted-foreground">This takes a few seconds.</p>}
    </form>
  )
}
