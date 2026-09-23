import React, { useEffect, useState, type ReactNode } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { providerTypeLabels } from '@/components/llm-providers/provider-type-config'
import { llmProvidersApi } from '@/lib/api'
import type { RegisterModelBody } from '@/types/models'
import { registerModelSchema, compactCapabilities, type RegisterModelFormData, type RegisterModelFormOutput } from './schema'
import { CapabilitiesField, PrivacyTierField } from './model-form-fields'

export interface ProviderOption {
  id: string
  name: string
  type: string
}

interface ProviderModelFormProps {
  providers: ProviderOption[]
  providersLoading?: boolean
  /** Preselect this provider, e.g. the one just set up inline. */
  selectedProviderId?: string
  /** Opens the add-inference-provider dialog on top of this form. */
  onSetUpProvider: () => void
  onSubmit: (body: RegisterModelBody) => Promise<unknown> | void
  onCancel?: () => void
  submitting?: boolean
  footerStart?: ReactNode
}

const DEFAULTS: RegisterModelFormData = {
  name: '',
  providerId: '',
  vendorModelId: '',
  privacyTier: 'public',
  region: '',
  contextLength: '',
  capabilities: {},
}

function typeLabel(type: string): string {
  return (providerTypeLabels as Record<string, string>)[type] ?? type
}

/**
 * Add one model from a provider's API. The provider is one you set up, or
 * one you set up right here: with none configured the form says so and
 * offers the setup, rather than an empty dropdown and a disabled button.
 * The model id can be picked from what the provider lists live, or typed.
 */
export function ProviderModelForm({ providers, providersLoading, selectedProviderId, onSetUpProvider, onSubmit, onCancel, submitting, footerStart }: ProviderModelFormProps) {
  const [typeModelId, setTypeModelId] = useState(false)
  const form = useForm<RegisterModelFormData, unknown, RegisterModelFormOutput>({
    resolver: zodResolver(registerModelSchema),
    defaultValues: DEFAULTS,
  })

  useEffect(() => {
    if (selectedProviderId && providers.some((p) => p.id === selectedProviderId)) {
      form.setValue('providerId', selectedProviderId, { shouldValidate: false })
      form.setValue('vendorModelId', '')
    }
  }, [selectedProviderId, providers, form])

  const providerId = form.watch('providerId')
  const vendorModelId = form.watch('vendorModelId')
  const name = form.watch('name')

  const { data: liveModels = [], isFetching: modelsLoading } = useQuery({
    queryKey: ['provider-models', providerId],
    queryFn: async () => {
      const res = await llmProvidersApi.getModels(providerId)
      const list = Array.isArray(res) ? res : []
      return list.map((m: any) => ({ id: String(m.id || m.name || m), name: String(m.name || m.id || m) }))
    },
    enabled: !!providerId,
    staleTime: 60_000,
  })

  const hasLiveList = liveModels.length > 0 && !typeModelId
  const noProviders = !providersLoading && providers.length === 0

  const submit = form.handleSubmit(async (data) => {
    const body: RegisterModelBody = {
      name: data.name,
      providerId: data.providerId,
      vendorModelId: data.vendorModelId,
      privacyTier: data.privacyTier as RegisterModelBody['privacyTier'],
      ...(data.region ? { region: data.region } : {}),
      ...(data.contextLength !== undefined ? { contextLength: data.contextLength } : {}),
    }
    const caps = compactCapabilities(data.capabilities)
    if (caps) body.capabilities = caps
    await onSubmit(body)
  })

  const errors = form.formState.errors

  if (noProviders) {
    return (
      <div className="space-y-4" data-testid="no-inference-providers">
        <div className="rounded-lg border border-dashed p-4 text-sm">
          <p className="font-medium">No inference providers yet</p>
          <p className="mt-1 text-muted-foreground">
            An inference provider is the API a model is called through, with your key for it: OpenAI, Anthropic, Groq, Mistral and 35 more. Set one up and pick its model here.
          </p>
          <Button type="button" className="mt-3 gap-2" onClick={onSetUpProvider}>
            <Plus className="h-4 w-4" />
            Set up an inference provider
          </Button>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          {footerStart && <div className="sm:mr-auto">{footerStart}</div>}
          {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Controller
        control={form.control}
        name="providerId"
        render={({ field }) => (
          <div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="register-provider">Inference provider</Label>
              <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground transition-colors" onClick={onSetUpProvider}>
                Set up another
              </button>
            </div>
            <Select value={field.value || ''} onValueChange={(v) => { field.onChange(v); form.setValue('vendorModelId', '') }} disabled={providersLoading}>
              <SelectTrigger id="register-provider" className="mt-1" aria-label="Inference provider">
                <SelectValue placeholder={providersLoading ? 'Loading...' : 'Select an inference provider'} />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} <span className="text-muted-foreground ml-1">({typeLabel(p.type)})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.providerId && <p className="text-xs text-destructive mt-1">{errors.providerId.message}</p>}
          </div>
        )}
      />
      <div>
        <div className="flex items-center justify-between">
          <Label htmlFor="register-model-id">Model</Label>
          {liveModels.length > 0 && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setTypeModelId((v) => !v)}
            >
              {typeModelId ? 'Pick from the provider list' : 'Type a model id'}
            </button>
          )}
        </div>
        {hasLiveList ? (
          <Controller
            control={form.control}
            name="vendorModelId"
            render={({ field }) => (
              <Select
                value={field.value || ''}
                onValueChange={(v) => {
                  field.onChange(v)
                  if (!name) form.setValue('name', v)
                }}
              >
                <SelectTrigger id="register-model-id" className="mt-1 font-mono" aria-label="Model id">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {liveModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        ) : (
          <Input
            id="register-model-id"
            className="mt-1 font-mono"
            placeholder="claude-sonnet-5"
            {...form.register('vendorModelId', {
              onBlur: () => { if (!name && vendorModelId) form.setValue('name', vendorModelId) },
            })}
          />
        )}
        {modelsLoading && <p className="text-xs text-muted-foreground mt-1">Asking the provider for its model list...</p>}
        {!modelsLoading && providerId && liveModels.length === 0 && (
          <p className="text-xs text-muted-foreground mt-1">The provider did not list any models. Type the id it expects.</p>
        )}
        {errors.vendorModelId && <p className="text-xs text-destructive mt-1">{errors.vendorModelId.message}</p>}
      </div>
      <div>
        <Label htmlFor="register-name">Name</Label>
        <Input id="register-name" className="mt-1" placeholder="Shown in dropdowns" {...form.register('name')} />
        {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <PrivacyTierField control={form.control} name="privacyTier" id="register-tier" />
        <div>
          <Label htmlFor="register-region">Region <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input id="register-region" className="mt-1" placeholder="us-east" {...form.register('region')} />
        </div>
        <div>
          <Label htmlFor="register-context">Context length <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input id="register-context" type="number" min={1} className="mt-1" placeholder="200000" {...form.register('contextLength')} />
          {errors.contextLength && <p className="text-xs text-destructive mt-1">{String(errors.contextLength.message)}</p>}
        </div>
      </div>
      <CapabilitiesField control={form.control} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
        {footerStart && <div className="sm:mr-auto">{footerStart}</div>}
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {submitting ? 'Adding...' : 'Add model'}
        </Button>
      </div>
    </form>
  )
}
