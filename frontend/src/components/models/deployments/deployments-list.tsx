import { useMemo } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Rocket } from 'lucide-react'

import { DataTable, createSortableColumn } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { BLANK, deploymentModelRef, formatCents } from '@/lib/deployments-api'
import { formatRelativeTime } from '@/lib/utils'
import type { ModelAdapter, ModelDeployment, ModelVersion } from '@/types/deployments'
import { DeploymentStateBadge } from './deployment-state-badge'

export interface DeploymentsListProps {
  deployments: ModelDeployment[]
  adapters: ModelAdapter[]
  versions: ModelVersion[]
  loading?: boolean
  onSelect: (deployment: ModelDeployment) => void
  onDeploy?: () => void
}

export function adapterName(adapters: ModelAdapter[], key: string): string {
  return adapters.find((a) => a.key === key)?.displayName ?? key
}

/** What the row shows under the provider: the model, however it was named. */
export function modelLabel(deployment: ModelDeployment, versions: ModelVersion[]): string {
  if (deployment.modelVersionId) {
    const version = versions.find((v) => v.id === deployment.modelVersionId)
    if (version) return version.name
  }
  return deploymentModelRef(deployment, versions)
}

export function DeploymentsList({ deployments, adapters, versions, loading, onSelect, onDeploy }: DeploymentsListProps) {
  const columns = useMemo<ColumnDef<ModelDeployment>[]>(
    () => [
      {
        ...createSortableColumn<ModelDeployment>('providerType', 'Provider'),
        cell: ({ row }) => {
          const d = row.original
          const model = modelLabel(d, versions)
          return (
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                <Rocket className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0">
                <div className="font-medium">{adapterName(adapters, d.providerType)}</div>
                <div className="max-w-[260px] truncate font-mono text-xs text-muted-foreground" title={model}>
                  {model}
                </div>
              </div>
            </div>
          )
        },
      },
      {
        ...createSortableColumn<ModelDeployment>('state', 'State'),
        cell: ({ row }) => <DeploymentStateBadge state={row.original.state} />,
      },
      {
        id: 'replicas',
        header: 'Replicas',
        cell: ({ row }) => {
          const d = row.original
          const desired = d.desired?.replicas
          const actual = d.actual?.replicas
          const drift = desired !== undefined && actual !== undefined && desired !== actual
          return (
            <span className={drift ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'} title="actual / desired">
              {actual ?? BLANK} / {desired ?? BLANK}
            </span>
          )
        },
      },
      {
        id: 'region',
        header: 'Region',
        cell: ({ row }) => {
          const d = row.original
          return <span className="text-sm text-muted-foreground">{d.actual?.region ?? d.desired?.region ?? BLANK}</span>
        },
      },
      {
        id: 'spend',
        header: 'Spend',
        cell: ({ row }) => {
          const a = row.original.actual
          const spent = a?.spentCents
          const rate = a?.ratePerHourCents
          return (
            <div className="text-sm">
              <div>{formatCents(spent)}</div>
              <div className="text-xs text-muted-foreground">{rate !== undefined && rate !== null ? `${formatCents(rate)}/h` : 'no rate reported'}</div>
            </div>
          )
        },
      },
      {
        id: 'lastError',
        header: 'Last error',
        cell: ({ row }) => {
          const d = row.original
          if (!d.lastError) return <span className="text-sm text-muted-foreground">{BLANK}</span>
          return (
            <span className="block max-w-[240px] truncate text-sm text-destructive" title={d.lastError}>
              {d.lastError}
            </span>
          )
        },
      },
      {
        accessorKey: 'lastReconcileAt',
        header: 'Reconciled',
        cell: ({ row }) => {
          const at = row.original.lastReconcileAt
          return (
            <span className="text-sm text-muted-foreground" title={at ?? ''}>
              {at ? formatRelativeTime(at) : 'never'}
            </span>
          )
        },
      },
    ],
    [adapters, versions],
  )

  return (
    <DataTable
      columns={columns}
      data={deployments}
      loading={loading}
      onRowClick={onSelect}
      hideSelectionCount
      hideColumnsButton
      emptyState={
        <EmptyState
          icon={Rocket}
          title="No deployments yet"
          description="Name a model - a Hugging Face repository, or one you already put on a platform - and pick a provider that can run it. The reconcile loop brings the endpoint up and reports state and spend here."
          action={onDeploy ? <Button onClick={onDeploy}>Run a model</Button> : undefined}
        />
      }
    />
  )
}
