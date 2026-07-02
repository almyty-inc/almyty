/**
 * DataTable column factory for the LLM providers list page.
 *
 * Encapsulates the Provider/Model/Status/Usage cells plus the row action
 * menu (View, Test, Edit, Copy API Key, Toggle Status, Delete) so the page
 * file only needs to wire up state and mutations.
 */
import React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import type { UseFormReturn } from 'react-hook-form'
import type { UseMutationResult } from '@tanstack/react-query'

import { Badge } from '@/components/ui/badge'
import {
  createActionsColumn,
  createSortableColumn,
} from '@/components/ui/data-table'
import { llmProvidersApi } from '@/lib/api'
import { VisibilityBadge, type Team } from '@/components/ui/team-filter'

import type { LlmProvider } from './schema'
import { providerLogos, statusColors } from './provider-type-config'

interface ProviderColumnDeps {
  navigate: (path: string) => void
  setProviderToDelete: (provider: LlmProvider | null) => void
  setTestProvider: (provider: LlmProvider | null) => void
  setIsTestDialogOpen: (open: boolean) => void
  setProviderToEdit: (provider: LlmProvider | null) => void
  editForm: UseFormReturn<any>
  setIsEditDialogOpen: (open: boolean) => void
  setModelsLoading: (loading: boolean) => void
  setAvailableModels: (models: Array<{ id: string; name: string }>) => void
  copySensitive: (value: string, label: string) => void
  toggleProviderStatusMutation: UseMutationResult<any, any, { providerId: string; status: string }, any>
  teamLookup?: Record<string, Team>
}

export function buildProviderColumns(deps: ProviderColumnDeps): ColumnDef<LlmProvider, any>[] {
  const {
    navigate,
    setProviderToDelete,
    setTestProvider,
    setIsTestDialogOpen,
    setProviderToEdit,
    editForm,
    setIsEditDialogOpen,
    setModelsLoading,
    setAvailableModels,
    copySensitive,
    toggleProviderStatusMutation,
    teamLookup,
  } = deps

  return [
    createSortableColumn<LlmProvider>({
      accessorKey: 'name',
      header: 'Provider',
      cell: ({ row }) => {
        const provider = row.original
        return (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${statusColors[provider.status]}`} />
              <span className="text-lg">{providerLogos[provider.type]}</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{provider.name}</span>
                <VisibilityBadge
                  visibility={(provider as any).visibility}
                  teamId={(provider as any).teamId}
                  teamLookup={teamLookup}
                />
              </div>
              <div className="text-sm text-muted-foreground">{provider.description || 'No description'}</div>
            </div>
          </div>
        )
      },
    }),
    createSortableColumn<LlmProvider>({
      accessorKey: 'type',
      header: 'Model',
      cell: ({ row }) => {
        const provider = row.original
        return (
          <div>
            <Badge variant="outline" className="capitalize">{provider.type}</Badge>
            {provider.configuration?.model && (
              <div className="text-xs text-muted-foreground mt-1">{provider.configuration.model}</div>
            )}
          </div>
        )
      },
    }),
    createSortableColumn<LlmProvider>({
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const provider = row.original
        const status = provider.status
        const colors = {
          active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
          inactive: 'bg-muted text-muted-foreground',
          error: 'bg-red-500/15 text-red-700 dark:text-red-400',
          configuring: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
        }
        return (
          <div className="flex items-center gap-2">
            <Badge className={colors[status as keyof typeof colors]}>
              {status}
            </Badge>
            {status === 'error' && provider.lastError && (
              <span className="text-xs text-red-500 truncate max-w-[150px]" title={provider.lastError}>
                {provider.lastError}
              </span>
            )}
          </div>
        )
      },
    }),
    createSortableColumn<LlmProvider>({
      accessorKey: 'totalRequests',
      header: 'Usage',
      cell: ({ row }) => {
        const provider = row.original
        const requests = provider.totalRequests || 0
        if (requests === 0) {
          return <div className="text-sm text-muted-foreground">No usage yet</div>
        }
        return (
          <div>
            <div className="font-medium">{requests.toLocaleString()} reqs</div>
            <div className="text-sm text-muted-foreground">${(provider.totalCost || 0).toFixed(2)} spent</div>
          </div>
        )
      },
    }),
    createActionsColumn<LlmProvider>(
      (provider) => navigate(`/llm-providers/${provider.id}`),
      (provider) => setProviderToDelete(provider),
      [
        {
          label: 'View Details',
          onClick: (provider) => navigate(`/llm-providers/${provider.id}`),
        },
        {
          label: 'Test Connection',
          onClick: (provider) => {
            setTestProvider(provider)
            setIsTestDialogOpen(true)
          },
        },
        {
          label: 'Edit',
          onClick: async (provider) => {
            setProviderToEdit(provider)
            editForm.reset({
              name: provider.name,
              model: provider.configuration.model || '',
              maxTokens: provider.configuration.maxTokens || 4096,
              temperature: provider.configuration.temperature || 0.7,
              // Stored value is masked/encrypted — start blank; blank
              // means "keep the existing key" on update.
              usageApiKey: '',
            })
            setIsEditDialogOpen(true)
            setModelsLoading(true)
            setAvailableModels([])
            try {
              const res = await llmProvidersApi.getModels(provider.id)
              setAvailableModels(res || [])
            } catch {
              setAvailableModels([])
            } finally {
              setModelsLoading(false)
            }
          },
        },
        {
          label: 'Copy API Key',
          onClick: (provider) => {
            copySensitive(provider.configuration.apiKey || '', 'API key')
          },
        },
        {
          label: 'Toggle Status',
          onClick: (provider) => {
            toggleProviderStatusMutation.mutate({
              providerId: provider.id,
              status: provider.status === 'active' ? 'inactive' : 'active',
            })
          },
        },
      ],
    ),
  ]
}
