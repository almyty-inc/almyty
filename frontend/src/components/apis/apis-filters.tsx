/**
 * apis/apis-filters — search + type + health filter row above the
 * APIs list table. Used by `pages/apis.tsx`.
 */
import React from 'react'
import { Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ApiHealthStatus, ApiType } from '@/types'

interface ApisFiltersProps {
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  typeFilter: string
  onTypeFilterChange: (value: string) => void
  healthFilter: string
  onHealthFilterChange: (value: string) => void
}

export function ApisFilters({
  searchQuery,
  onSearchQueryChange,
  typeFilter,
  onTypeFilterChange,
  healthFilter,
  onHealthFilterChange,
}: ApisFiltersProps) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex-1">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search APIs..."
            className="pl-10"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
        </div>
      </div>
      <Select value={typeFilter} onValueChange={onTypeFilterChange}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Types</SelectItem>
          <SelectItem value={ApiType.OPENAPI}>OpenAPI</SelectItem>
          <SelectItem value={ApiType.GRAPHQL}>GraphQL</SelectItem>
          <SelectItem value={ApiType.SOAP}>SOAP</SelectItem>
          <SelectItem value={ApiType.GRPC}>gRPC</SelectItem>
          <SelectItem value={ApiType.HTTP}>Custom HTTP</SelectItem>
          <SelectItem value={ApiType.SDK}>SDK / npm</SelectItem>
        </SelectContent>
      </Select>
      <Select value={healthFilter} onValueChange={onHealthFilterChange}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Health" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          <SelectItem value={ApiHealthStatus.HEALTHY}>Healthy</SelectItem>
          <SelectItem value={ApiHealthStatus.DEGRADED}>Degraded</SelectItem>
          <SelectItem value={ApiHealthStatus.UNHEALTHY}>Unhealthy</SelectItem>
          <SelectItem value={ApiHealthStatus.UNKNOWN}>Unknown</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
