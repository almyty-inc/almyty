/**
 * apis/apis-columns — DataTable column definitions for the APIs list,
 * exposed as a factory so the parent page can wire in mutations,
 * navigation, and the tool-count lookup. Used by `pages/apis.tsx`.
 */
import React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import {
  Cloud, Code, Database, Globe, Key, Lock,
  Package, Server, Shield, Unlock, Webhook,
} from 'lucide-react'

import { ApiTypeBadge } from '@/components/ui/api-type-badge'
import { createActionsColumn, createSortableColumn } from '@/components/ui/data-table'
import { VisibilityBadge, type Team } from '@/components/ui/team-filter'
import { Api, ApiAuthType, ApiType } from '@/types'
import { apiTools, authTypeLabel, isManualHttp, MANUAL_OPERATIONS_HINT, MANUAL_OPERATIONS_LABEL, operationCount } from '@/lib/api-operations'
function getApiTypeIcon(type: ApiType) {
  switch (type) {
    case ApiType.OPENAPI: return Globe
    case ApiType.GRAPHQL: return Database
    case ApiType.SOAP: return Cloud
    case ApiType.GRPC: return Server
    case ApiType.HTTP: return Webhook
    case ApiType.SDK: return Package
    case ApiType.OTHER: return Code
    default: return Code
  }
}

function getAuthTypeIcon(type?: ApiAuthType) {
  switch (type) {
    case ApiAuthType.API_KEY: return Key
    case ApiAuthType.BEARER_TOKEN: return Shield
    case ApiAuthType.BASIC_AUTH: return Lock
    case ApiAuthType.OAUTH2: return Unlock
    default: return Unlock
  }
}

export interface ApisColumnsOptions {
  allTools: any[]
  teamLookup?: Record<string, Team>
  onEdit: (api: Api) => void
  onDelete: (api: Api) => void
  onViewDetails: (api: Api) => void
  onTestConnection: (api: Api) => void
  onImportSchema: (api: Api) => void
  onGenerateTools: (api: Api) => void
  onCopyBaseUrl: (api: Api) => void
}

export function createApisColumns({
  allTools,
  teamLookup,
  onEdit,
  onDelete,
  onViewDetails,
  onTestConnection,
  onImportSchema,
  onGenerateTools,
  onCopyBaseUrl,
}: ApisColumnsOptions): ColumnDef<Api>[] {
  return [
    {
      ...createSortableColumn('name', 'API'),
      cell: ({ row }) => {
        const api = row.original
        const TypeIcon = getApiTypeIcon(api.type)

        // On a phone the name and its visibility badge wrap instead of
        // running past the cell, where the badge was cut off.
        return (
          <div className="flex min-w-0 items-center gap-3">
            <div className="w-10 h-10 shrink-0 bg-primary/10 rounded-lg flex items-center justify-center">
              <TypeIcon className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="api-name-line">
                <span className="font-medium break-words">{api.name}</span>
                <span className="shrink-0">
                  <VisibilityBadge
                    visibility={(api as any).visibility}
                    teamId={(api as any).teamId}
                    teamLookup={teamLookup}
                  />
                </span>
              </div>
              <div className="truncate text-sm text-muted-foreground">{api.baseUrl === 'internal://custom' ? 'Custom tool' : api.baseUrl}</div>
            </div>
          </div>
        )
      },
    },
    {
      accessorKey: 'type',
      header: 'Type',
      cell: ({ row }) => {
        return <ApiTypeBadge type={row.original.type} />
      },
    },
    {
      accessorKey: 'authentication.type',
      header: 'Auth',
      cell: ({ row }) => {
        const auth = row.original.authentication?.type
        const AuthIcon = getAuthTypeIcon(auth)
        return (
          <div className="flex items-center space-x-1">
            <AuthIcon className="h-4 w-4" />
            <span className="text-sm">
              {authTypeLabel(auth)}
            </span>
          </div>
        )
      },
    },
    {
      accessorKey: 'tools',
      header: 'Tools',
      cell: ({ row }) => (
        <div className="text-center">
          <span className="font-medium">{apiTools(row.original, allTools).length}</span>
        </div>
      ),
    },
    {
      accessorKey: 'operations',
      header: 'Operations',
      cell: ({ row }) => {
        const api = row.original
        // A Custom HTTP API has no description, so no operations: its tools
        // were made by hand. "0" read as an API with nothing in it.
        if (isManualHttp(api)) {
          return (
            <div className="text-center text-sm text-muted-foreground" title={MANUAL_OPERATIONS_HINT}>
              {MANUAL_OPERATIONS_LABEL}
            </div>
          )
        }
        return (
          <div className="text-center">
            <span className="font-medium">{operationCount(api).toLocaleString('en-US')}</span>
          </div>
        )
      },
    },
    createActionsColumn<Api>(
      onEdit,
      onDelete,
      [
        { label: 'View details', onClick: onViewDetails },
        { label: 'Test connection', onClick: onTestConnection },
        { label: 'Import schema', onClick: onImportSchema },
        { label: 'Generate tools', onClick: onGenerateTools },
        { label: 'Copy base URL', onClick: onCopyBaseUrl },
      ]
    ),
  ]
}
