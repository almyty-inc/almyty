import React, { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
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
import type { RegisterEndpointBody } from '@/types/models'
import { registerEndpointSchema, compactCapabilities, type RegisterEndpointFormData, type RegisterEndpointFormOutput } from './schema'
import { CapabilitiesField, PrivacyTierField } from './model-form-fields'

interface RegisterEndpointDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (body: RegisterEndpointBody) => Promise<unknown> | void
  submitting?: boolean
}

const DEFAULTS: RegisterEndpointFormData = {
  name: '',
  url: '',
  apiKey: '',
  vendorModelId: '',
  privacyTier: 'private_cloud',
  region: '',
  contextLength: '',
  capabilities: {},
}

/**
 * Registers an OpenAI-compatible server the org runs itself. The backend
 * stores the URL and key as a custom provider and points a new card at it.
 */
export function RegisterEndpointDialog({ open, onOpenChange, onSubmit, submitting }: RegisterEndpointDialogProps) {
  const form = useForm<RegisterEndpointFormData, unknown, RegisterEndpointFormOutput>({
    resolver: zodResolver(registerEndpointSchema),
    defaultValues: DEFAULTS,
  })

  useEffect(() => {
    if (!open) form.reset(DEFAULTS)
  }, [open, form])

  const submit = form.handleSubmit(async (data) => {
    const body: RegisterEndpointBody = {
      name: data.name,
      url: data.url,
      vendorModelId: data.vendorModelId,
      privacyTier: data.privacyTier as RegisterEndpointBody['privacyTier'],
      ...(data.apiKey ? { apiKey: data.apiKey } : {}),
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
          <DialogTitle>Register endpoint</DialogTitle>
          <DialogDescription>
            Any OpenAI-compatible server you run: vLLM, Ollama, TGI, llama.cpp. The key is encrypted at rest.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="endpoint-name">Name</Label>
            <Input id="endpoint-name" className="mt-1" placeholder="Qwen on the office box" {...form.register('name')} />
            {errors.name && <p className="text-xs text-destructive mt-1">{errors.name.message}</p>}
          </div>
          <div>
            <Label htmlFor="endpoint-url">Base URL</Label>
            <Input id="endpoint-url" className="mt-1 font-mono" placeholder="http://10.0.0.5:8000/v1" {...form.register('url')} />
            {errors.url && <p className="text-xs text-destructive mt-1">{errors.url.message}</p>}
          </div>
          <div>
            <Label htmlFor="endpoint-api-key">API key <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input id="endpoint-api-key" type="password" autoComplete="off" className="mt-1" placeholder="Leave empty for keyless servers" {...form.register('apiKey')} />
          </div>
          <div>
            <Label htmlFor="endpoint-model-id">Model id</Label>
            <Input id="endpoint-model-id" className="mt-1 font-mono" placeholder="qwen3-14b" {...form.register('vendorModelId')} />
            <p className="text-xs text-muted-foreground mt-1">Sent as the model field on every request.</p>
            {errors.vendorModelId && <p className="text-xs text-destructive mt-1">{errors.vendorModelId.message}</p>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <PrivacyTierField control={form.control} name="privacyTier" id="endpoint-tier" />
            <div>
              <Label htmlFor="endpoint-region">Region <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input id="endpoint-region" className="mt-1" placeholder="eu-central" {...form.register('region')} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="endpoint-context">Context length <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input id="endpoint-context" type="number" min={1} className="mt-1" placeholder="32768" {...form.register('contextLength')} />
              {errors.contextLength && <p className="text-xs text-destructive mt-1">{String(errors.contextLength.message)}</p>}
            </div>
          </div>
          <CapabilitiesField control={form.control} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Register endpoint
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
