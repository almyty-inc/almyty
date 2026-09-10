import React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatModelPrice, PRICING_SOURCE_LABELS } from '@/lib/models-api'
import type { ModelCard } from '@/types/models'
import { CapabilityBadges, PrivacyTierBadge, SelectableIndicator, ValidationBadge } from './model-badges'
import { ModelOriginBadge, modelOrigin, modelVendor, whereItRuns } from './model-origin'

export interface CatalogColumnActions {
  providerNames: Record<string, string>
  onValidate: (card: ModelCard) => void
  onEdit: (card: ModelCard) => void
  onDelete: (card: ModelCard) => void
  /** Cards currently running a validation call. */
  validatingIds: Set<string>
}

export function formatContextLength(n: number | null | undefined): string {
  if (!n) return '--'
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function buildCatalogColumns({ providerNames, onValidate, onEdit, onDelete, validatingIds }: CatalogColumnActions): ColumnDef<ModelCard, any>[] {
  return [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium truncate">{row.original.name}</div>
          <div className="text-xs text-muted-foreground font-mono truncate">{row.original.vendorModelId}</div>
        </div>
      ),
    },
    {
      id: 'provider',
      header: 'Runs on',
      accessorFn: (card) => modelVendor(card, providerNames),
      cell: ({ row }) => (
        <div className="min-w-0 space-y-1">
          <div className="truncate text-sm" title={whereItRuns(row.original, providerNames)}>
            {whereItRuns(row.original, providerNames)}
          </div>
          <ModelOriginBadge origin={modelOrigin(row.original)} />
        </div>
      ),
    },
    {
      id: 'tier',
      header: 'Privacy / region',
      accessorFn: (card) => `${card.privacyTier} ${card.region || ''}`,
      cell: ({ row }) => (
        <div className="flex flex-col gap-1 items-start">
          <PrivacyTierBadge tier={row.original.privacyTier} />
          <span className="text-xs text-muted-foreground">{row.original.region || 'Any region'}</span>
        </div>
      ),
    },
    {
      id: 'price',
      header: 'Price / MTok',
      accessorFn: (card) => card.effectivePricing?.inPerMTok ?? Number.POSITIVE_INFINITY,
      cell: ({ row }) => {
        const card = row.original
        const source = card.pricingOverride ? 'manual' : card.pricingSource
        return (
          <div className="min-w-0">
            <div className="text-sm whitespace-nowrap">{formatModelPrice(card.effectivePricing)}</div>
            <div className="text-xs text-muted-foreground">{PRICING_SOURCE_LABELS[source] || source}</div>
          </div>
        )
      },
    },
    {
      accessorKey: 'contextLength',
      header: 'Context',
      cell: ({ row }) => <span className="text-sm">{formatContextLength(row.original.contextLength)}</span>,
    },
    {
      id: 'capabilities',
      header: 'Capabilities',
      enableSorting: false,
      cell: ({ row }) => <CapabilityBadges capabilities={row.original.capabilities} />,
    },
    {
      accessorKey: 'validationStatus',
      header: 'Validation',
      cell: ({ row }) => <ValidationBadge card={row.original} />,
    },
    {
      accessorKey: 'selectable',
      header: 'Usable',
      cell: ({ row }) => <SelectableIndicator selectable={row.original.selectable} />,
    },
    {
      id: 'actions',
      enableHiding: false,
      cell: ({ row }) => {
        const card = row.original
        const validating = validatingIds.has(card.id)
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 w-8 p-0" aria-label={`Actions for ${card.name}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuItem disabled={validating} onClick={(e) => { e.stopPropagation(); onValidate(card) }}>
                {validating ? 'Validating...' : 'Validate'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(card) }}>Edit</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(card) }}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
    },
  ]
}
