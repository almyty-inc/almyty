/**
 * apis/api-form -- the Edit API page body (`/apis/:id/edit`).
 *
 * The things a description can get wrong or leave out: the name, the
 * address, the version, the description, and who can use it. The key
 * lives on the API's page (its Key card), and the kind of API follows
 * from its description, so neither is here. Connecting a new API is
 * `/apis/new` (one box); an SDK API is `/apis/new/sdk`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import React from 'react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { Api, ApiType } from '@/types'

import { editApiSchema, type EditApiFormData, type EditApiFormInput } from './schema'

export function ApiForm({ editingApi }: { editingApi: Api }) {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const isSdk = editingApi.type === ApiType.SDK

  const form = useForm<EditApiFormInput, any, EditApiFormData>({
    resolver: zodResolver(editApiSchema),
    defaultValues: {
      name: editingApi.name,
      baseUrl: editingApi.baseUrl ?? '',
      description: editingApi.description || '',
      version: editingApi.version || '',
    },
  })
  const { errors } = form.formState

  const initialVisibility: VisibilityValue = {
    visibility: editingApi.visibility ?? 'org',
    teamId: editingApi.teamId ?? null,
  }
  const [visibility, setVisibility] = React.useState<VisibilityValue>(initialVisibility)

  const dirty =
    form.formState.isDirty ||
    visibility.visibility !== initialVisibility.visibility ||
    visibility.teamId !== initialVisibility.teamId
  const guard = useLeaveGuard(dirty)

  const update = useMutation({
    mutationFn: (data: Partial<Api>) => apisApi.update(editingApi.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['api', editingApi.id] })
      success('API updated', 'Your changes are saved.')
      guard.leave(`/apis/${editingApi.id}`)
    },
    onError: (err: any) => {
      error('Failed to update API', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const submit = (data: EditApiFormData) => {
    // An empty address is left as it is rather than sent as "".
    update.mutate({
      ...data,
      baseUrl: isSdk || !data.baseUrl ? undefined : data.baseUrl,
      visibility: visibility.visibility,
      teamId: visibility.teamId,
    } as Partial<Api>)
  }

  return (
    <FormPage
      title="Edit API"
      description="Its name, address and who can use it. The key is on the API's page."
      back={{ to: `/apis/${editingApi.id}`, label: editingApi.name }}
      guard={guard}
      onSubmit={form.handleSubmit(submit)}
      submitLabel="Save changes"
      submitting={update.isPending}
    >
      <FormSection title="API">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="api-name" label="Name" error={errors.name?.message} required>
            <Input {...form.register('name')} />
          </Field>
          <Field id="api-version" label="Version (optional)">
            <Input placeholder="v1" {...form.register('version')} />
          </Field>
        </div>
        {!isSdk && (
          <Field id="api-base-url" label="Address" hint="Where calls go. Tools add their paths to it." error={errors.baseUrl?.message}>
            <Input placeholder="https://api.example.com/v1" {...form.register('baseUrl')} />
          </Field>
        )}
        <Field id="api-description" label="Description (optional)" error={errors.description?.message}>
          <Textarea {...form.register('description')} />
        </Field>
      </FormSection>

      <FormSection title="Who can use it">
        <VisibilityField organizationId={currentOrganization?.id ?? ''} value={visibility} onChange={setVisibility} noun="this API" />
      </FormSection>
    </FormPage>
  )
}
