import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Globe } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { PageHeader } from '@/components/layout/page-header'
import { PageIntro } from '@/components/onboarding/page-intro'
import { useNewParamRedirect } from '@/hooks/use-new-param-redirect'

import { getApiErrorMessage } from '@/lib/api-error'
import { apisApi } from '@/lib/api'
import { toolsQuery } from '@/lib/list-queries'
import { pluralized } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { Api } from '@/types'
import { ApisFilters } from '@/components/apis/apis-filters'
import { createApisColumns } from '@/components/apis/apis-columns'
import { TeamFilter, useTeamLookup, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'

export function ApisPage() {
  React.useEffect(() => {
    document.title = 'APIs | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()
  const { success, error, warning } = useNotifications()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // Get all tools to show accurate counts per API
  const { data: allToolsPage } = useQuery({
    ...toolsQuery(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  const allTools = allToolsPage?.items ?? []
  // "X generated" on the APIs page should only count tools that came
  // from an API operation, not custom JS/HTTP/SDK tools created
  // manually. operationId is the entity field that distinguishes them.
  const generatedToolsTotal = allTools.filter((t: any) => t.operationId).length

  const { confirm, dialog: confirmDialog } = useConfirm()
  // Old ?new=1 links (bookmarks, docs) land on the create page.
  useNewParamRedirect('/apis/new')
  const [searchQuery, setSearchQuery] = React.useState('')
  const [typeFilter, setTypeFilter] = React.useState('all')
  const [healthFilter, setHealthFilter] = React.useState('all')
  const [teamFilter, setTeamFilter] = React.useState<TeamFilterValue>('all')
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)

  const { data: apisData, isLoading, isError, error: apisError, refetch: refetchApis } = useQuery({
    queryKey: ['apis', currentOrganization?.id],
    queryFn: () => apisApi.getAll(),
    enabled: !!currentOrganization,
    refetchInterval: 60000,
  })

  const deleteApiMutation = useMutation({
    mutationFn: apisApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API deleted', 'API has been deleted successfully.')
    },
    onError: (err: any) => {
      error('Failed to delete API', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const generateToolsMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => apisApi.generateTools(id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['tools', currentOrganization?.id] })
      const generated = (result as any)?.generated ?? (Array.isArray(result) ? result.length : 0)
      const failed = (result as any)?.failed ?? 0
      if (failed > 0) {
        warning(
          'Some tools could not be generated',
          `${generated} created, ${failed} failed out of ${(result as any)?.total ?? generated + failed} operations.`,
        )
      } else {
        success('Tools generated', `${generated} tools have been generated successfully.`)
      }
    },
    onError: (err: any) => {
      error('Failed to generate tools', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // The result is said here rather than stashed for a panel to show.
  // It used to be kept in state whose only reader was a dialog nothing
  // opened, under a toast promising "results are available" -- so the
  // test ran, reported nothing, and pointed at a screen that did not
  // exist.
  const testApiMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => apisApi.testConnection(id),
    onSuccess: (result: any) => {
      const reachable = result?.success !== false
      const detail = [result?.statusCode, result?.responseTime ? `${result.responseTime}ms` : null]
        .filter(Boolean)
        .join(' · ')
      if (reachable) {
        success('Connection OK', detail || 'The API responded.')
      } else {
        error('Connection failed', result?.message || result?.error || 'The API did not respond.')
      }
    },
    onError: (err: any) => {
      error('Connection failed', getApiErrorMessage(err, 'The API did not respond.'))
    },
  })

  const apiColumns = createApisColumns({
    allTools,
    teamLookup,
    onEdit: (api) => navigate(`/apis/${api.id}/edit`),
    onDelete: async (api) => {
      const ok = await confirm({
        title: 'Delete API?',
        description: `This will permanently delete the API "${api.name}" and all associated tools and operations. This action cannot be undone.`,
        confirmLabel: 'Delete API',
        destructive: true,
      })
      if (ok) deleteApiMutation.mutate(api.id)
    },
    onViewDetails: (api) => navigate(`/apis/${api.id}`),
    onTestConnection: (api) => testApiMutation.mutate({ id: api.id }),
    onImportSchema: (api) => navigate(`/apis/${api.id}/import`),
    onGenerateTools: (api) => generateToolsMutation.mutate({ id: api.id }),
    onCopyBaseUrl: (api) => {
      navigator.clipboard.writeText(api.baseUrl)
      success('Copied', 'Base URL copied to clipboard')
    },
  })

  const apisExtracted = apisData?.apis || apisData || []
  const apis = Array.isArray(apisExtracted) ? apisExtracted : []

  const filteredApis = filterByTeamVisibility(apis as any[], teamFilter).filter((api: Api) => {
    const matchesSearch =
      api.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (api.description || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      api.baseUrl.toLowerCase().includes(searchQuery.toLowerCase())

    const matchesType = typeFilter === 'all' || api.type === typeFilter
    const matchesHealth = healthFilter === 'all' || api.healthStatus === healthFilter

    return matchesSearch && matchesType && matchesHealth
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="APIs"
        description={`${pluralized(apis.length, 'API', 'APIs')} · ${pluralized(apis.reduce((sum: number, a: any) => sum + (a.operationCount ?? a.operations?.length ?? 0), 0), 'operation')} · ${pluralized(generatedToolsTotal, 'tool')} generated`}
        actions={
          <Button asChild>
            <Link to="/apis/new">
              <Plus className="mr-2 h-4 w-4" />
              Connect an API
            </Link>
          </Button>
        }
      />
      <PageIntro topic="apis" />

      {isError ? (
        <QueryError error={apisError} onRetry={() => refetchApis()} title="Couldn't load APIs" />
      ) : !isLoading && apis.length === 0 ? (
        <EmptyState
          variant="panel"
          icon={Globe}
          title="No APIs yet"
          description="Import an OpenAPI, GraphQL, SOAP, or Protobuf schema — every operation becomes a typed tool."
          action={
            <Button asChild>
              <Link to="/apis/new">
                <Plus className="mr-2 h-4 w-4" />
                Connect an API
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <ApisFilters
                    searchQuery={searchQuery}
                    onSearchQueryChange={setSearchQuery}
                    typeFilter={typeFilter}
                    onTypeFilterChange={setTypeFilter}
                    healthFilter={healthFilter}
                    onHealthFilterChange={setHealthFilter}
                  />
                </div>
                <TeamFilter
                  organizationId={currentOrganization?.id}
                  value={teamFilter}
                  onChange={setTeamFilter}
                />
              </div>

              <DataTable
                columns={apiColumns}
                data={filteredApis}
                loading={isLoading}
                onRowClick={(api) => navigate(`/apis/${api.id}`)}
                hideSelectionCount
                hideColumnsButton
              />
            </CardContent>
          </Card>
        </>
      )}

      {confirmDialog}
    </div>
  )
}
