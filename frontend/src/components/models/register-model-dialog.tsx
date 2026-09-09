import React, { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { llmProvidersApi } from '@/lib/api'
import type { RegisterModelBody } from '@/types/models'
import { registerModelSchema, compactCapabilities, type RegisterModelFormData, type RegisterModelFormOutput } from './schema'
import { CapabilitiesField, PrivacyTierField } from './model-form-fields'

export interface ProviderOption {
  id: string
  name: string
  type: string
}

interface RegisterModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: ProviderOption[]
  onSubmit: (body: RegisterModelBody) => Promise<unknown> | void
  submitting?: boolean
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
 * Registers one vendor model behind a stored provider. The model id can be
 * typed, or picked from what the provider lists live when it answers.
 */
export function RegisterModelDialog({ open, onOpenChange, providers, onSubmit, submitting }: RegisterModelDialogProps) {
  const [typeModelId, setTypeModelId] = useState(false)
  const form = useForm<RegisterModelFormData, unknown, RegisterModelFormOutput>({
    resolver: zodResolver(registerModelSchema),
    defaultValues: DEFAULTS,
  })

  useEffect(() => {
    if (!open) {
      form.reset(DEFAULTS)
      setTypeModelId(false)
    }
  }, [open, form])

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
    enabled: open && !!providerId,
    staleTime: 60_000,
  })

  const hasLiveList = liveModels.length > 0 && !typeModelId

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Register model</DialogTitle>
          <DialogDescription>
            Add one model from a configured provider as a card. It becomes usable after a validation run passes.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Controller
            control={form.control}
            name="providerId"
            render={({ field }) => (
              <div>
                <Label htmlFor="register-provider">Provider</Label>
                <Select value={field.value || ''} onValueChange={(v) => { field.onChange(v); form.setValue('vendorModelId', '') }}>
                  <SelectTrigger id="register-provider" className="mt-1" aria-label="Provider">
                    <SelectValue placeholder={providers.length ? 'Select provider' : 'No providers configured'} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} <span className="text-muted-foreground ml-1">({p.type})</span>
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
              <Label htmlFor="register-model-id">Model id</Label>
              {liveModels.length > 0 && (
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setTypeModelId((v) => !v)}
                >
                  {typeModelId ? 'Pick from provider list' : 'Type a model id'}
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
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="register-context">Context length <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input id="register-context" type="number" min={1} className="mt-1" placeholder="200000" {...form.register('contextLength')} />
              {errors.contextLength && <p className="text-xs text-destructive mt-1">{String(errors.contextLength.message)}</p>}
            </div>
          </div>
          <CapabilitiesField control={form.control} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting || providers.length === 0}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Register model
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
