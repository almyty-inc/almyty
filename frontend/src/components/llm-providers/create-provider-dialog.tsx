import React from 'react'
import { UseFormReturn, Controller } from 'react-hook-form'
import { UseMutationResult } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CredentialPicker } from '@/components/credential-picker'
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { ConnectedChip } from '@/components/connections/connected-chip'
import type { Connection } from '@/types/connections'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { useOrganizationStore } from '@/store/organization'
import { ExternalLink, TestTube, CheckCircle2, XCircle } from 'lucide-react'
import { llmProvidersApi } from '@/lib/api'
import { providerKeyUrls, providerTypeOptions, providerUsageApiSupport, usageApiSupported } from './provider-type-config'
import { BASE_URL_PRIVATE_HOST_HINT, structuralFieldsFor } from './schema'

interface CreateProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  createForm: UseFormReturn<any>
  createProviderMutation: UseMutationResult<any, any, any, any>
}

export function CreateProviderDialog({
  open,
  onOpenChange,
  createForm,
  createProviderMutation,
}: CreateProviderDialogProps) {
  const { currentOrganization } = useOrganizationStore()
  const [visibility, setVisibility] = React.useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<any>(null)
  const [connectedAccount, setConnectedAccount] = React.useState<Connection | null>(null)
  const handleTestConnection = async () => {
    const type = createForm.watch('type')
    const apiKey = createForm.watch('apiKey')
    if (!type || !apiKey) return
    setTesting(true)
    setTestResult(null)
    try {
      const res: any = await llmProvidersApi.testConnection(type, apiKey)
      setTestResult(res?.data ?? res)
    } catch (e: any) {
      setTestResult({ ok: false, error: e?.response?.data?.message || e?.message || 'Test failed' })
    } finally {
      setTesting(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add Provider</DialogTitle>
          <DialogDescription>
            Select a provider type and configure your LLM integration
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={createForm.handleSubmit((data: any) => createProviderMutation.mutate({ ...data, visibility: visibility.visibility, teamId: visibility.teamId }))} className="space-y-4">
          {/* Provider Name */}
          <div>
            <Label htmlFor="providerName">Provider Name</Label>
            <Input
              id="providerName"
              {...createForm.register('name')}
              placeholder="e.g., OpenAI Production"
            />
            {createForm.formState.errors.name && (
              <p className="text-sm text-red-600 mt-1">{(createForm.formState.errors.name as any).message}</p>
            )}
          </div>

          {/* Provider Type */}
          <div>
            <Label htmlFor="providerType">Provider Type</Label>
            <Controller
              name="type"
              control={createForm.control}
              render={({ field }) => (
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger id="providerType" aria-label="Provider Type">
                    <SelectValue placeholder="Select provider type" />
                  </SelectTrigger>
                  <SelectContent>
                    {providerTypeOptions.map(({ value, label }) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {createForm.formState.errors.type && (
              <p className="text-sm text-red-600 mt-1">{(createForm.formState.errors.type as any).message}</p>
            )}
          </div>

          {/* Structural configuration: the region / resource / project /
              endpoint that makes this provider's base URL resolvable. Without
              these, AWS Bedrock and Azure OpenAI could be selected here and
              then always failed to save. */}
          {structuralFieldsFor(createForm.watch('type')).map((field) => (
            <div key={field.name}>
              <Label htmlFor={field.name}>
                {field.label}{field.required ? '' : ' (optional)'}
              </Label>
              <Input
                id={field.name}
                {...createForm.register(field.name)}
                placeholder={field.placeholder}
              />
              {field.hint && (
                <p className="text-xs text-muted-foreground mt-1">{field.hint}</p>
              )}
              {createForm.formState.errors[field.name] && (
                <p className="text-sm text-red-600 mt-1">
                  {String((createForm.formState.errors as any)[field.name].message)}
                </p>
              )}
            </div>
          ))}

          {createForm.watch('type') === 'vertex_ai' && (
            <div>
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                {...createForm.register('model')}
                placeholder="google/gemini-3.5-flash"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Vertex AI's OpenAI-compatible surface serves no model list, so the model has
                to be named here. Paste your service-account JSON key as the credential below -
                this surface does not accept an API key.
              </p>
              {createForm.formState.errors.model && (
                <p className="text-sm text-red-600 mt-1">
                  {String((createForm.formState.errors as any).model.message)}
                </p>
              )}
            </div>
          )}

          {/* API Key — select from vault or enter new */}
          <CredentialPicker
            label={createForm.watch('type') === 'ollama' ? 'API Key (optional)' : 'API Key'}
            value={createForm.watch('credentialId') || ''}
            onSelect={(id) => { createForm.setValue('credentialId', id); createForm.setValue('apiKey', ''); createForm.setValue('connectionId', '') }}
            onNewKey={(key) => { createForm.setValue('apiKey', key); createForm.setValue('credentialId', ''); createForm.setValue('connectionId', '') }}
            newKeyValue={createForm.watch('apiKey') || ''}
            filterType="api_key"
          />
          {/* Or connect an account through the Connections layer */}
          {createForm.watch('connectionId') && connectedAccount ? (
            <ConnectedChip connection={connectedAccount} onClear={() => { createForm.setValue('connectionId', ''); setConnectedAccount(null) }} />
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">or</span>
              <ConnectAccountButton
                kind="inference"
                onConnected={(connection) => {
                  setConnectedAccount(connection)
                  createForm.setValue('connectionId', connection.id)
                  createForm.setValue('apiKey', '')
                  createForm.setValue('credentialId', '')
                }}
              />
            </div>
          )}
          {providerKeyUrls[createForm.watch('type')] && (
            <a
              href={providerKeyUrls[createForm.watch('type')]}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1"
            >
              <ExternalLink className="h-3 w-3" />
              Get your API key
            </a>
          )}
          {createForm.watch('type') === 'ollama' && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Runs on your machine - install from{' '}
                <a
                  href="https://ollama.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  ollama.com
                </a>
                ; default URL http://localhost:11434. Local mode needs no API key - only add
                one if your server sits behind an authenticating proxy. Self-hosted almyty
                needs OLLAMA_ALLOW_PRIVATE_URLS=true to reach a localhost/private server.
                Or use Ollama cloud: set the base URL to https://ollama.com and paste an API
                key from ollama.com/settings/keys - hosted models, no local install.
              </p>
              <div>
                <Label htmlFor="apiUrl">Base URL (optional)</Label>
                <Input
                  id="apiUrl"
                  {...createForm.register('apiUrl')}
                  placeholder="http://localhost:11434"
                />
              </div>
            </div>
          )}
          {createForm.watch('type') === 'custom' && (
            <div>
              <Label htmlFor="apiUrl">Base URL</Label>
              <Input
                id="apiUrl"
                {...createForm.register('apiUrl')}
                placeholder="https://llm.example.internal/v1"
              />
              {createForm.formState.errors.apiUrl && (
                <p className="text-xs text-destructive mt-1">{String(createForm.formState.errors.apiUrl.message)}</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Any OpenAI-compatible server (vLLM, LM Studio, llama.cpp, a gateway). {BASE_URL_PRIVATE_HOST_HINT}
              </p>
            </div>
          )}
          {createForm.watch('apiKey') && (
            <div className="space-y-1">
              <Button type="button" variant="outline" size="sm" onClick={handleTestConnection} disabled={testing} className="gap-2">
                {testing ? (
                  <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current" />
                ) : (
                  <TestTube className="h-3.5 w-3.5" />
                )}
                Test connection
              </Button>
              {testResult && (testResult.ok ? (
                <p className="text-xs text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Connected
                  {typeof testResult.modelCount === 'number' ? ` — ${testResult.modelCount} models` : ''}
                  {typeof testResult.latencyMs === 'number' ? ` (${testResult.latencyMs}ms)` : ''}
                </p>
              ) : (
                <p className="text-xs text-red-600 flex items-center gap-1">
                  <XCircle className="h-3 w-3" /> {testResult.error || 'Connection failed'}
                </p>
              ))}
            </div>
          )}
          {createForm.formState.errors.apiKey && (
            <p className="text-sm text-red-600 mt-1">{(createForm.formState.errors.apiKey as any).message}</p>
          )}

          {/* Usage API key — only for types with a supported usage/cost API */}
          {usageApiSupported(createForm.watch('type')) && (
            <div>
              <Label htmlFor="usageApiKey">Usage API key (admin-scoped, for cost reconciliation)</Label>
              <Input
                id="usageApiKey"
                type="password"
                autoComplete="off"
                {...createForm.register('usageApiKey')}
                placeholder="Optional — admin key for usage/cost reports"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Requires an admin-scoped key (OpenAI sk-admin-..., Anthropic admin key) — the
                regular inference key cannot read usage/cost reports.{' '}
                <a
                  href={providerUsageApiSupport[createForm.watch('type')]?.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  Admin key docs
                </a>
              </p>
            </div>
          )}

          {/* Organization ID - Only for OpenAI */}
          {createForm.watch('type') === 'openai' && (
            <div>
              <Label htmlFor="organizationId">Organization ID (Optional)</Label>
              <Input
                id="organizationId"
                {...createForm.register('organizationId')}
                placeholder="org-..."
              />
              {createForm.formState.errors.organizationId && (
                <p className="text-sm text-red-600 mt-1">{(createForm.formState.errors.organizationId as any).message}</p>
              )}
            </div>
          )}

          <div className="border-t pt-4">
            <VisibilityField
              organizationId={currentOrganization?.id ?? ''}
              value={visibility}
              onChange={setVisibility}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createProviderMutation.isPending}>
              {createProviderMutation.isPending ? 'Adding...' : 'Add Provider'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
