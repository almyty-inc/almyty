import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { llmProvidersApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { CreateProviderForm } from './create-provider-form'
import { buildProviderCreateBody, createProviderSchema, type CreateProviderFormData } from './schema'

export interface CreatedProvider {
  id: string
  name: string
  type: string
}

interface AddInferenceProviderFormProps {
  /** Called with the new row, e.g. so the Add model page can select it. */
  onCreated?: (provider: CreatedProvider) => void
  onCancel?: () => void
}

const DEFAULTS: CreateProviderFormData = { name: '', type: '', apiKey: '', apiUrl: '', organizationId: '' }

/**
 * The one way to add an inference provider. The Add inference provider
 * page and the Add model page both render this inline, so there is a
 * single form, a single request body and a single set of invalidations.
 */
export function AddInferenceProviderForm({ onCreated, onCancel }: AddInferenceProviderFormProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const form = useForm<CreateProviderFormData>({ resolver: zodResolver(createProviderSchema), defaultValues: DEFAULTS })

  const mutation = useMutation({
    mutationFn: (data: CreateProviderFormData) => llmProvidersApi.create(buildProviderCreateBody(data)),
    onSuccess: (created: any) => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      // Creating a provider imports what it lists in the background.
      queryClient.invalidateQueries({ queryKey: ['models'] })
      if (created?.id) queryClient.invalidateQueries({ queryKey: ['llm-provider', created.id] })
      form.reset(DEFAULTS)
      notifications.success('Inference provider added', `${created?.name || 'The provider'} is connected. Its models appear on the Models page as they are imported.`)
      if (created?.id) onCreated?.({ id: created.id, name: created.name, type: created.type })
    },
    onError: (error: any) => notifications.error('Could not add the inference provider', getApiErrorMessage(error, 'The provider was not saved')),
  })

  return <CreateProviderForm createForm={form} createProviderMutation={mutation} onCancel={onCancel} />
}
