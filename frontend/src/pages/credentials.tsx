import { useEffect, useMemo } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { KeyRound, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable, createSortableColumn } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/layout/page-header'
import { PageIntro } from '@/components/onboarding/page-intro'
import { ServiceIcon } from '@/components/connect/service-tiles'
import { StatusLabel } from '@/components/connect/status-label'
import { connectorIcon, useConnectors } from '@/components/connections/connect-flow'
import { useConnections } from '@/components/credentials/credential-detail'
import { ConnectionsAdvanced } from '@/components/connections/connections-advanced'
import { asStoredCredentials, credentialRows, type CredentialRow } from '@/components/credentials/credential-rows'
import { CREDENTIALS_ADVANCED_PATH, CREDENTIALS_PATH, CREDENTIALS_QUERY_KEY, addCredentialPath, credentialPath } from '@/components/credentials/paths'
import { useNewParamRedirect } from '@/hooks/use-new-param-redirect'
import { useOrganizationRole } from '@/hooks/use-organization-role'
import { credentialsApi } from '@/lib/api'
import { formatRelativeTime, pluralized } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { connectProviderPath } from '@/components/llm-providers/paths'
import { llmProvidersQuery } from '@/lib/llm-providers-query'

/**
 * Credentials: every key, token and signed-in account almyty keeps for you,
 * in one table, with model provider keys as their own group. A key added
 * anywhere else (setting up an API, a tool, a channel, a memory account)
 * lands here too. Admins get Advanced: who may use each credential,
 * personal keys, custom services and the organization's rules.
 */
export function CredentialsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { canManage } = useOrganizationRole()
  const advanced = location.pathname.startsWith(CREDENTIALS_ADVANCED_PATH)

  // Old `?new=1` links land on the add page.
  useNewParamRedirect(addCredentialPath())

  useEffect(() => {
    document.title = 'Credentials | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const rows = useCredentialRows()

  // A sign-in at a service comes back as /credentials?connection=<id>&status=...
  const returned = searchParams.get('connection')
  if (returned && !advanced) return <Navigate to={credentialPath(returned)} replace />

  const count = rows.data.length
  return (
    <div className="space-y-6">
      <PageHeader
        title="Credentials"
        description={rows.isLoading ? 'Keys, tokens and accounts almyty uses for you' : pluralized(count, 'credential')}
        actions={
          <Button asChild>
            <Link to={addCredentialPath()}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              Add credential
            </Link>
          </Button>
        }
      />
      <PageIntro topic="credentials" />
      {canManage && (
        <Tabs value={advanced ? 'advanced' : 'all'} onValueChange={(t) => navigate(t === 'advanced' ? CREDENTIALS_ADVANCED_PATH : CREDENTIALS_PATH)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {advanced ? canManage ? <ConnectionsAdvanced /> : <Navigate to={CREDENTIALS_PATH} replace /> : <CredentialLists rows={rows} />}
    </div>
  )
}

/** Both lists the Credentials page reads, as one set of rows. */
function useCredentialRows() {
  const connectionsQuery = useConnections()
  const connectorsQuery = useConnectors()
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const storedQuery = useQuery({
    queryKey: [...CREDENTIALS_QUERY_KEY, orgId],
    queryFn: async () => asStoredCredentials(await credentialsApi.getAll()),
    enabled: !!orgId,
  })
  // Model provider connections, one row each, keyless ones included.
  const providersQuery = useQuery({ ...llmProvidersQuery, enabled: !!orgId })
  const data = useMemo(
    () => credentialRows(connectionsQuery.data ?? [], storedQuery.data ?? [], connectorsQuery.data ?? [], providersQuery.data ?? []),
    [connectionsQuery.data, storedQuery.data, connectorsQuery.data, providersQuery.data],
  )
  return {
    data,
    isLoading: connectionsQuery.isLoading,
    isError: connectionsQuery.isError,
    error: connectionsQuery.error,
    refetch: () => {
      connectionsQuery.refetch()
      storedQuery.refetch()
      providersQuery.refetch()
    },
  }
}

function CredentialLists({ rows }: { rows: ReturnType<typeof useCredentialRows> }) {
  const navigate = useNavigate()
  const columns = useMemo(() => credentialColumns(), [])
  const others = rows.data.filter((r) => r.group === 'other')
  const models = rows.data.filter((r) => r.group === 'models')

  if (rows.isError) return <QueryError error={rows.error} onRetry={rows.refetch} title="Couldn't load your credentials" />
  if (!rows.isLoading && rows.data.length === 0) {
    return (
      <EmptyState
        variant="panel"
        icon={KeyRound}
        title="No credentials yet"
        description="Add a key or sign in to a service once, and use it in any API, tool, agent or channel."
        action={
          <Button asChild>
            <Link to={addCredentialPath()}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              Add credential
            </Link>
          </Button>
        }
      />
    )
  }
  const open = (row: CredentialRow) => navigate(row.href)
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6" data-testid="credentials-table">
          <DataTable
            columns={columns}
            data={others}
            loading={rows.isLoading}
            onRowClick={open}
            searchKey="name"
            searchPlaceholder="Search credentials"
            hideSelectionCount
            hideColumnsButton
            emptyState={<EmptyState variant="inline" icon={KeyRound} title="No credentials yet" description="Model providers are listed below." />}
          />
        </CardContent>
      </Card>
      <Card data-testid="model-provider-credentials">
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="text-base">Model providers</CardTitle>
            <CardDescription>
              One connection per key, as many per provider as you like, each with the models it offers. Every model they reach is in the{' '}
              <Link to="/models" className="text-primary hover:underline">
                Models catalog
              </Link>
              .
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link to={connectProviderPath()}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              Connect a provider
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={models}
            loading={rows.isLoading}
            onRowClick={open}
            hideSelectionCount
            hideColumnsButton
            emptyState={<EmptyState variant="inline" title="No model providers yet" description="Connect OpenAI, Anthropic, Ollama Cloud or any other provider with its key." />}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function credentialColumns(): ColumnDef<CredentialRow, any>[] {
  return [
    {
      ...createSortableColumn('name', 'Name'),
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-3">
          <ServiceIcon size="md">{connectorIcon(row.original.connectorKey ? { key: row.original.connectorKey, kind: row.original.kind ?? 'tool_source' } : { key: 'other', kind: 'tool_source' })}</ServiceIcon>
          <span className="truncate font-medium">{row.original.name}</span>
        </div>
      ),
    },
    { accessorKey: 'service', header: 'Service', cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.service}</span> },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => <StatusLabel check={row.original.check} testId="credential-status" />,
    },
    { accessorKey: 'who', header: 'Who can use it', cell: ({ row }) => <span className="text-sm">{row.original.who}</span> },
    {
      id: 'uses',
      header: 'Used by',
      cell: ({ row }) => {
        const uses = row.original.uses
        if (uses.length === 0) return <span className="text-sm text-muted-foreground">Nothing yet</span>
        return <span className="text-sm">{uses.length === 1 ? uses[0].label : pluralized(uses.length, 'place')}</span>
      },
    },
    {
      id: 'added',
      header: 'Added',
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.createdAt ? formatRelativeTime(row.original.createdAt) : ''}</span>,
    },
  ]
}
