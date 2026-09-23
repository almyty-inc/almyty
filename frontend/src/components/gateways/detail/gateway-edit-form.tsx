/**
 * GatewayEditForm -- the gateway's name, path, description and status,
 * edited in place on the gateway's page.
 *
 * Owns its react-hook-form + zod validation. The page supplies the
 * gateway, the save handler that runs the update mutation, and what
 * Cancel does (close the section).
 */
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'

import { Field, InlineFormActions } from '@/components/layout/form-page'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

export const editGatewaySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  endpoint: z
    .string()
    .min(1, 'Endpoint is required')
    .transform((val) => (val.startsWith('/') ? val : `/${val}`)),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'maintenance', 'error']),
})

export type EditGatewayForm = z.infer<typeof editGatewaySchema>

export interface GatewayEditFormProps {
  gateway: any
  isSaving: boolean
  onSubmit: (data: EditGatewayForm) => void
  onCancel: () => void
  isSystem?: boolean
}

export function GatewayEditForm({ gateway, isSaving, onSubmit, onCancel, isSystem }: GatewayEditFormProps) {
  const form = useForm<EditGatewayForm>({
    resolver: zodResolver(editGatewaySchema),
    values: {
      name: gateway?.name || '',
      endpoint: gateway?.endpoint || '',
      description: gateway?.description || '',
      status: gateway?.status || 'active',
    },
  })
  const { errors } = form.formState

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(onSubmit)}
      className="space-y-4"
      aria-label="Edit gateway"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          id="edit-name"
          label="Name"
          required
          hint={
            <span className="inline-flex items-center gap-1">
              Protocol {gateway?.type && <ProtocolBadge protocol={gateway.type} />} (cannot be changed)
            </span>
          }
          error={errors.name?.message}
        >
          <Input placeholder="Enter gateway name" autoComplete="off" {...form.register('name')} />
        </Field>

        <Field
          id="edit-endpoint"
          label="Endpoint path"
          required
          hint={
            isSystem
              ? 'A system gateway keeps its endpoint.'
              : 'The path after your organization in the gateway URL. The slash is added for you.'
          }
          error={errors.endpoint?.message}
        >
          <Input placeholder="my-gateway" autoComplete="off" disabled={isSystem} {...form.register('endpoint')} />
        </Field>
      </div>

      <Field id="edit-description" label="Description">
        <Textarea placeholder="What this gateway is for" rows={3} {...form.register('description')} />
      </Field>

      <Field id="edit-status" label="Status" hint="Only an active gateway answers requests.">
        <Select
          onValueChange={(value) => form.setValue('status', value as EditGatewayForm['status'], { shouldDirty: true })}
          value={form.watch('status')}
        >
          <SelectTrigger id="edit-status" className="sm:max-w-xs">
            <SelectValue placeholder="Select status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="maintenance">Maintenance</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <InlineFormActions onCancel={onCancel} submitLabel="Save changes" submitting={isSaving} />
    </form>
  )
}
