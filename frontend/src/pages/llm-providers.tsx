import React, { useState, useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Search, Brain } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { useNewParamRedirect } from '@/hooks/use-new-param-redirect'
import { useConfirm } from '@/components/ui/confirm-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DataTable } from '@/components/ui/data-table'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { llmProvidersApi } from '@/lib/api'
import { pluralized } from '@/lib/utils'
import { TeamFilter, useTeamLookup, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'
import type { LlmProvider } from '@/components/llm-providers/schema'
import { buildProviderColumns } from '@/components/llm-providers/columns'
import { providerTypeOptions } from '@/components/llm-providers/provider-type-config'
import { getApiErrorMessage } from '@/lib/api-error'
import { llmProvidersQuery } from '@/lib/llm-providers-query'

/**
 * Inference providers: the APIs models are called through, with their keys.
 * Its own page, reached from the Models header. Adding one is its own page
 * (/llm-providers/new); editing and testing one happen on its detail page.
 */
export function LlmProvidersPage() {
  useEffect(() => {
    document.title = 'Inference providers | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const navigate = useNavigate()
  // ?new=1 (command palette, onboarding, bookmarks) lands on the add page.
  useNewParamRedirect('/llm-providers/new')
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [teamFilter, setTeamFilter] = useState<TeamFilterValue>('all')
  const { currentOrganization } = useOrganizationStore()
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)

  const queryClient = useQueryClient()
  const notifications = useNotifications()

  const { data: providersRaw, isLoading, isError, error, refetch: refetchProviders } = useQuery({
    // No try/catch (fetchLlmProviders has none): swallowing the rejection
    // and returning [] made isError permanently false, so a 500 or an
    // expired session rendered the "No models configured" empty state over
    // providers that were still there, with no retry.
    ...llmProvidersQuery,
  })
  const providers = Array.isArray(providersRaw) ? providersRaw : []

  // Provider metrics now live on the detail page (/llm-providers/:id)

  const deleteProviderMutation = useMutation({
    mutationFn: async (providerId: string) => {
      await llmProvidersApi.delete(providerId)
      return providerId
    },
    onSuccess: (providerId) => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      // ['llm-provider', id] is the detail page's own key, not a
      // descendant of ['llm-providers'], so none of these mutations
      // ever reached it and the detail page kept the pre-change
      // provider.
      queryClient.removeQueries({ queryKey: ['llm-provider', providerId] })
      queryClient.removeQueries({ queryKey: ['provider-metrics', providerId] })
      notifications.success('Deleted', 'Provider removed successfully')
    },
    onError: (error: any) => {
      notifications.error('Error', getApiErrorMessage(error, 'Failed to delete provider'))
    }
  })
  const { confirm, dialog: confirmDialog } = useConfirm()
  const handleDeleteProvider = async (provider: LlmProvider) => {
    const ok = await confirm({
      title: 'Delete this provider?',
      description: (
        <>
          Are you sure you want to delete &quot;{provider.name}&quot;? This action cannot be undone.
          All configuration and usage history will be permanently removed.
        </>
      ),
      confirmLabel: 'Delete provider',
      destructive: true,
    })
    if (ok) deleteProviderMutation.mutate(provider.id)
  }

  const toggleProviderStatusMutation = useMutation({
    mutationFn: async ({ providerId, status }: { providerId: string; status: string }) => {
      return llmProvidersApi.update(providerId, { status })
    },
    onSuccess: (_result, { providerId }) => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      queryClient.invalidateQueries({ queryKey: ['llm-provider', providerId] })
      notifications.success('Updated', 'Provider status changed')
    },
    onError: (error: any) => {
      notifications.error('Error', getApiErrorMessage(error, 'Failed to update provider'))
    }
  })

  const filteredProviders = filterByTeamVisibility(providers as any[], teamFilter).filter((provider: any) => {
    const matchesSearch = provider.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         (provider.description || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                         provider.type.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStatus = statusFilter === 'all' || provider.status === statusFilter
    const matchesType = typeFilter === 'all' || provider.type === typeFilter
    return matchesSearch && matchesStatus && matchesType
  })

  const totalCost = providers.reduce((sum: number, provider: any) => sum + (provider.totalCost || 0), 0)
  const totalRequests = providers.reduce((sum: number, provider: any) => sum + (provider.totalRequests || 0), 0)

  const columns = buildProviderColumns({
    navigate,
    onDeleteProvider: handleDeleteProvider,
    toggleProviderStatusMutation,
    teamLookup,
  })

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link to="/models" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Models
        </Link>
        <PageHeader
          title="Inference providers"
          description={
            <>
              The APIs your models are called through, and the keys for them.{' '}
              {isLoading ? <span className="inline-block w-48 h-4 bg-muted animate-pulse rounded align-middle" /> : `${pluralized(providers.length, 'provider')} (${providers.filter((p: any) => p.status === 'active').length} active) · $${totalCost.toFixed(2)} total cost · ${pluralized(totalRequests, 'request')}`}
            </>
          }
          actions={
            // Only shown outside the empty state, which has its own add button.
            !isLoading && providers.length === 0 ? undefined : (
              <Button onClick={() => navigate('/llm-providers/new')} className="gap-2">
                <Plus className="h-4 w-4" />
                Add inference provider
              </Button>
            )
          }
        />
      </div>

      {/* Providers Table or Empty State */}
      {isError ? (
        <QueryError error={error} onRetry={() => refetchProviders()} title="Couldn't load inference providers" />
      ) : !isLoading && providers.length === 0 ? (
            <EmptyState
              icon={Brain}
              title="No inference providers yet"
              description="An inference provider is an API that serves models, such as OpenAI, Anthropic or a server you run. Add one and its models appear on the Models page. Keys stay encrypted at rest."
              action={
                <Button onClick={() => navigate('/llm-providers/new')} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Add inference provider
                </Button>
              }
              variant="panel"
            />
      ) : (
        <Card>
          <CardContent className="pt-6 space-y-4">
            {/* Filters */}
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex-1 min-w-[12rem]">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search providers..."
                    className="pl-10"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                  <SelectItem value="configuring">Configuring</SelectItem>
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {providerTypeOptions.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <TeamFilter
                organizationId={currentOrganization?.id}
                value={teamFilter}
                onChange={setTeamFilter}
              />
            </div>
            <DataTable
              columns={columns}
              data={filteredProviders}
              loading={isLoading}
              onRowClick={(provider) => navigate(`/llm-providers/${provider.id}`)}
            />
          </CardContent>
        </Card>
      )}

      {confirmDialog}
    </div>
  )
}
