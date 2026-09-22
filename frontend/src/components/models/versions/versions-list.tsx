import { useMemo } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { Package } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, createSortableColumn } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { BLANK, formatBytes } from '@/lib/deployments-api'
import { formatRelativeTime } from '@/lib/utils'
import type { ModelVersion } from '@/types/deployments'

export interface VersionsListProps {
  versions: ModelVersion[]
  loading?: boolean
  onSelect: (version: ModelVersion) => void
  onRegister?: () => void
}

export function VersionsList({ versions, loading, onSelect, onRegister }: VersionsListProps) {
  const columns = useMemo<ColumnDef<ModelVersion>[]>(
    () => [
      {
        ...createSortableColumn<ModelVersion>('name', 'Name'),
        cell: ({ row }) => {
          const v = row.original
          return (
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                <Package className="h-4 w-4 text-primary" />
              </div>
              <div>
                <div className="font-medium">{v.name}</div>
                <div className="text-xs text-muted-foreground">{v.base}</div>
              </div>
            </div>
          )
        },
      },
      {
        accessorKey: 'registryUri',
        header: 'Registry URI',
        cell: ({ row }) => (
          <code className="block max-w-[320px] truncate font-mono text-xs" title={row.original.registryUri}>
            {row.original.registryUri}
          </code>
        ),
      },
      {
        accessorKey: 'sizeBytes',
        header: 'Size',
        cell: ({ row }) => <span className="text-sm text-muted-foreground">{formatBytes(row.original.sizeBytes)}</span>,
      },
      {
        id: 'quantizations',
        header: 'Quantizations',
        cell: ({ row }) => {
          const q = row.original.quantizations ?? []
          if (q.length === 0) return <span className="text-sm text-muted-foreground">{BLANK}</span>
          return (
            <div className="flex flex-wrap gap-1">
              {q.map((name) => (
                <Badge key={name} variant="secondary" className="font-mono text-[11px]">
                  {name}
                </Badge>
              ))}
            </div>
          )
        },
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground" title={row.original.createdAt}>
            {formatRelativeTime(row.original.createdAt)}
          </span>
        ),
      },
    ],
    [],
  )

  return (
    <DataTable
      columns={columns}
      data={versions}
      loading={loading}
      searchKey="name"
      searchPlaceholder="Search artifacts..."
      onRowClick={onSelect}
      hideSelectionCount
      hideColumnsButton
      emptyState={
        <EmptyState
          icon={Package}
          title="Nothing tracked here, and most people never need this"
          description="To run a model you only have to name it on a deployment: hf://org/repo@sha, or a model already on Bedrock, Fireworks, Together or Baseten. Register an artifact here only when you want an immutable record of your own weights, pinned by etag or sha."
          action={onRegister ? <Button variant="outline" onClick={onRegister}>Register an artifact</Button> : undefined}
        />
      }
    />
  )
}
