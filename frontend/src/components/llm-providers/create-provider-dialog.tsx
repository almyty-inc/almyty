import React from 'react'
import { UseFormReturn, Controller } from 'react-hook-form'
import { UseMutationResult } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CredentialPicker } from '@/components/credential-picker'
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
import { ExternalLink } from 'lucide-react'
import { providerKeyUrls } from './provider-type-config'

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
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="anthropic">Anthropic</SelectItem>
                    <SelectItem value="google">Google Gemini</SelectItem>
                    <SelectItem value="mistral">Mistral AI</SelectItem>
                    <SelectItem value="xai">xAI (Grok)</SelectItem>
                    <SelectItem value="deepseek">DeepSeek</SelectItem>
                    <SelectItem value="groq">Groq</SelectItem>
                    <SelectItem value="together">Together AI</SelectItem>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                    <SelectItem value="azure_openai">Azure OpenAI</SelectItem>
                    <SelectItem value="aws_bedrock">AWS Bedrock</SelectItem>
                    <SelectItem value="cohere">Cohere</SelectItem>
                    <SelectItem value="huggingface">HuggingFace</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            {createForm.formState.errors.type && (
              <p className="text-sm text-red-600 mt-1">{(createForm.formState.errors.type as any).message}</p>
            )}
          </div>

          {/* API Key — select from vault or enter new */}
          <CredentialPicker
            label="API Key"
            value={createForm.watch('credentialId') || ''}
            onSelect={(id) => { createForm.setValue('credentialId', id); createForm.setValue('apiKey', '') }}
            onNewKey={(key) => { createForm.setValue('apiKey', key); createForm.setValue('credentialId', '') }}
            newKeyValue={createForm.watch('apiKey') || ''}
            filterType="api_key"
          />
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
          {createForm.formState.errors.apiKey && (
            <p className="text-sm text-red-600 mt-1">{(createForm.formState.errors.apiKey as any).message}</p>
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
