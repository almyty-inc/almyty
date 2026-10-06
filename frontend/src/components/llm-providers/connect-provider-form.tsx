import { useRef, useState, type SyntheticEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { VisibilityValue } from '@/components/ui/visibility-field'
import { Field } from '@/components/layout/form-page'
import { FormBox } from '@/components/connections/connect-flow'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { WhoCanUse } from '@/components/connect/who-can-use'
import { llmProvidersApi } from '@/lib/api'
import type { Connection } from '@/types/connections'
import type { ModelCard } from '@/types/models'
import { buildProviderCreateBody, createProviderSchema, structuralFieldsFor } from './schema'
import { keyUrlFor, needsModelName, providerTileLabel, readConnectFailure, takesBaseUrl, type ConnectFailure, type ProviderTypeInfo } from './provider-catalog'

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


export interface ConnectProviderFormProps {
  type: string
  /** The connection's name, from the add-credential form's Name field. */
  name: string
  /** Called instead of saving when the name is empty. */
  onNameMissing?: () => void
  onConnected: (result: ConnectResult) => void
  /** Present = a Cancel button next to Save (inline use). */
  onCancel?: () => void
  /** Prefix for element ids, so two forms on one screen stay distinct. */
  idPrefix?: string
  /** Inside another form: no <form> of its own. */
  embedded?: boolean
}

/**
 * The fields of one model provider's connection: its key (Ollama: an
 * Ollama Cloud key, or the URL of a server you run), only the settings
 * that provider cannot work without, and who can use it. Saving checks
 * the key first; nothing is saved when it fails, and the form stays filled
 * so the key can be fixed in place. Which models it offers is chosen on
 * the connection's page afterwards (all of them, until then).
 */
export function ConnectProviderForm({ type, name, onNameMissing, onConnected, onCancel, idPrefix = 'connect', embedded = false }: ConnectProviderFormProps) {
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

  const submit = (e: SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const next: Record<string, string> = {}
    const url = ollamaCloud ? OLLAMA_CLOUD_URL : apiUrl.trim() || undefined
    const trimmedName = name.trim()
    // The same rules the backend applies, so a missing field is said here
    // rather than after a round trip.
    const parsed = createProviderSchema.safeParse({
      name: trimmedName || providerTileLabel(type),
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
        if (key && key !== 'name' && !next[key]) next[key] = issue.message
      }
    }
    if (ollamaCloud && !account && !apiKey.trim() && !next.apiKey) next.apiKey = useSaved ? 'Pick a saved key' : 'Paste your Ollama Cloud API key'
    if (useSaved && !account) next.apiKey = 'Pick a saved key, or paste one instead'
    if (ollama && !ollamaCloud && !isHttpUrl(apiUrl)) next.apiUrl = 'Enter the server URL, starting with http:// or https://'
    if (needsModel && !model.trim() && !next.model) next.model = 'Enter the model you want to use'
    setErrors(next)
    if (!trimmedName) onNameMissing?.()
    if (Object.keys(next).length > 0 || !trimmedName) return
    setFailure(null)
    const body = buildProviderCreateBody({
      name: trimmedName,
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

  const submitType = embedded ? 'button' : 'submit'
  return (
    <FormBox embedded={embedded} onSubmit={submit} className="space-y-5" label={`Connect ${providerTileLabel(type)}`} testId="connect-provider-form">
      {ollama && (
        <Field id={id('ollama-where')} label="Where Ollama runs">
          <Select
            value={ollamaMode}
            onValueChange={(v) => {
              setOllamaMode(v as OllamaMode)
              setErrors({})
              setFailure(null)
            }}
          >
            <SelectTrigger id={id('ollama-where')} aria-label="Where Ollama runs" data-testid={id('ollama-where')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cloud">Ollama Cloud (ollama.com, with an API key)</SelectItem>
              <SelectItem value="own">Your own server (an Ollama you run, at its URL)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}

      {ownServer && (
        <Field
          id={id('api-url')}
          label="Server URL"
          hint="The address of your model server, reachable from almyty."
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
            allowCreate={false}
            placeholder="Pick a saved key"
            error={errors.apiKey}
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {keyUrl && (
              <a href={keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                Get a key
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            )}
            {!ownServer && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
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
        </div>
      )}

      <WhoCanUse value={visibility} onChange={setVisibility} disabled={connect.isPending} noun="this connection and its models" />

      <div className="flex flex-wrap items-center gap-3">
        <Button type={submitType} onClick={embedded ? submit : undefined} disabled={connect.isPending}>
          {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {connect.isPending ? 'Checking your key...' : 'Save'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={connect.isPending}>
            Cancel
          </Button>
        )}
        {connect.isPending && <span className="text-xs text-muted-foreground">This takes a few seconds.</span>}
      </div>
    </FormBox>
  )
}
