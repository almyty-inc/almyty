/**
 * GatewayEditForm — the form for a gateway's name/endpoint/description/
 * status and who can see it. Rendered on its own page (/gateways/:id/edit),
 * not in a modal.
 *
 * Owns its own react-hook-form + zod validation. The page supplies the
 * current gateway and the submit handler that runs the update mutation.
 */
import React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'

import { Badge } from '@/components/ui/badge'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { Button } from '@/components/ui/button'
import { VisibilityField, type Visibility, type VisibilityValue } from '@/components/ui/visibility-field'
import { useOrganizationStore } from '@/store/organization'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  endpoint: z.string().min(1, 'Endpoint is required').transform(val => {
    // Auto-add leading slash if missing
    return val.startsWith('/') ? val : `/${val}`;
  }),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'maintenance', 'error']),
})

export type EditGatewayForm = z.infer<typeof editGatewaySchema>

export interface GatewayEditFormProps {
  gateway: any
  isSaving: boolean
  /** The form values, plus visibility/teamId when the picker was changed. */
  onSubmit: (data: EditGatewayForm & { visibility?: Visibility; teamId?: string | null }) => void
  onCancel: () => void
  isSystem?: boolean
}

/**
 * Protocol types that may be private (see PRIVATE_CAPABLE_GATEWAY_TYPES
 * on the backend): a chat channel's audience never signs in to almyty.
 */
const PRIVATE_CAPABLE = new Set(['mcp', 'utcp', 'skills', 'a2a', 'acp', 'openai_chat'])

export function GatewayEditForm({
  gateway,
  isSaving,
  onSubmit,
  onCancel,
  isSystem,
}: GatewayEditFormProps) {
  const { currentOrganization } = useOrganizationStore()
  const editForm = useForm<EditGatewayForm>({
    resolver: zodResolver(editGatewaySchema),
    values: {
      name: gateway?.name || '',
      endpoint: gateway?.endpoint || '',
      description: gateway?.description || '',
      status: gateway?.status || 'active',
    },
  })
  // Start from the gateway's stored scope so an unrelated edit keeps it.
  const stored: VisibilityValue = {
    visibility: (gateway?.visibility as Visibility) ?? 'org',
    teamId: gateway?.teamId ?? null,
  }
  const [visibility, setVisibility] = React.useState<VisibilityValue>(stored)
  React.useEffect(() => {
    setVisibility({ visibility: (gateway?.visibility as Visibility) ?? 'org', teamId: gateway?.teamId ?? null })
  }, [gateway?.id, gateway?.visibility, gateway?.teamId])
  const privateNotPossible = visibility.visibility === 'private' && !PRIVATE_CAPABLE.has(gateway?.type)
  const scopeChanged = visibility.visibility !== stored.visibility || visibility.teamId !== stored.teamId

  const submit = (data: EditGatewayForm) => {
    if (privateNotPossible) return
    onSubmit(scopeChanged ? { ...data, visibility: visibility.visibility, teamId: visibility.teamId } : data)
  }

  return (
        <form onSubmit={editForm.handleSubmit(submit)} className="space-y-6">
          <div>
            <Label htmlFor="edit-name">Gateway Name</Label>
            <Input
              id="edit-name"
              placeholder="Enter gateway name"
              {...editForm.register('name')}
            />
            {editForm.formState.errors.name && (
              <p className="text-sm text-red-500 mt-1">
                {editForm.formState.errors.name.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Type: {gateway?.type && <ProtocolBadge protocol={gateway.type} className="ml-1" />} (cannot be changed)
            </p>
          </div>

          <div>
            <Label htmlFor="edit-endpoint">Endpoint Path</Label>
            <Input
              id="edit-endpoint"
              placeholder="my-gateway"
              disabled={isSystem}
              {...editForm.register('endpoint')}
            />
            {editForm.formState.errors.endpoint && (
              <p className="text-sm text-red-500 mt-1">
                {editForm.formState.errors.endpoint.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              {isSystem
                ? 'System gateway endpoint cannot be changed'
                : 'The path for your gateway (slash is added automatically)'}
            </p>
          </div>

          <div>
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              placeholder="Enter gateway description"
              {...editForm.register('description')}
            />
          </div>

          <div>
            <Label htmlFor="edit-status">Status</Label>
            <Select
              onValueChange={(value) => editForm.setValue('status', value as any)}
              value={editForm.watch('status')}
            >
              <SelectTrigger id="edit-status">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="maintenance">Maintenance</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {!isSystem && (
            <div className="border-t pt-4">
              <VisibilityField
                organizationId={currentOrganization?.id ?? ''}
                value={visibility}
                onChange={setVisibility}
                noun="this gateway"
              />
              {privateNotPossible && (
                <p className="text-sm text-destructive mt-2">
                  A chat channel can't be private: the people it answers don't sign in to almyty.
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end space-x-2">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSaving || privateNotPossible}
            >
              {isSaving ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </form>
  )
}
