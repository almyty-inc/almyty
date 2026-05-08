/**
 * apis/apis-columns — DataTable column definitions for the APIs list,
 * exposed as a factory so the parent page can wire in mutations,
 * navigation, and the tool-count lookup. Used by `pages/apis.tsx`.
 */
import React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import {
  AlertCircle, CheckCircle, Cloud, Code, Database, Globe, Key, Lock,
  Package, Server, Shield, Unlock, Webhook, XCircle,
} from 'lucide-react'

import { ApiTypeBadge } from '@/components/ui/api-type-badge'
import { createActionsColumn, createSortableColumn } from '@/components/ui/data-table'
import { VisibilityBadge, type Team } from '@/components/ui/team-filter'
import { Api, ApiAuthType, ApiHealthStatus, ApiType } from '@/types'

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

function getHealthStatusIcon(status: ApiHealthStatus) {
  switch (status) {
    case ApiHealthStatus.HEALTHY: return CheckCircle
    case ApiHealthStatus.DEGRADED: return AlertCircle
    case ApiHealthStatus.UNHEALTHY: return XCircle
    default: return AlertCircle
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
        const HealthIcon = getHealthStatusIcon(api.healthStatus)

        return (
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <TypeIcon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{api.name}</span>
                <VisibilityBadge
                  visibility={(api as any).visibility}
                  teamId={(api as any).teamId}
                  teamLookup={teamLookup}
                />
              </div>
              <div className="text-sm text-muted-foreground">{api.baseUrl === 'internal://custom' ? 'Custom Tool' : api.baseUrl}</div>
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
              {!auth || auth === 'none' ? 'None' : auth.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </span>
          </div>
        )
      },
    },
    {
      accessorKey: 'tools',
      header: 'Tools',
      cell: ({ row }) => {
        const api = row.original
        const apiToolCount = allTools.filter((tool: any) =>
          tool.metadata?.sourceApi?.id === api.id || tool.apiId === api.id
        ).length
        return (
          <div className="text-center">
            <span className="font-medium">{apiToolCount}</span>
          </div>
        )
      },
    },
    {
      accessorKey: 'operations',
      header: 'Operations',
      cell: ({ row }) => {
        const opCount = row.original.operations?.length || 0
        return (
          <div className="text-center">
            <span className="font-medium">{opCount}</span>
          </div>
        )
      },
    },
    createActionsColumn<Api>(
      onEdit,
      onDelete,
      [
        { label: 'View Details', onClick: onViewDetails },
        { label: 'Test Connection', onClick: onTestConnection },
        { label: 'Import Schema', onClick: onImportSchema },
        { label: 'Generate Tools', onClick: onGenerateTools },
        { label: 'Copy Base URL', onClick: onCopyBaseUrl },
      ]
    ),
  ]
}
