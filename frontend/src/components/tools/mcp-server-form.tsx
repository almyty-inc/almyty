/**
 * tools/mcp-server-form -- register an external MCP server as a tool
 * source (`/tools/mcp-servers/new`).
 *
 * The backend runs initialize + tools/list on create and materializes
 * every remote tool as an almyty tool (type "mcp"), so after saving the
 * tools list is where the result shows.
 *
 * Authentication is a token (a credential, picked or made inline) or a
 * sign-in at the server (OAuth): the same MCP sign-in Credentials uses,
 * inline. Once the URL is entered the server is asked which it wants;
 * a server that publishes where to sign in gets sign-in by default. A
 * finished sign-in goes straight on to adding the server and discovering
 * its tools.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Loader2, LogIn } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { OptionList } from '@/components/ui/option-list'
import { ConnectServiceForm, OTHER_SERVICE_KEY, useConnectors } from '@/components/connections/connect-flow'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { mcpSourcesApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import type { Connection } from '@/types/connections'
import { pluralized } from '@/lib/utils'

/** The catalog's MCP server service, whose "Sign in to the server" is the MCP OAuth sign-in. */
const MCP_CONNECTOR_KEY = 'mcp-custom'
const SIGN_IN_METHOD = 'oauth2_pkce'

