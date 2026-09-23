/**
 * /organizations/new -- create an organization and switch to it.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { organizationsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'

const createOrgSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional(),
})
type CreateOrgFormData = z.infer<typeof createOrgSchema>

export function CreateOrganizationForm() {
  const { setCurrentOrganization, upsertOrganization } = useOrganizationStore()
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const form = useForm<CreateOrgFormData>({
    resolver: zodResolver(createOrgSchema),
    defaultValues: { name: '', description: '' },
  })
  const guard = useLeaveGuard(form.formState.isDirty)

  const createOrgMutation = useMutation({
    mutationFn: organizationsApi.create,
    onSuccess: (response: any) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] })
      success('Organization created', 'Your new organization has been created successfully.')
      upsertOrganization(response)
      setCurrentOrganization(response)
      guard.leave(response?.id ? `/organizations/${response.id}` : '/organizations')
    },
    onError: (err: any) => {
      error('Failed to create organization', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  return (
    <FormPage
      title="Create organization"
      description="Create a new organization to manage your team and resources."
      back={{ to: '/organizations', label: 'Organizations' }}
      guard={guard}
      onSubmit={form.handleSubmit((data) => {
        createOrgMutation.reset()
        createOrgMutation.mutate(data)
      })}
      submitLabel={createOrgMutation.isPending ? 'Creating...' : 'Create organization'}
      submitting={createOrgMutation.isPending}
      width="narrow"
    >
      {createOrgMutation.isError && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {getApiErrorMessage(createOrgMutation.error, 'Could not create the organization. Please try again.')}
        </p>
      )}
      <FormSection>
        <Field id="org-name" label="Organization name" required error={form.formState.errors.name?.message}>
          <Input placeholder="Enter organization name" {...form.register('name')} />
        </Field>
        <Field id="org-description" label="Description (optional)">
          <Textarea placeholder="Enter organization description" {...form.register('description')} />
        </Field>
      </FormSection>
    </FormPage>
  )
}
