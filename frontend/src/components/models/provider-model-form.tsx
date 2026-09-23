import React, { useEffect, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModelPicker } from '@/components/model-picker'
import type { RegisterModelBody } from '@/types/models'
import { registerModelSchema, compactCapabilities, type RegisterModelFormData, type RegisterModelFormOutput } from './schema'
import { CapabilitiesField, PrivacyTierField } from './model-form-fields'

/**
 * A model hosted on your cloud gets a provider row written for it by the
 * reconcile loop (metadata.managedBy.kind model_endpoint). It is that
 * model's plumbing, not an API to add other models from.
 */
export function isHostedModelPlumbing(provider: Record<string, any>): boolean {
  return provider?.metadata?.managedBy?.kind === 'model_endpoint'
}

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

/**
 * Add one model from a provider's API. The provider is one you set up, or
 * one you set up right here: with none configured the form says so and
 * offers the setup, rather than an empty dropdown and a disabled button.
 * The model comes from the shared ModelPicker: what the provider offers,
 * or an id typed on purpose.
 */
export function ProviderModelForm({ providers, providersLoading, selectedProviderId, onSetUpProvider, onSubmit, onCancel, submitting, footerStart }: ProviderModelFormProps) {
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
      <div className="space-y-1">
        <div className="flex justify-end">
          <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground transition-colors" onClick={onSetUpProvider}>
            Set up another inference provider
          </button>
        </div>
        {/* The shared picker: the model is a list of what the provider
            offers, with typing an id as an explicit escape hatch. */}
        <ModelPicker
          idPrefix="register"
          layout="stack"
          providerLabel="Inference provider"
          excludeProvider={isHostedModelPlumbing}
          value={{ providerId: providerId || undefined, model: vendorModelId || undefined }}
          onChange={(next) => {
            const submitted = form.formState.isSubmitted
            form.setValue('providerId', next.providerId ?? '', { shouldValidate: submitted, shouldDirty: true })
            form.setValue('vendorModelId', next.model ?? '', { shouldValidate: submitted, shouldDirty: true })
            if (next.model && (!name || name === vendorModelId)) form.setValue('name', next.model)
          }}
        />
        {errors.providerId && <p className="text-xs text-destructive">{errors.providerId.message}</p>}
        {errors.vendorModelId && <p className="text-xs text-destructive">{errors.vendorModelId.message}</p>}
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
