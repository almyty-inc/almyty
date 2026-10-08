import { useEffect, useMemo } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { KeyRound, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DataTable, createSortableColumn } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { PageHeader } from '@/components/layout/page-header'
import { PageIntro } from '@/components/onboarding/page-intro'
import { ServiceIcon } from '@/components/connect/service-tiles'
import { StatusLabel } from '@/components/connect/status-label'
import { connectorIcon, useConnectors } from '@/components/connections/connect-flow'
import { useConnections } from '@/components/credentials/credential-detail'
import { asStoredCredentials, credentialRows, type CredentialRow } from '@/components/credentials/credential-rows'
import { CREDENTIALS_QUERY_KEY, addCredentialPath, credentialPath } from '@/components/credentials/paths'
import { useNewParamRedirect } from '@/hooks/use-new-param-redirect'
import { credentialsApi } from '@/lib/api'
import { formatRelativeTime, pluralized } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { llmProvidersQuery } from '@/lib/llm-providers-query'

/**
 * Credentials: every key, token and signed-in account almyty keeps for
 * you, in one table, and "Add credential". A key added anywhere else
 * (setting up an API, a tool, a channel, a memory account, connecting a
 * model provider on Models) lands here too, saying what uses it. Who can
 * use each one is set on its own page.
 */
export function CredentialsPage() {
  const [searchParams] = useSearchParams()

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
  if (returned) return <Navigate to={credentialPath(returned)} replace />

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
      <CredentialTable rows={rows} />
    </div>
  )
}

/** Both lists the Credentials page reads, and the model connections, as one set of rows. */
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

function CredentialTable({ rows }: { rows: ReturnType<typeof useCredentialRows> }) {
  const navigate = useNavigate()
  const columns = useMemo(() => credentialColumns(), [])

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
  return (
    <Card>
      <CardContent className="pt-6" data-testid="credentials-table">
        <DataTable
          columns={columns}
          data={rows.data}
          loading={rows.isLoading}
          onRowClick={(row: CredentialRow) => navigate(row.href)}
          searchKey="name"
          searchPlaceholder="Search credentials"
          hideSelectionCount
          hideColumnsButton
        />
      </CardContent>
    </Card>
  )
}

function credentialColumns(): ColumnDef<CredentialRow, any>[] {
  return [
    {
      ...createSortableColumn('name', 'Name'),
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-3">
          <ServiceIcon size="md">{connectorIcon({ key: row.original.connectorKey ?? 'other', providerType: row.original.kind === 'inference' ? row.original.connectorKey ?? undefined : undefined, displayName: row.original.service })}</ServiceIcon>
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
        return <span className="text-sm" data-testid="credential-used-by">{uses.length === 1 ? uses[0].label : pluralized(uses.length, 'place')}</span>
      },
    },
    {
      id: 'added',
      header: 'Added',
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{row.original.createdAt ? formatRelativeTime(row.original.createdAt) : ''}</span>,
    },
  ]
}
