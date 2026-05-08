import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Globe } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/ui/data-table'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { useCreateDeepLink } from '@/hooks/use-create-deep-link'
import { SchemaImportDialog } from '@/components/SchemaImportDialog'

import { apisApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { Api, ApiType } from '@/types'
import { ApiDetailDialog } from '@/components/apis/api-detail-dialog'
import { ApisFilters } from '@/components/apis/apis-filters'
import { createApisColumns } from '@/components/apis/apis-columns'
import { CreateApiDialog } from '@/components/apis/create-api-dialog'
import { TeamFilter, useTeamLookup, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'
import type { ImportSchemaFormData } from '@/components/apis/schema'

export function ApisPage() {
  React.useEffect(() => {
    document.title = 'APIs | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // Get all tools to show accurate counts per API
  const { data: allToolsData } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: () => import('@/lib/api').then(m => m.toolsApi.getAll(currentOrganization?.id)),
    enabled: !!currentOrganization,
  })

  const allToolsExtracted = allToolsData?.tools || allToolsData || []
  const allTools = Array.isArray(allToolsExtracted) ? allToolsExtracted : []
  const allToolsTotal = allToolsData?.total ?? allTools.length

  const [selectedApi, setSelectedApi] = React.useState<Api | null>(null)
  const [editingApi, setEditingApi] = React.useState<Api | null>(null)
  const [deletingApi, setDeletingApi] = React.useState<Api | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false)
  // Honour ?new=1 from the command palette Create API action.
  useCreateDeepLink(setCreateDialogOpen)
  const [uploadDialogOpen, setUploadDialogOpen] = React.useState(false)
  const [apiDetailsOpen, setApiDetailsOpen] = React.useState(false)
  const [testResults, setTestResults] = React.useState<any>(null)
  const [uploadFile, setUploadFile] = React.useState<File | null>(null)
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

  const { data: apiOperations } = useQuery({
    queryKey: ['api-operations', selectedApi?.id],
    queryFn: () => selectedApi ? apisApi.getOperations(selectedApi.id) : null,
    enabled: !!selectedApi,
  })

  const deleteApiMutation = useMutation({
    mutationFn: apisApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      success('API deleted', 'API has been deleted successfully.')
      setApiDetailsOpen(false)
      setDeletingApi(null)
    },
    onError: (err: any) => {
      error('Failed to delete API', err.response?.data?.message || 'Please try again.')
    },
  })

  const importSchemaMutation = useMutation({
    mutationFn: async ({ id, data, file }: { id: string; data: any; file?: File }) => {
      const importResult = await apisApi.importSchema(id, data, file)

      // If response contains jobId, poll for completion
      if (importResult?.jobId) {
        try {
          return await apisApi.pollImportStatus(id, importResult.jobId)
        } catch (pollError) {
          console.error('Schema import polling failed:', pollError)
          throw pollError
        }
      }

      return importResult
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['api-operations'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['tools', currentOrganization?.id] })
      // Force refetch for currently displayed API operations
      if (selectedApi) {
        queryClient.refetchQueries({ queryKey: ['api-operations', selectedApi.id] })
      }
      // Handle both direct result and async job result formats
      // For async jobs: result.result contains the job's returnvalue
      const jobResult = result?.result || result
      const opCount = jobResult?.operations?.length || jobResult?.operationCount || 0
      const toolCount = jobResult?.tools?.length || jobResult?.toolCount || 0
      success('Schema imported', `Schema imported successfully. ${opCount} operations found, ${toolCount} tools generated.`)
      setUploadDialogOpen(false)
      setUploadFile(null)
    },
    onError: (err: any) => {
      error('Failed to import schema', err.response?.data?.message || err.message || 'Please try again.')
    },
  })

  const generateToolsMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => apisApi.generateTools(id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['tools', currentOrganization?.id] })
      const toolCount = Array.isArray(result) ? result.length : 0
      success('Tools generated', `${toolCount} tools have been generated successfully.`)
    },
    onError: (err: any) => {
      error('Failed to generate tools', err.response?.data?.message || 'Please try again.')
    },
  })

  const testApiMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => apisApi.testConnection(id),
    onSuccess: (result) => {
      setTestResults(result)
      success('API test completed', 'Connection test results are available.')
    },
    onError: (err: any) => {
      setTestResults({ error: err.response?.data?.message || 'Test failed' })
      error('API test failed', err.response?.data?.message || 'Please try again.')
    },
  })

  const handleImportSchema = (data: ImportSchemaFormData) => {
    if (!selectedApi) return

    importSchemaMutation.mutate({
      id: selectedApi.id,
      data,
      file: uploadFile || undefined
    })
  }

  const apiColumns = createApisColumns({
    allTools,
    teamLookup,
    onEdit: (api) => {
      setEditingApi(api)
      setCreateDialogOpen(true)
    },
    onDelete: (api) => setDeletingApi(api),
    onViewDetails: (api) => navigate(`/apis/${api.id}`),
    onTestConnection: (api) => {
      setSelectedApi(api)
      testApiMutation.mutate({ id: api.id })
    },
    onImportSchema: (api) => {
      setSelectedApi(api)
      setUploadDialogOpen(true)
    },
    onGenerateTools: (api) => generateToolsMutation.mutate({ id: api.id }),
    onCopyBaseUrl: (api) => {
      navigator.clipboard.writeText(api.baseUrl)
      success('Copied', 'Base URL copied to clipboard')
    },
  })

  if (isError) {
    return <QueryError error={apisError} onRetry={() => refetchApis()} title="Couldn't load APIs" />
  }

  const apisExtracted = apisData?.apis || apisData || []
  const apis = Array.isArray(apisExtracted) ? apisExtracted : []
  const operationsExtracted = apiOperations?.operations || apiOperations || []
  const operations = Array.isArray(operationsExtracted) ? operationsExtracted : []

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">APIs</h1>
          <p className="text-muted-foreground">
            {apis.length} connected &middot; {apis.reduce((sum: number, a: any) => sum + (a.operations?.length || 0), 0)} operations &middot; {allToolsTotal} tools generated
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Connect API
          </Button>
        </div>
      </div>

      <CreateApiDialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open)
          if (!open) {
            setEditingApi(null)
          }
        }}
        editingApi={editingApi}
        uploadFile={uploadFile}
        setUploadFile={setUploadFile}
        importSchemaMutation={importSchemaMutation}
        onSelectApi={setSelectedApi}
      />

      {apis.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              <Globe className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No APIs</h3>
            <p className="text-muted-foreground mb-6 text-center max-w-md">
              Create your first API to get started. We support OpenAPI, GraphQL, SOAP, and gRPC protocols.
            </p>
            <Button size="lg" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Connect Your First API
            </Button>
          </CardContent>
        </Card>
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
                emptyState={
                  apis.length === 0 ? (
                    <EmptyState
                      icon={Globe}
                      title="Connect your first API"
                      description="Point almyty at an OpenAPI, GraphQL, SOAP, Protobuf, or SDK package and every operation becomes a tool your agents can call."
                      action={
                        <Button onClick={() => setCreateDialogOpen(true)}>
                          <Plus className="h-4 w-4 mr-2" />
                          Import API
                        </Button>
                      }
                      className="py-16"
                    />
                  ) : undefined
                }
              />
            </CardContent>
          </Card>
        </>
      )}

      <SchemaImportDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        apiType={selectedApi?.type || ApiType.OPENAPI}
        onImport={handleImportSchema}
        isLoading={importSchemaMutation.isPending}
      />

      <AlertDialog open={!!deletingApi} onOpenChange={(open) => !open && setDeletingApi(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the API "{deletingApi?.name}" and all associated tools and operations.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deletingApi) {
                  deleteApiMutation.mutate(deletingApi.id)
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ApiDetailDialog
        open={apiDetailsOpen}
        onOpenChange={setApiDetailsOpen}
        selectedApi={selectedApi}
        operations={operations}
        allTools={allTools}
        testResults={testResults}
        onOpenUploadDialog={() => setUploadDialogOpen(true)}
        generateToolsMutation={generateToolsMutation}
        testApiMutation={testApiMutation}
        onCopySuccess={success}
      />

    </div>
  )
}
