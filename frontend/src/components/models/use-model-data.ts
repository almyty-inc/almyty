import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { budgetsApi } from '@/lib/api'
import { getApiErrorMessage as errorMessage } from '@/lib/api-error'
import { DEPLOYMENT_POLL_MS, isInFlightState, modelAdaptersApi, modelDeploymentsApi, modelVersionsApi } from '@/lib/deployments-api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { ModelAdapter, ModelDeployment, ModelVersion, SpendBudgetSummary } from '@/types/deployments'

/**
 * Everything about the models hosted on this organization's cloud
 * accounts: the hosting records (polled while any is still moving), the
 * cloud integrations, and the budgets and pinned weight records the
 * detail reads facts off.
 */
export function useHostedModels() {
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id
  const deploymentsQuery = useQuery<ModelDeployment[]>({
    queryKey: ['model-deployments', orgId],
    queryFn: async () => {
      const d = await modelDeploymentsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!orgId,
    refetchInterval: (query) => (query.state.data?.some((d) => isInFlightState(d.state)) ? DEPLOYMENT_POLL_MS : false),
  })
  const deployments = useMemo(() => deploymentsQuery.data ?? [], [deploymentsQuery.data])
  const adaptersQuery = useQuery<ModelAdapter[]>({
    queryKey: ['model-adapters', orgId],
    queryFn: async () => {
      const d = await modelAdaptersApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!orgId && deployments.length > 0,
    staleTime: 5 * 60_000,
  })
  const versionsQuery = useQuery<ModelVersion[]>({
    queryKey: ['model-versions', orgId],
    queryFn: async () => {
      const d = await modelVersionsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!orgId && deployments.some((d) => !!d.modelVersionId),
  })
  const budgetsQuery = useQuery<SpendBudgetSummary[]>({
    queryKey: ['budgets', orgId],
    queryFn: async () => {
      const d = await budgetsApi.list()
      return Array.isArray(d) ? d : []
    },
    enabled: !!orgId && deployments.some((d) => !!d.budgetId),
  })
  return {
    orgId,
    deployments,
    deploymentsQuery,
    adapters: adaptersQuery.data ?? [],
    versions: versionsQuery.data ?? [],
    budgets: budgetsQuery.data ?? [],
  }
}

/** Start, stop, resize and shut down a hosted model. Each writes desired state; the reconcile loop does the rest. */
export function useHostingActions(orgId: string | undefined) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['model-deployments', orgId] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
  }
  const scale = useMutation({
    mutationFn: ({ id, replicas }: { id: string; replicas: number }) => modelDeploymentsApi.scale(id, replicas),
    onSuccess: (_d, vars) => {
      invalidate()
      notifications.success(
        vars.replicas === 0 ? 'Stopping' : 'Change requested',
        vars.replicas === 0 ? 'Your cloud stops the model and its billing within a few minutes.' : `Your cloud runs ${vars.replicas} ${vars.replicas === 1 ? 'copy' : 'copies'} within a few minutes.`,
      )
    },
    onError: (err) => notifications.error('Could not change it', errorMessage(err, 'The server rejected the request.')),
  })
  const shutDown = useMutation({
    mutationFn: (id: string) => modelDeploymentsApi.teardown(id),
    onSuccess: () => {
      invalidate()
      notifications.success('Shutting down', 'The model is removed from your cloud within a few minutes, and billing stops.')
    },
    onError: (err) => notifications.error('Could not shut it down', errorMessage(err, 'The server rejected the request.')),
  })
  return {
    onScale: (id: string, replicas: number) => scale.mutate({ id, replicas }),
    onTeardown: (id: string) => shutDown.mutate(id),
    busy: scale.isPending || shutDown.isPending,
  }
}
