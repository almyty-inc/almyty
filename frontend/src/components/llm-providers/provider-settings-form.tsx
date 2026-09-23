/* ProviderSettingsForm -- edit an inference provider in place.
 *
 * This was the "Edit inference provider" dialog on the providers list. It
 * is now the Configuration tab of the provider's own page
 * (/llm-providers/:id?tab=configuration), opened by that tab's Edit button
 * or by the list's row menu. Save and Cancel sit at the end of the form,
 * like every other inline edit.
 *
 * The default model is chosen with the shared ModelPicker, limited to this
 * provider, so it is a select of what the provider actually serves (free
 * text only where the picker allows it).
 */
import { Controller, type UseFormReturn } from 'react-hook-form'
import type { UseMutationResult } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'

import { Field, InlineFormActions } from '@/components/layout/form-page'
import { ModelPicker } from '@/components/model-picker'
import { Input } from '@/components/ui/input'
import { providerKeyUrls, providerUsageApiSupport, usageApiSupported } from './provider-type-config'
import { CredentialSlot, isMaskedKey } from './credential-slot'
import { BASE_URL_PRIVATE_HOST_HINT, baseUrlSupported } from './schema'

/** Form values for a provider as it is stored; keys always start blank. */
export function providerEditDefaults(provider: any) {
  return {
    name: provider?.name ?? '',
    model: provider?.configuration?.model || '',
    maxTokens: provider?.configuration?.maxTokens || 4096,
    temperature: provider?.configuration?.temperature ?? 0.7,
    // Stored keys are masked on read. Blank means "keep the existing key"
    // on update, and an unset credentialId keeps the connection.
    apiKey: '',
    usageApiKey: '',
    apiUrl: provider?.configuration?.apiUrl || '',
    credentialId: undefined,
    usageCredentialId: undefined,
  }
}

export interface ProviderSettingsFormProps {
  editForm: UseFormReturn<any>
  providerToEdit: any
  updateProviderMutation: Pick<UseMutationResult<any, any, any, any>, 'isPending' | 'mutate'>
  onCancel: () => void
}

export function ProviderSettingsForm({
  editForm,
  providerToEdit,
  updateProviderMutation,
  onCancel,
}: ProviderSettingsFormProps) {
  const type = providerToEdit?.type
  return (
    <form
      aria-label="Edit provider"
      className="space-y-4"
      onSubmit={editForm.handleSubmit((data: any) => {
        if (providerToEdit) updateProviderMutation.mutate({ id: providerToEdit.id, data })
      })}
    >
      <Field id="editProviderName" label="Name" hint="Shown wherever a provider is picked.">
        <Input {...editForm.register('name')} placeholder="e.g., OpenAI production" />
      </Field>

      <Controller
        name="model"
        control={editForm.control}
        render={({ field }) => (
          <ModelPicker
            idPrefix="editProvider"
            value={{ providerId: providerToEdit?.id, model: field.value || '' }}
            onChange={(next) => field.onChange(next.model ?? '')}
            excludeProvider={(p) => p.id !== providerToEdit?.id}
            modelOptional
            modelLabel="Default model"
          />
        )}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="editMaxTokens" label="Max tokens" hint="Upper bound on a reply's length.">
          <Input type="number" {...editForm.register('maxTokens', { valueAsNumber: true })} placeholder="4096" />
        </Field>
        <Field id="editTemperature" label="Temperature" hint="0 is most predictable, 2 most varied.">
          <Input
            type="number"
            step="0.1"
            min="0"
            max="2"
            {...editForm.register('temperature', { valueAsNumber: true })}
            placeholder="0.7"
          />
        </Field>
      </div>

      {/* Server URL for the types that have one (ollama, custom); blank
          keeps the stored value. Sent as configuration.apiUrl. */}
      {baseUrlSupported(type) && (
        <Field
          id="editApiUrl"
          label={`Base URL${type === 'custom' ? '' : ' (optional)'}`}
          hint={BASE_URL_PRIVATE_HOST_HINT}
        >
          <Input
            {...editForm.register('apiUrl')}
            placeholder={type === 'custom' ? 'https://llm.example.internal/v1' : 'http://localhost:11434'}
          />
        </Field>
      )}

      {/* Inference key: the connection backing it, or a pasted key. Never
          prefilled: the stored value is masked on read. */}
      <CredentialSlot
        label="API key"
        credentialRef={providerToEdit?.credentialRef}
        hasStoredKey={isMaskedKey(providerToEdit?.configuration?.apiKey)}
        connectorKey={type}
        form={editForm}
        idField="credentialId"
        keyField="apiKey"
        keyInputId="editApiKey"
        keyLabel="New API key"
        keyPlaceholder="Leave blank to keep the existing key"
        allowClear={type === 'ollama'}
        keyHelp={
          providerKeyUrls[type] ? (
            <a
              href={providerKeyUrls[type]}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Get your API key
            </a>
          ) : undefined
        }
      />

      {/* Usage API key: only for types with a supported usage/cost API. */}
      {usageApiSupported(type) && (
        <CredentialSlot
          label="Usage API key"
          credentialRef={providerToEdit?.usageCredentialRef}
          hasStoredKey={isMaskedKey(providerToEdit?.configuration?.usageApiKey)}
          connectorKey={type}
          form={editForm}
          idField="usageCredentialId"
          keyField="usageApiKey"
          keyInputId="editUsageApiKey"
          keyLabel="Usage API key (admin-scoped, for cost reconciliation)"
          keyPlaceholder="Leave blank to keep the existing key"
          keyHelp={
            <p className="mt-1 text-xs text-muted-foreground">
              Requires an admin-scoped key (OpenAI sk-admin-..., Anthropic admin key) — the
              regular inference key cannot read usage/cost reports.{' '}
              <a
                href={providerUsageApiSupport[type]?.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                Admin key docs
              </a>
            </p>
          }
        />
      )}

      <InlineFormActions
        onCancel={onCancel}
        submitLabel="Save changes"
        submitting={updateProviderMutation.isPending}
      />
    </form>
  )
}
