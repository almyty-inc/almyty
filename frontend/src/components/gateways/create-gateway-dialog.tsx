import React from 'react'
import { UseFormReturn } from 'react-hook-form'
import { UseMutationResult } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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

interface CreateGatewayDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  createForm: UseFormReturn<any>
  onSubmit: (data: any) => void
  createGatewayMutation: UseMutationResult<any, any, any, any>
}

export function CreateGatewayDialog({
  open,
  onOpenChange,
  createForm,
  onSubmit,
  createGatewayMutation,
}: CreateGatewayDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(openVal) => {
      onOpenChange(openVal)
      if (!openVal) {
        createForm.reset()
      }
    }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create New Gateway</DialogTitle>
          <DialogDescription>
            Create a new gateway to expose your tools via different protocols.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={createForm.handleSubmit(onSubmit)} className="space-y-6">
          <div>
            <Label htmlFor="name">Gateway Name</Label>
            <Input
              id="name"
              placeholder="Enter gateway name"
              {...createForm.register('name')}
            />
            {createForm.formState.errors.name && (
              <p className="text-sm text-red-500 mt-1">
                {(createForm.formState.errors.name as any).message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="type">Gateway Type</Label>
            <Select
              onValueChange={(value) => createForm.setValue('type', value)}
              value={createForm.watch('type')}
            >
              <SelectTrigger id="type" aria-label="Gateway Type">
                <SelectValue placeholder="Select gateway type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mcp">MCP - Model Context Protocol</SelectItem>
                <SelectItem value="a2a">A2A - Agent-to-Agent</SelectItem>
                <SelectItem value="utcp">UTCP - Universal Tool Call Protocol</SelectItem>
                <SelectItem value="skills">Skills - Agent Skills (SKILL.md)</SelectItem>
              </SelectContent>
            </Select>
            {createForm.formState.errors.type && (
              <p className="text-sm text-red-500 mt-1">
                {(createForm.formState.errors.type as any).message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="endpoint">Endpoint Path</Label>
            <Input
              id="endpoint"
              placeholder="/my-gateway"
              {...createForm.register('endpoint')}
            />
            {createForm.formState.errors.endpoint && (
              <p className="text-sm text-red-500 mt-1">
                {(createForm.formState.errors.endpoint as any).message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="description">Description (Optional)</Label>
            <Textarea
              id="description"
              placeholder="Enter gateway description"
              {...createForm.register('description')}
            />
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
              disabled={createGatewayMutation.isPending}
            >
              {createGatewayMutation.isPending ? 'Creating...' : 'Create Gateway'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
