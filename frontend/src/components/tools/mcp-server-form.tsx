/**
 * tools/mcp-server-form -- register an external MCP server as a tool
 * source (`/tools/mcp-servers/new`).
 *
 * The backend runs initialize + tools/list on create and materializes
 * every remote tool as an almyty tool (type "mcp"), so after saving the
 * tools list is where the result shows.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { OTHER_SERVICE_KEY } from '@/components/connections/connect-flow'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { mcpSourcesApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import type { Connection } from '@/types/connections'
import { pluralized } from '@/lib/utils'

function isHttpUrl(value: string) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function McpServerForm({ organizationId }: { organizationId?: string }) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [connection, setConnection] = useState<Connection | null>(null)
  const [errors, setErrors] = useState<{ name?: string; url?: string }>({})

  const guard = useLeaveGuard(name !== '' || url !== '' || !!connection)

  const createMutation = useMutation({
    mutationFn: () => {
      if (!organizationId) {
        return Promise.reject(new Error('No organization context'))
      }
      // The token is a credential: the backend resolves the secret from the
      // credential row it points at, so nothing secret is kept on the server row.
      const payload: Parameters<typeof mcpSourcesApi.create>[1] = {
        name: name.trim(),
        url: url.trim(),
        ...(connection ? { credentialId: connection.id } : {}),
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
        notifications.success('MCP server added', `Discovered ${pluralized(count, 'tool')}`)
      }
      guard.leave('/tools')
    },
    onError: (error: any) => {
      notifications.error('Error', getApiErrorMessage(error, 'Failed to add MCP server'))
    },
  })

  const handleSubmit = () => {
    const next: { name?: string; url?: string } = {}
    if (!name.trim()) next.name = 'Give the server a name.'
    if (!isHttpUrl(url.trim())) next.url = 'Enter the http(s) URL of the MCP endpoint.'
    setErrors(next)
    if (next.name || next.url) return
    createMutation.mutate()
  }

  return (
    <FormPage
      title="Add MCP server"
      description="Connect an external MCP server over streamable HTTP. Its tools are discovered automatically and become available to your agents like any other tool."
      back={{ to: '/tools', label: 'Tools' }}
      guard={guard}
      onSubmit={handleSubmit}
      submitLabel={createMutation.isPending ? 'Connecting…' : 'Add server'}
      submitting={createMutation.isPending}
      width="narrow"
    >
      <FormSection title="Server">
        <Field id="mcp-source-name" label="Name" hint="Used as a prefix for the discovered tool names." error={errors.name} required>
          <Input
            placeholder="e.g. weather-server"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field id="mcp-source-url" label="Server URL" hint="The server's streamable HTTP endpoint." error={errors.url} required>
          <Input
            type="url"
            placeholder="https://mcp.example.com/mcp"
            value={url}
            maxLength={2000}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
      </FormSection>

      <FormSection title="Authentication" description="Only if the server requires it.">
        <CredentialPicker
          id="mcp-source-token"
          label="Token or sign-in (optional)"
          value={connection?.id ?? ''}
          onChange={setConnection}
          allowNone
          placeholder="None"
          connectorKey={OTHER_SERVICE_KEY}
          defaultName={name.trim() ? `${name.trim()} token` : undefined}
          hint="A token is sent as a bearer token. For a server that asks you to sign in, sign in on Credentials first (MCP server, then Sign in to the server) and pick that here; it is kept fresh for you."
        />
      </FormSection>
    </FormPage>
  )
}
