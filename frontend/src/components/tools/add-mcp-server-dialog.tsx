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
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { ConnectedChip } from '@/components/connections/connected-chip'
import { ConnectionSelect } from '@/components/connections/connection-select'
import type { Connection } from '@/types/connections'

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
  const [connection, setConnection] = useState<Connection | null>(null)

  const resetForm = () => {
    setName('')
    setUrl('')
    setBearerToken('')
    setConnection(null)
  }

  const createMutation = useMutation({
    mutationFn: () => {
      if (!organizationId) {
        return Promise.reject(new Error('No organization context'))
      }
      // A connection stands in for the pasted token: the backend resolves
      // the secret from the credential row it points at.
      const payload: Parameters<typeof mcpSourcesApi.create>[1] = {
        name: name.trim(),
        url: url.trim(),
        ...(connection ? { credentialId: connection.id } : bearerToken.trim() ? { bearerToken: bearerToken.trim() } : {}),
      }
      return mcpSourcesApi.create(organizationId, payload)
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
              disabled={!!connection}
            />
            <p className="text-xs text-muted-foreground">
              {connection
                ? 'The connection supplies the token; nothing is pasted here.'
                : 'Sent as an Authorization header. Stored encrypted.'}
            </p>
            {connection ? (
              <ConnectedChip connection={connection} onClear={() => setConnection(null)} />
            ) : (
              <>
                <ConnectionSelect
                  id="mcp-source-connection"
                  kind="mcp"
                  value=""
                  onChange={(next) => {
                    if (!next) return
                    setConnection(next)
                    setBearerToken('')
                  }}
                  helper="A connection made earlier, of kind MCP server."
                />
                <ConnectAccountButton
                  kind="mcp"
                  onConnected={(next) => {
                    setConnection(next)
                    setBearerToken('')
                  }}
                />
              </>
            )}
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
