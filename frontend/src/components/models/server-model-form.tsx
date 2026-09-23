import React, { useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Connection } from '@/types/connections'
import type { ModelCapabilities, ModelPrivacyTier } from '@/types/models'
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { ConnectedChip } from '@/components/connections/connected-chip'
import { BASE_URL_PRIVATE_HOST_HINT } from '@/components/llm-providers/schema'
import { serverModelSchema, compactCapabilities, type ServerModelFormData, type ServerModelFormOutput } from './schema'
import { CapabilitiesField, PrivacyTierField } from './model-form-fields'

/** What the form hands back; the Add model flow turns it into two requests. */
export interface ServerModelValues {
  name: string
  url: string
  apiKey?: string
  connectionId?: string
  vendorModelId: string
  privacyTier: ModelPrivacyTier
  region?: string
  contextLength?: number
  capabilities?: ModelCapabilities
}

/**
 * The two requests a server you run becomes: a `custom` inference provider
 * that holds the URL and key (the key goes to the credential store like any
 * other provider's), and an ordinary model pointed at it. There is no
 * separate "endpoint" kind of model.
 */
export function buildServerRequests(values: ServerModelValues) {
  const provider: Record<string, any> = {
    name: values.name,
    type: 'custom',
    ...(values.connectionId ? { credentialId: values.connectionId } : {}),
    configuration: {
      apiUrl: values.url,
      model: values.vendorModelId,
      ...(values.apiKey && !values.connectionId ? { apiKey: values.apiKey } : {}),
    },
  }
  const model = {
    name: values.name,
    vendorModelId: values.vendorModelId,
    privacyTier: values.privacyTier,
    ...(values.region ? { region: values.region } : {}),
    ...(values.contextLength !== undefined ? { contextLength: values.contextLength } : {}),
    ...(values.capabilities ? { capabilities: values.capabilities } : {}),
  }
  return { provider, model }
}

const DEFAULTS: ServerModelFormData = {
  name: '',
  url: '',
  apiKey: '',
  connectionId: '',
  vendorModelId: '',
  privacyTier: 'private_cloud',
  region: '',
  contextLength: '',
  capabilities: {},
}

interface ServerModelFormProps {
  onSubmit: (values: ServerModelValues) => Promise<unknown> | void
  onCancel?: () => void
  submitting?: boolean
  footerStart?: ReactNode
}

/** Connect an OpenAI-compatible server you run: vLLM, Ollama, TGI, llama.cpp, LiteLLM. */
export function ServerModelForm({ onSubmit, onCancel, submitting, footerStart }: ServerModelFormProps) {
  const form = useForm<ServerModelFormData, unknown, ServerModelFormOutput>({
    resolver: zodResolver(serverModelSchema),
    defaultValues: DEFAULTS,
  })
  const [connectedAccount, setConnectedAccount] = useState<Connection | null>(null)

  const submit = form.handleSubmit(async (data) => {
    await onSubmit({
      name: data.name,
      url: data.url,
      vendorModelId: data.vendorModelId,
      privacyTier: data.privacyTier as ModelPrivacyTier,
      ...(data.apiKey ? { apiKey: data.apiKey } : {}),
      ...(data.connectionId ? { connectionId: data.connectionId } : {}),
      ...(data.region ? { region: data.region } : {}),
      ...(data.contextLength !== undefined ? { contextLength: data.contextLength } : {}),
      ...(compactCapabilities(data.capabilities) ? { capabilities: compactCapabilities(data.capabilities) } : {}),
    })
  })

  const errors = form.formState.errors

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div>
        <Label htmlFor="server-url">Base URL</Label>
        <Input id="server-url" className="mt-1 font-mono" placeholder="https://llm.example.internal/v1" {...form.register('url')} />
        <p className="text-xs text-muted-foreground mt-1">The part before /chat/completions. {BASE_URL_PRIVATE_HOST_HINT}</p>
        {errors.url && <p className="text-xs text-destructive mt-1">{errors.url.message}</p>}
      </div>
      <div>
        <Label htmlFor="server-model-id">Model id</Label>
        <Input id="server-model-id" className="mt-1 font-mono" placeholder="qwen3-14b" {...form.register('vendorModelId')} />
        <p className="text-xs text-muted-foreground mt-1">Sent as the model field on every request.</p>
        {errors.vendorModelId && <p className="text-xs text-destructive mt-1">{errors.vendorModelId.message}</p>}
      </div>
      <div>
        <Label htmlFor="server-name">Name</Label>
        <Input id="server-name" className="mt-1" placeholder="Qwen on the office box" {...form.register('name')} />
        {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
      </div>
      <div>
        <Label htmlFor="server-api-key">API key <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Input id="server-api-key" type="password" autoComplete="off" className="mt-1" placeholder="Leave empty for a server without auth" {...form.register('apiKey')} disabled={!!connectedAccount} />
        <div className="mt-2">
          {connectedAccount ? (
            <ConnectedChip connection={connectedAccount} onClear={() => { setConnectedAccount(null); form.setValue('connectionId', '') }} />
          ) : (
            <ConnectAccountButton
              kind="inference"
              onConnected={(connection) => {
                setConnectedAccount(connection)
                form.setValue('connectionId', connection.id)
                form.setValue('apiKey', '')
              }}
            />
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <PrivacyTierField control={form.control} name="privacyTier" id="server-tier" />
        <div>
          <Label htmlFor="server-region">Region <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input id="server-region" className="mt-1" placeholder="eu-central" {...form.register('region')} />
        </div>
        <div>
          <Label htmlFor="server-context">Context length <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input id="server-context" type="number" min={1} className="mt-1" placeholder="32768" {...form.register('contextLength')} />
          {errors.contextLength && <p className="text-xs text-destructive mt-1">{String(errors.contextLength.message)}</p>}
        </div>
      </div>
      <CapabilitiesField control={form.control} />
      <p className="text-xs text-muted-foreground">
        The server is saved as an inference provider of type Custom, so its key is encrypted and it shows up under Inference providers.
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {footerStart && <div className="sm:mr-auto">{footerStart}</div>}
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {submitting ? 'Connecting...' : 'Add model'}
        </Button>
      </div>
    </form>
  )
}
