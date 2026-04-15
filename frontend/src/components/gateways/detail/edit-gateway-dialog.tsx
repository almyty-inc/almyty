/**
 * EditGatewayDialog — modal form for editing a gateway's name/endpoint/description/status.
 *
 * Owns its own react-hook-form + zod validation. Parent supplies the current
 * gateway, open state, and the submit handler that runs the update mutation.
 * Used by GatewayDetailPage's "Edit Gateway" button in the page header.
 */
import React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

export interface EditGatewayDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  gateway: any
  isSaving: boolean
  onSubmit: (data: EditGatewayForm) => void
  isSystem?: boolean
}

export function EditGatewayDialog({
  open,
  onOpenChange,
  gateway,
  isSaving,
  onSubmit,
  isSystem,
}: EditGatewayDialogProps) {
  const editForm = useForm<EditGatewayForm>({
    resolver: zodResolver(editGatewaySchema),
    values: {
      name: gateway?.name || '',
      endpoint: gateway?.endpoint || '',
      description: gateway?.description || '',
      status: gateway?.status || 'active',
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Gateway</DialogTitle>
          <DialogDescription>
            Update gateway settings. Note: only the gateway type (MCP/A2A/UTCP) cannot be changed after creation.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={editForm.handleSubmit(onSubmit)} className="space-y-6">
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
              Type: <Badge variant="outline" className="ml-1">{gateway?.type?.toUpperCase()}</Badge> (cannot be changed)
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

          <div className="flex justify-end space-x-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
