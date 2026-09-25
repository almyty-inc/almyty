/**
 * GatewayEditForm -- a gateway's name, path, description and who can see
 * it. Rendered on its own page (/gateways/:id/edit), not in a modal. Pause
 * and resume live on the gateway's page as a switch, not here.
 *
 * Owns its react-hook-form + zod validation. The page supplies the
 * gateway, the save handler that runs the update mutation, and what
 * Cancel does. A failed submit marks the field and focuses it.
 */
import React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'

import { Field, FormSection, InlineFormActions, focusFirstInvalid } from '@/components/layout/form-page'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { VisibilityField, type Visibility, type VisibilityValue } from '@/components/ui/visibility-field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { PRIVATE_CAPABLE_GATEWAY_TYPES } from '@/components/gateways/schema'
import { useOrganizationStore } from '@/store/organization'

export const editGatewaySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  endpoint: z
    .string()
    .min(1, 'Endpoint is required')
    .transform((val) => (val.startsWith('/') ? val : `/${val}`)),
  description: z.string().optional(),
})

export type EditGatewayForm = z.infer<typeof editGatewaySchema>

export interface GatewayEditFormProps {
  gateway: any
  isSaving: boolean
  /** The form values, plus visibility/teamId when the picker was changed. */
  onSubmit: (data: EditGatewayForm & { visibility?: Visibility; teamId?: string | null }) => void
  onCancel: () => void
  isSystem?: boolean
  /** Called with true while the form holds unsaved edits, false once it does not. */
  onDirtyChange?: (dirty: boolean) => void
}

export function GatewayEditForm({ gateway, isSaving, onSubmit, onCancel, isSystem, onDirtyChange }: GatewayEditFormProps) {
  const { currentOrganization } = useOrganizationStore()
  const formRef = React.useRef<HTMLFormElement>(null)
  const form = useForm<EditGatewayForm>({
    resolver: zodResolver(editGatewaySchema),
    values: {
      name: gateway?.name || '',
      endpoint: gateway?.endpoint || '',
      description: gateway?.description || '',
    },
  })
  const { errors } = form.formState

  // Start from the gateway's stored scope so an unrelated edit keeps it.
  const stored: VisibilityValue = {
    visibility: (gateway?.visibility as Visibility) ?? 'org',
    teamId: gateway?.teamId ?? null,
  }
  const [visibility, setVisibility] = React.useState<VisibilityValue>(stored)
  React.useEffect(() => {
    setVisibility({ visibility: (gateway?.visibility as Visibility) ?? 'org', teamId: gateway?.teamId ?? null })
  }, [gateway?.id, gateway?.visibility, gateway?.teamId])
  // A chat channel's audience never signs in to almyty, so it can't be private.
  const privateNotPossible =
    visibility.visibility === 'private' && !PRIVATE_CAPABLE_GATEWAY_TYPES.has(gateway?.type)
  const scopeChanged = visibility.visibility !== stored.visibility || visibility.teamId !== stored.teamId
  // The page owns the leave guard (it also owns the navigation after a
  // save), so it is told whenever the form holds unsaved edits.
  const dirty = form.formState.isDirty || scopeChanged
  React.useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const submit = (data: EditGatewayForm) => {
    if (privateNotPossible) return
    onSubmit(scopeChanged ? { ...data, visibility: visibility.visibility, teamId: visibility.teamId } : data)
  }

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(e) =>
        form.handleSubmit(submit, () => requestAnimationFrame(() => focusFirstInvalid(formRef.current)))(e)
      }
      className="space-y-6"
      aria-label="Edit gateway"
    >
      <FormSection>
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

      </FormSection>

      {!isSystem && (
        <FormSection title="Who can use it">
          <VisibilityField
            organizationId={currentOrganization?.id ?? ''}
            value={visibility}
            onChange={setVisibility}
            noun="this gateway"
          />
          {privateNotPossible && (
            <p role="alert" className="text-sm text-destructive">
              A chat channel can't be private: the people it answers don't sign in to almyty.
            </p>
          )}
        </FormSection>
      )}

      <InlineFormActions
        onCancel={onCancel}
        submitLabel="Save changes"
        submitting={isSaving}
        submitDisabled={privateNotPossible}
      />
    </form>
  )
}
