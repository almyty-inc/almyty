import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'

import { FormPage, FormSection } from '@/components/layout/form-page'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { llmProvidersApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { EditProviderForm } from '@/components/llm-providers/edit-provider-form'
import { buildProviderUpdateBody } from '@/components/llm-providers/schema'

/**
 * Edit a model provider -- its model settings, keys and who can see it --
 * on a page of its own (/llm-providers/:id/edit), not a modal. Saving
 * returns to the provider's detail page.
 */
export function LlmProviderEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notifications = useNotifications()

  const { data: provider, isLoading, isError, error, refetch } = useQuery<any>({
    queryKey: ['llm-provider', id],
    queryFn: () => llmProvidersApi.getById(id!),
    enabled: !!id,
  })

  useEffect(() => {
    document.title = `Edit ${provider?.name ?? 'provider'} | almyty`
    return () => { document.title = 'almyty' }
  }, [provider?.name])

  // credentialId / usageCredentialId stay undefined (keep) unless the
  // credential slot sets them: a connection id points the provider at it,
  // null clears it.
  const editForm = useForm<any>({
    defaultValues: {
      name: '', model: '', maxTokens: 4096, temperature: 0.7,
      apiKey: '', usageApiKey: '', apiUrl: '',
      credentialId: undefined, usageCredentialId: undefined,
    },
  })

  useEffect(() => {
    if (!provider) return
    editForm.reset({
      name: provider.name,
      model: provider.configuration?.model || '',
      maxTokens: provider.configuration?.maxTokens || 4096,
      temperature: provider.configuration?.temperature || 0.7,
      // Stored keys are masked -- start blank; blank keeps the existing key.
      apiKey: '',
      usageApiKey: '',
      apiUrl: provider.configuration?.apiUrl || '',
      credentialId: undefined,
      usageCredentialId: undefined,
    })
    // The model list is the ModelPicker's to fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id])

  const updateProviderMutation = useMutation({
    mutationFn: ({ id: providerId, data }: { id: string; data: any }) =>
      llmProvidersApi.update(providerId, buildProviderUpdateBody(data)),
    onSuccess: (_result, { id: providerId }) => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      queryClient.invalidateQueries({ queryKey: ['llm-provider', providerId] })
      notifications.success('Updated', 'Provider configuration updated successfully')
      navigate(`/llm-providers/${providerId}`)
    },
    onError: (err: any) => {
      notifications.error('Error', getApiErrorMessage(err, 'Failed to update provider'))
    },
  })

  return (
    <FormPage
      title="Edit provider"
      description="Update provider configuration, model settings and who can use it."
      back={{ to: `/llm-providers/${id}`, label: provider?.name ?? 'Provider' }}
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner />
        </div>
      ) : isError ? (
        <QueryError error={error} onRetry={() => refetch()} title="Couldn't load this provider" />
      ) : (
        <FormSection>
          <EditProviderForm
            editForm={editForm}
            providerToEdit={provider}
            updateProviderMutation={updateProviderMutation}
            onCancel={() => navigate(`/llm-providers/${id}`)}
          />
        </FormSection>
      )}
    </FormPage>
  )
}
