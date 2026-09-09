import React from 'react'
import { UseFormReturn, Controller } from 'react-hook-form'
import { UseMutationResult } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { ExternalLink } from 'lucide-react'
import { providerKeyUrls, providerUsageApiSupport, usageApiSupported } from './provider-type-config'
import { CredentialSlot, isMaskedKey } from './credential-slot'
import { BASE_URL_PRIVATE_HOST_HINT, baseUrlSupported } from './schema'

interface EditProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editForm: UseFormReturn<any>
  providerToEdit: any | null
  updateProviderMutation: UseMutationResult<any, any, any, any>
  availableModels: Array<{ id: string; name: string }>
  modelsLoading: boolean
}

export function EditProviderDialog({
  open,
  onOpenChange,
  editForm,
  providerToEdit,
  updateProviderMutation,
  availableModels,
  modelsLoading,
}: EditProviderDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Provider</DialogTitle>
          <DialogDescription>
            Update provider configuration and model settings
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={editForm.handleSubmit((data: any) => {
          if (providerToEdit) {
            updateProviderMutation.mutate({ id: providerToEdit.id, data })
          }
        })} className="space-y-4">
          {/* Provider Name */}
          <div>
            <Label htmlFor="editProviderName">Provider Name</Label>
            <Input
              id="editProviderName"
              {...editForm.register('name')}
              placeholder="e.g., OpenAI Production"
            />
          </div>

          {/* Default Model Selection */}
          <div>
            <Label htmlFor="editDefaultModel">Default Model</Label>
            <Controller
              name="model"
              control={editForm.control}
              render={({ field }) => (
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger id="editDefaultModel" aria-label="Default Model">
                    <SelectValue placeholder={modelsLoading ? "Loading models..." : "Select default model"} />
                  </SelectTrigger>
                  <SelectContent>
                    {modelsLoading && (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">Fetching models from provider API...</div>
                    )}
                    {!modelsLoading && availableModels.length > 0 && availableModels.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name !== model.id ? `${model.name} (${model.id})` : model.id}
                      </SelectItem>
                    ))}
                    {!modelsLoading && availableModels.length === 0 && (
                      <div className="px-2 py-1.5 text-sm text-muted-foreground">No models available — check API key</div>
                    )}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {/* Model Parameters */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="editMaxTokens">Max Tokens</Label>
              <Input
                id="editMaxTokens"
                type="number"
                {...editForm.register('maxTokens', { valueAsNumber: true })}
                placeholder="4096"
              />
            </div>
            <div>
              <Label htmlFor="editTemperature">Temperature</Label>
              <Input
                id="editTemperature"
                type="number"
                step="0.1"
                min="0"
                max="2"
                {...editForm.register('temperature', { valueAsNumber: true })}
                placeholder="0.7"
              />
            </div>
          </div>

          {/* Server URL for the types that have one (ollama, custom); blank
              keeps the stored value. Sent as configuration.apiUrl. */}
          {baseUrlSupported(providerToEdit?.type) && (
            <div>
              <Label htmlFor="editApiUrl">Base URL{providerToEdit?.type === 'custom' ? '' : ' (optional)'}</Label>
              <Input
                id="editApiUrl"
                {...editForm.register('apiUrl')}
                placeholder={providerToEdit?.type === 'custom' ? 'https://llm.example.internal/v1' : 'http://localhost:11434'}
              />
              <p className="text-xs text-muted-foreground mt-1">{BASE_URL_PRIVATE_HOST_HINT}</p>
            </div>
          )}

          {/* Inference key: the connection backing it, or a pasted key.
              Never prefilled: the stored value is masked on read; the
              slot writes credentialId (undefined keep / id / null clear)
              and apiKey (blank keeps the existing key). */}
          <CredentialSlot
            label="API key"
            credentialRef={providerToEdit?.credentialRef}
            hasStoredKey={isMaskedKey(providerToEdit?.configuration?.apiKey)}
            connectorKey={providerToEdit?.type}
            form={editForm}
            idField="credentialId"
            keyField="apiKey"
            keyInputId="editApiKey"
            keyLabel="New API key"
            keyPlaceholder="Leave blank to keep the existing key"
            allowClear={providerToEdit?.type === 'ollama'}
            keyHelp={providerKeyUrls[providerToEdit?.type] ? (
              <a
                href={providerKeyUrls[providerToEdit?.type]}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1"
              >
                <ExternalLink className="h-3 w-3" />
                Get your API key
              </a>
            ) : undefined}
          />

          {/* Usage API key: only for types with a supported usage/cost API.
              Same rules as the inference key: blank keeps, a connection
              replaces, "Remove" clears. */}
          {usageApiSupported(providerToEdit?.type) && (
            <CredentialSlot
              label="Usage API key"
              credentialRef={providerToEdit?.usageCredentialRef}
              hasStoredKey={isMaskedKey(providerToEdit?.configuration?.usageApiKey)}
              connectorKey={providerToEdit?.type}
              form={editForm}
              idField="usageCredentialId"
              keyField="usageApiKey"
              keyInputId="editUsageApiKey"
              keyLabel="Usage API key (admin-scoped, for cost reconciliation)"
              keyPlaceholder="Leave blank to keep the existing key"
              keyHelp={
                <p className="text-xs text-muted-foreground mt-1">
                  Requires an admin-scoped key (OpenAI sk-admin-..., Anthropic admin key) — the
                  regular inference key cannot read usage/cost reports.{' '}
                  <a
                    href={providerUsageApiSupport[providerToEdit?.type]?.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Admin key docs
                  </a>
                </p>
              }
            />
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={updateProviderMutation.isPending}>
              {updateProviderMutation.isPending ? 'Updating...' : 'Update Provider'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