type AuthMode = 'sign_in' | 'token'

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
  const [token, setToken] = useState<Connection | null>(null)
  const [signedIn, setSignedIn] = useState<Connection | null>(null)
  // Picked by hand; until then the server's answer decides.
  const [chosenMode, setChosenMode] = useState<AuthMode | null>(null)
  const [checkedUrl, setCheckedUrl] = useState('')
  const [errors, setErrors] = useState<{ name?: string; url?: string; auth?: string }>({})

  const guard = useLeaveGuard(name !== '' || url !== '' || !!token || !!signedIn)

  // Whether the server wants a sign-in: asked once the URL is entered.
  const authCheck = useQuery({
    queryKey: ['mcp-auth-check', organizationId, checkedUrl],
    queryFn: () => mcpSourcesApi.checkAuth(organizationId!, checkedUrl),
    enabled: !!organizationId && isHttpUrl(checkedUrl),
    staleTime: 60_000,
    retry: false,
  })
  const detected = authCheck.data?.auth
  const mode: AuthMode = chosenMode ?? (detected === 'sign_in' ? 'sign_in' : 'token')

  const createMutation = useMutation({
    mutationFn: (credentialId: string | undefined) => {
      if (!organizationId) {
        return Promise.reject(new Error('No organization context'))
      }
      // The token or sign-in is a credential: the backend resolves the secret
      // from the credential row it points at, so nothing secret is kept on the server row.
      const payload: Parameters<typeof mcpSourcesApi.create>[1] = {
        name: name.trim(),
        url: url.trim(),
        ...(credentialId ? { credentialId } : {}),
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

  const validate = () => {
    const next: { name?: string; url?: string } = {}
    if (!name.trim()) next.name = 'Give the server a name.'
    if (!isHttpUrl(url.trim())) next.url = 'Enter the http(s) URL of the MCP endpoint.'
    return next
  }

  const handleSubmit = () => {
    const next: { name?: string; url?: string; auth?: string } = validate()
    if (mode === 'sign_in' && !signedIn) next.auth = 'Sign in to the server first.'
    setErrors(next)
    if (next.name || next.url || next.auth) return
    createMutation.mutate(mode === 'sign_in' ? signedIn!.id : token?.id)
  }

  // A finished sign-in adds the server and discovers its tools straight away.
  const handleSignedIn = (connection: Connection) => {
    setSignedIn(connection)
    const next = validate()
    setErrors(next)
    if (next.name || next.url) return
    createMutation.mutate(connection.id)
  }

  const trimmedUrl = url.trim()

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
            onBlur={() => setCheckedUrl(url.trim())}
          />
        </Field>
      </FormSection>

      <FormSection title="Authentication" description="Only if the server requires it.">
        <OptionList<AuthMode>
          label="How almyty signs in to the server"
          value={mode}
          onChange={(value) => {
            setChosenMode(value)
            setErrors((prev) => ({ ...prev, auth: undefined }))
          }}
          testIdPrefix="mcp-auth"
          options={[
            { value: 'sign_in', label: 'Sign in to the server', hint: 'For a server that asks you to sign in (OAuth). The sign-in is kept fresh for you.', icon: <LogIn className="h-4 w-4" aria-hidden /> },
            { value: 'token', label: 'Token', hint: 'Sent as a bearer token. Leave it empty for a server that needs none.', icon: <KeyRound className="h-4 w-4" aria-hidden /> },
          ]}
        />
        <AuthCheckLine checking={authCheck.isFetching} detected={detected} />

        {mode === 'token' && (
          <CredentialPicker
            id="mcp-source-token"
            label="Token (optional)"
            value={token?.id ?? ''}
            onChange={setToken}
            allowNone
            placeholder="None"
            connectorKey={OTHER_SERVICE_KEY}
            defaultName={name.trim() ? `${name.trim()} token` : undefined}
            hint="Picked from Credentials, or made here."
          />
        )}

        {mode === 'sign_in' && (
          <div className="space-y-3" data-testid="mcp-sign-in">
            {errors.auth && (
              <p role="alert" className="text-sm text-destructive">
                {errors.auth}
              </p>
            )}
            {signedIn ? (
              <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="mcp-signed-in">
                <span>Signed in as {signedIn.accountLabel || signedIn.name}.</span>
                <Button type="button" variant="outline" size="sm" onClick={() => setSignedIn(null)} disabled={createMutation.isPending}>
                  Sign in again
                </Button>
              </div>
            ) : !isHttpUrl(trimmedUrl) ? (
              <p className="text-sm text-muted-foreground">Enter the server URL first.</p>
            ) : (
              <McpSignIn
                key={trimmedUrl}
                serverUrl={trimmedUrl}
                credentialName={name.trim() ? `${name.trim()} sign-in` : ''}
                onNameMissing={() => setErrors((prev) => ({ ...prev, name: 'Give the server a name.' }))}
                onConnected={handleSignedIn}
              />
            )}
          </div>
        )}
      </FormSection>
    </FormPage>
  )
}

/** One line on what the server said when asked, under the choice. */
function AuthCheckLine({ checking, detected }: { checking: boolean; detected?: 'sign_in' | 'token' | 'none' | 'unknown' }) {
  if (checking) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="mcp-auth-check">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Asking the server how to sign in…
      </p>
    )
  }
  const text =
    detected === 'sign_in'
      ? 'This server asks you to sign in.'
      : detected === 'token'
        ? 'This server asks for a token. It does not say where to sign in.'
        : detected === 'none'
          ? 'This server answered without asking for a token.'
          : null
  if (!text) return null
  return (
    <p className="text-xs text-muted-foreground" data-testid="mcp-auth-check">
      {text}
    </p>
  )
}

/** The MCP sign-in from Credentials, inline, on the address the page already has. */
function McpSignIn({ serverUrl, credentialName, onNameMissing, onConnected }: { serverUrl: string; credentialName: string; onNameMissing: () => void; onConnected: (connection: Connection) => void }) {
  const connectors = useConnectors()
  const connector = connectors.data?.find((c) => c.key === MCP_CONNECTOR_KEY)
  if (connectors.isLoading) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />
  }
  if (!connector || !connector.connect.some((m) => m.type === SIGN_IN_METHOD)) {
    return <p className="text-sm text-muted-foreground">Signing in to MCP servers is not available here. Use a token.</p>
  }
  return (
    <ConnectServiceForm
      connector={connector}
      embedded
      onlyMethod={SIGN_IN_METHOD}
      fixedValues={{ serverUrl }}
      name={credentialName}
      onNameMissing={onNameMissing}
      onConnected={onConnected}
    />
  )
}