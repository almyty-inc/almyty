/**
 * Connections > Advanced, for admins: exactly who may use each connection
 * (grants), whether members may keep keys of their own, custom services,
 * and the organization's rules (policies, review, expiry). Nothing here is
 * needed to connect a service.
 */
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ConnectionsGovernanceSection } from '@/components/connections-governance/governance-section'
import { organizationsApi } from '@/lib/api'
import { allowUserScopedConnections, connectionSettingsApi, errorMessage, isCustomConnector } from '@/lib/connections-api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { useConnectors } from './connect-flow'
import { useConnections } from './connection-detail'
import { GrantsEditor } from './grants-editor'
import { CONNECTIONS_PATH, connectServicePath } from './paths'

export function ConnectionsAdvanced() {
  const [searchParams, setSearchParams] = useSearchParams()
  const connectionsQuery = useConnections()
  const connectorsQuery = useConnectors()
  // A private connection is its owner's alone and cannot be shared.
  const shareable = useMemo(() => (connectionsQuery.data ?? []).filter((c) => c.owner !== 'private'), [connectionsQuery.data])
  const custom = useMemo(() => (connectorsQuery.data ?? []).filter(isCustomConnector), [connectorsQuery.data])
  const selected = searchParams.get('connection') ?? ''
  const selectedConnection = shareable.find((c) => c.id === selected) ?? null

  const select = (id: string) => {
    const params = new URLSearchParams(searchParams)
    params.set('connection', id)
    setSearchParams(params, { replace: true })
  }

  return (
    <div className="space-y-6" data-testid="connections-advanced">
      <Card id="access">
        <CardHeader>
          <CardTitle className="text-base">Who can use each connection</CardTitle>
          <CardDescription>A new connection is open to everyone in the organization. Narrow it to people, teams, roles or agents here.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-sm space-y-1.5">
            <Label htmlFor="advanced-connection">Connection</Label>
            <Select value={selectedConnection ? selected : ''} onValueChange={select}>
              <SelectTrigger id="advanced-connection">
                <SelectValue placeholder={shareable.length === 0 ? 'Nothing shared yet' : 'Pick a connection'} />
              </SelectTrigger>
              <SelectContent>
                {shareable.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedConnection && <GrantsEditor key={selectedConnection.id} connectionId={selectedConnection.id} />}
        </CardContent>
      </Card>

      <PersonalKeys />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Custom services</CardTitle>
              <CardDescription>Services the list does not have: any OpenAI-compatible endpoint, MCP server, memory service or bucket.</CardDescription>
            </div>
            <Button variant="outline" size="sm" asChild className="gap-1.5">
              <Link to={`${CONNECTIONS_PATH}/custom/new`}>
                <Plus className="h-4 w-4" aria-hidden />
                Add a custom service
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {custom.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="divide-y rounded-md border" data-testid="custom-services">
              {custom.map((c) => (
                <li key={c.key} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="truncate font-medium">{c.displayName}</span>
                  <Link to={connectServicePath(c.key)} className="text-primary hover:underline">
                    Connect
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConnectionsGovernanceSection />
    </div>
  )
}

function PersonalKeys() {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const orgQuery = useQuery({
    queryKey: ['organization-details', orgId],
    queryFn: () => organizationsApi.getById(orgId!),
    enabled: !!orgId,
  })
  const allowed = allowUserScopedConnections(orgQuery.data)
  const toggle = useMutation({
    mutationFn: (allow: boolean) => connectionSettingsApi.setAllowUserScopedConnections(orgId!, allow),
    onSuccess: (_result, allow) => {
      queryClient.invalidateQueries({ queryKey: ['organization-details', orgId] })
      notifications.success(allow ? 'Personal keys allowed' : 'Personal keys off', allow ? 'Members can connect keys only they can use.' : 'Only organization connections can be made.')
    },
    onError: (error: unknown) => notifications.error('Could not save', errorMessage(error, 'The setting was not changed.')),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Personal keys</CardTitle>
        <CardDescription>Let members connect keys only they can use, next to the organization&apos;s shared ones.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <Switch id="allow-user-scoped" checked={allowed} onCheckedChange={(v) => toggle.mutate(v)} disabled={!orgId || toggle.isPending || orgQuery.isLoading} aria-label="Allow personal keys" />
          <Label htmlFor="allow-user-scoped" className="font-normal">
            {allowed ? 'Members may connect their own keys' : 'Only organization connections'}
          </Label>
        </div>
      </CardContent>
    </Card>
  )
}
