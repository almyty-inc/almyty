import { useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SecretInput } from '@/components/ui/secret-input'
import type { VisibilityValue } from '@/components/ui/visibility-field'
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { ConnectedChip } from '@/components/connections/connected-chip'
import { llmProvidersApi } from '@/lib/api'
import type { Connection } from '@/types/connections'
import type { ModelCard } from '@/types/models'
import { BASE_URL_PRIVATE_HOST_HINT, buildProviderCreateBody, createProviderSchema, structuralFieldsFor } from './schema'
import { defaultProviderName, keyUrlFor, needsModelName, providerTileLabel, readConnectFailure, takesBaseUrl, type ConnectFailure, type ProviderTypeInfo } from './provider-catalog'
import { WhoCanUse } from '@/components/connect/who-can-use'

/** What POST /llm-providers/connect answers with once the key works. */
export interface ConnectResult {
  provider: { id: string; name: string; type: string; [key: string]: any }
  models: ModelCard[]
  check?: { ok: boolean; responseTime?: number }
}

type Structural = Partial<Record<'region' | 'resourceName' | 'deploymentName' | 'projectId' | 'location' | 'endpointId', string>>

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Connect one provider: its key (or a server URL for your own server and
 * Ollama), only the settings that provider cannot work without, and who can
 * use it. Saving checks the key first; nothing is saved when it fails, and
 * the form stays filled so the key can be fixed in place.
 */
