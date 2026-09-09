import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { QueryError } from '@/components/ui/query-error'
import { DEPLOYMENT_POLL_MS, isInFlightState, modelAdaptersApi, modelDeploymentsApi, modelVersionsApi } from '@/lib/deployments-api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { CreateModelDeploymentBody, ModelAdapter, ModelDeployment, ModelVersion } from '@/types/deployments'
import { DeployDialog } from './deployments/deploy-dialog'
import { DeploymentDetailSheet } from './deployments/deployment-detail-sheet'
import { DeploymentsList } from './deployments/deployments-list'

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { message?: string } }; message?: string }
  return e?.response?.data?.message ?? e?.message ?? fallback
}

export function DeploymentsTab() {
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id
  const qc = useQueryClient()
  const notify = useNotifications()
  const [deployOpen, setDeployOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const deploymentsQuery = useQuery<ModelDeployment[]>({
    queryKey: ['model-deployments', orgId],
    queryFn: async () => {
      const d = await modelDeploymentsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!orgId,
    // Keep polling while the reconcile loop still has work on any row.
    refetchInterval: (query) => (query.state.data?.some((d) => isInFlightState(d.state)) ? DEPLOYMENT_POLL_MS : false),
  })
  const adaptersQuery = useQuery<ModelAdapter[]>({
    queryKey: ['model-adapters', orgId],
    queryFn: async () => {
      const d = await modelAdaptersApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!orgId,
    staleTime: 5 * 60_000,
  })
  const versionsQuery = useQuery<ModelVersion[]>({
    queryKey: ['model-versions', orgId],
    queryFn: async () => {
      const d = await modelVersionsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!orgId,
  })

  const deployments = deploymentsQuery.data ?? []
  const adapters = adaptersQuery.data ?? []
  const versions = versionsQuery.data ?? []
  const selected = useMemo(() => deployments.find((d) => d.id === selectedId) ?? null, [deployments, selectedId])

  const invalidate = () => qc.invalidateQueries({ queryKey: ['model-deployments', orgId] })

  const createMutation = useMutation({
    mutationFn: (body: CreateModelDeploymentBody) => modelDeploymentsApi.create(body),
    onSuccess: () => {
      invalidate()
      setDeployOpen(false)
      notify.success('Deployment queued', 'The reconcile loop brings the endpoint up.')
    },
    onError: (err) => notify.error('Could not create deployment', errorMessage(err, 'The server rejected the request.')),
  })
  const scaleMutation = useMutation({
    mutationFn: ({ id, replicas }: { id: string; replicas: number }) => modelDeploymentsApi.scale(id, replicas),
    onSuccess: (_d, vars) => {
      invalidate()
      notify.success('Scale requested', `Desired replicas set to ${vars.replicas}.`)
    },
    onError: (err) => notify.error('Could not scale', errorMessage(err, 'The server rejected the request.')),
  })
  const teardownMutation = useMutation({
    mutationFn: (id: string) => modelDeploymentsApi.teardown(id),
    onSuccess: () => {
      invalidate()
      notify.success('Teardown requested', 'The endpoint is removed on the next reconcile. Weights stay in the registry.')
    },
    onError: (err) => notify.error('Could not tear down', errorMessage(err, 'The server rejected the request.')),
  })
  const deleteMutation = useMutation({
    mutationFn: (id: string) => modelDeploymentsApi.delete(id),
    onSuccess: () => {
      invalidate()
      setSelectedId(null)
      notify.success('Deployment deleted')
    },
    onError: (err) => notify.error('Could not delete', errorMessage(err, 'The server rejected the request.')),
  })

  const busy = scaleMutation.isPending || teardownMutation.isPending || deleteMutation.isPending
  const inFlight = deployments.filter((d) => isInFlightState(d.state)).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Deployments</h2>
          <p className="text-sm text-muted-foreground">
            {deployments.length === 0 ? 'Versions running on a provider show up here.' : `${deployments.length} ${deployments.length === 1 ? 'deployment' : 'deployments'}${inFlight ? `, ${inFlight} in flight (refreshing every ${DEPLOYMENT_POLL_MS / 1000}s)` : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => deploymentsQuery.refetch()} disabled={deploymentsQuery.isFetching} aria-label="Refresh deployments">
            <RefreshCw className={deploymentsQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
          <Button onClick={() => setDeployOpen(true)} disabled={!orgId}>
            <Plus className="mr-2 h-4 w-4" />
            Deploy
          </Button>
        </div>
      </div>

      {deploymentsQuery.isError ? (
        <QueryError error={deploymentsQuery.error} onRetry={() => deploymentsQuery.refetch()} title="We couldn't load deployments" />
      ) : (
        <DeploymentsList deployments={deployments} adapters={adapters} versions={versions} loading={deploymentsQuery.isLoading} onSelect={(d) => setSelectedId(d.id)} onDeploy={() => setDeployOpen(true)} />
      )}

      <DeployDialog open={deployOpen} onOpenChange={setDeployOpen} adapters={adapters} versions={versions} onSubmit={(body) => createMutation.mutate(body)} submitting={createMutation.isPending} />

      <DeploymentDetailSheet
        deployment={selected}
        adapters={adapters}
        versions={versions}
        open={!!selected}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onScale={(id, replicas) => scaleMutation.mutate({ id, replicas })}
        onTeardown={(id) => teardownMutation.mutate(id)}
        onDelete={(id) => deleteMutation.mutate(id)}
        busy={busy}
      />
    </div>
  )
}
