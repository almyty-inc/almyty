import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plug } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { mcpSourcesApi } from '@/lib/api'
import { useNotifications } from '@/store/app'

interface AddMcpServerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId?: string
}

/**
 * Register an external MCP server as a tool source. The backend runs
 * initialize + tools/list on create and materializes every remote tool
 * as an almyty tool (type "mcp").
 */
export function AddMcpServerDialog({ open, onOpenChange, organizationId }: AddMcpServerDialogProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [bearerToken, setBearerToken] = useState('')

  const resetForm = () => {
    setName('')
    setUrl('')
    setBearerToken('')
  }

  const createMutation = useMutation({
    mutationFn: () => {
      if (!organizationId) {
        return Promise.reject(new Error('No organization context'))
      }
      return mcpSourcesApi.create(organizationId, {
        name: name.trim(),
        url: url.trim(),
        ...(bearerToken.trim() ? { bearerToken: bearerToken.trim() } : {}),
      })
    },
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ['mcp-sources'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      if (result?.syncError) {
        notifications.error(
          'Server added, sync failed',
          `The MCP server was saved but tool discovery failed: ${result.syncError}`,
        )
      } else {
        const count = result?.sync?.total ?? 0
        notifications.success('MCP server added', `Discovered ${count} tool${count !== 1 ? 's' : ''}`)
      }
      resetForm()
      onOpenChange(false)
    },
    onError: (error: any) => {
      const msg =
        error.response?.data?.message ??
        error.response?.data?.error?.message ??
        error.message ??
        'Failed to add MCP server'
      notifications.error('Error', msg)
    },
  })

  const canSubmit = name.trim().length > 0 && url.trim().length > 0 && !createMutation.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          resetForm()
          createMutation.reset()
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-5 w-5 text-violet-500" />
            Add MCP Server
          </DialogTitle>
          <DialogDescription>
            Connect an external MCP server over streamable HTTP. Its tools are discovered
            automatically and become available to your agents like any other tool.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) createMutation.mutate()
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="mcp-source-name">Name</Label>
            <Input
              id="mcp-source-name"
              placeholder="e.g. weather-server"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Used as a prefix for the discovered tool names.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="mcp-source-url">Server URL</Label>
            <Input
              id="mcp-source-url"
              type="url"
              placeholder="https://mcp.example.com/mcp"
              value={url}
              maxLength={2000}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mcp-source-token">Auth token (optional)</Label>
            <Input
              id="mcp-source-token"
              type="password"
              placeholder="Bearer token, if the server requires auth"
              value={bearerToken}
              maxLength={4096}
              onChange={(e) => setBearerToken(e.target.value)}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Sent as an Authorization header. Stored encrypted.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {createMutation.isPending ? 'Connecting…' : 'Add Server'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