export function ConnectProviderForm({ type, onConnected }: { type: string; onConnected: (result: ConnectResult) => void }) {
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [model, setModel] = useState('')
  const [structural, setStructural] = useState<Structural>({})
  const [account, setAccount] = useState<Connection | null>(null)
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<ConnectFailure | null>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const modelRef = useRef<HTMLInputElement>(null)

  const ownServer = takesBaseUrl(type)
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
  const keyUrl = failure?.keyUrl || keyUrlFor(type)

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
    // The same rules the backend applies, so a missing field is said here
    // rather than after a round trip.
    const parsed = createProviderSchema.safeParse({
      name: defaultProviderName(type),
      type,
      apiKey: account ? undefined : apiKey.trim() || undefined,
      apiUrl: apiUrl.trim() || undefined,
      connectionId: account?.id,
      model: needsModel ? model : undefined,
      ...structural,
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '')
        if (key && !next[key]) next[key] = issue.message
      }
    }
    if (type === 'ollama' && apiUrl.trim() && !isHttpUrl(apiUrl)) next.apiUrl = 'Enter a URL starting with http:// or https://'
    if (needsModel && !model.trim() && !next.model) next.model = 'Enter the model you want to use'
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setFailure(null)
    // The name comes from the tile; it can be changed on the provider's page.
    const body = buildProviderCreateBody({
      name: defaultProviderName(type),
      type,
      apiKey: account ? '' : apiKey.trim(),
      apiUrl: apiUrl.trim() || undefined,
      connectionId: account?.id,
      model: needsModel ? model : undefined,
      ...structural,
      visibility: visibility.visibility,
      teamId: visibility.teamId,
    })
    connect.mutate(body)
  }

  const fieldError = (name: string) =>
    errors[name] ? (
      <p className="mt-1 text-xs text-destructive" role="alert">
        {errors[name]}
      </p>
    ) : null

  return (
    <form onSubmit={submit} className="space-y-4" noValidate aria-label={`Connect ${defaultProviderName(type)}`}>
      {ownServer && (
        <div>
          <Label htmlFor="connect-api-url">{type === 'custom' ? 'Server URL' : 'Server URL (optional)'}</Label>
          <Input
            id="connect-api-url"
            className="mt-1"
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder={type === 'custom' ? 'https://llm.example.com/v1' : 'http://localhost:11434'}
            aria-invalid={!!errors.apiUrl}
          />
          {fieldError('apiUrl')}
          <p className="mt-1 text-xs text-muted-foreground">
            {type === 'custom' ? 'Any server that speaks the OpenAI API: vLLM, LM Studio, llama.cpp, a gateway. ' : 'Leave empty for a local Ollama. '}
            {BASE_URL_PRIVATE_HOST_HINT}
          </p>
        </div>
      )}

      {fields.map((field) => (
        <div key={field.name}>
          <Label htmlFor={`connect-${field.name}`}>
            {field.label}
            {field.required ? '' : ' (optional)'}
          </Label>
          <Input
            id={`connect-${field.name}`}
            className="mt-1"
            value={structural[field.name] ?? ''}
            onChange={(e) => setStructural((prev) => ({ ...prev, [field.name]: e.target.value }))}
            placeholder={field.placeholder}
            aria-invalid={!!errors[field.name]}
          />
          {fieldError(field.name)}
          {field.hint && <p className="mt-1 text-xs text-muted-foreground">{field.hint}</p>}
        </div>
      ))}

      {needsModel && (
        <div>
          <Label htmlFor="connect-model">Model</Label>
          <Input
            id="connect-model"
            ref={modelRef}
            className="mt-1"
            value={model}
            onChange={(e) => {
              setModel(e.target.value)
              setErrors((prev) => ({ ...prev, model: '' }))
            }}
            placeholder={type === 'vertex_ai' ? 'google/gemini-3.5-flash' : 'The model id, as the provider names it'}
            aria-invalid={!!errors.model || !!modelFailure}
          />
          {fieldError('model')}
          {modelFailure && (
            <p className="mt-1 text-sm text-destructive" role="alert" data-testid="connect-model-failure">
              {modelFailure.message}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{providerTileLabel(type)} does not list its models, so name the one to use.</p>
        </div>
      )}

      {account ? (
        <div className="space-y-1">
          <Label>Account</Label>
          <ConnectedChip connection={account} onClear={() => setAccount(null)} />
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <Label htmlFor="connect-api-key">
              {type === 'vertex_ai' ? 'Service account key (JSON)' : ownServer ? 'API key (optional)' : 'API key'}
            </Label>
            <SecretInput
              id="connect-api-key"
              ref={keyRef}
              className="mt-1"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setErrors((prev) => ({ ...prev, apiKey: '' }))
              }}
              placeholder={ownServer ? 'Only if your server asks for one' : 'Paste your key'}
              aria-invalid={!!errors.apiKey || !!keyFailure}
              aria-describedby={keyFailure ? 'connect-failure' : undefined}
            />
            {fieldError('apiKey')}
            {keyFailure && (
              <div id="connect-failure" role="alert" className="mt-1.5 space-y-1 text-sm text-destructive" data-testid="connect-failure">
                <p>{keyFailure.message}</p>
                {keyFailure.detail && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Details</summary>
                    <span className="break-words">{keyFailure.detail}</span>
                  </details>
                )}
              </div>
            )}
            {keyUrl && (
              <a href={keyUrl} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                Get a key
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">or</span>
            <ConnectAccountButton
              kind="inference"
              connectorKey={type}
              onConnected={(connection) => {
                setAccount(connection)
                setApiKey('')
                setFailure(null)
              }}
            />
          </div>
        </div>
      )}

      {account && keyFailure && (
        <div role="alert" className="space-y-1 text-sm text-destructive" data-testid="connect-failure">
          <p>{keyFailure.message}</p>
          {keyFailure.detail && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Details</summary>
              <span className="break-words">{keyFailure.detail}</span>
            </details>
          )}
        </div>
      )}

      <WhoCanUse value={visibility} onChange={setVisibility} disabled={connect.isPending} noun="this provider and its models" />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={connect.isPending}>
          {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {connect.isPending ? 'Checking your key...' : 'Connect'}
        </Button>
        {connect.isPending && <span className="text-xs text-muted-foreground">This takes a few seconds.</span>}
      </div>
    </form>
  )
}
