import { useQuery, useMutation, useQueryClient, UseQueryOptions } from '@tanstack/react-query'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import {
  gatewaysApi,
  toolsApi,
  apisApi,
  agentsApi,
  llmProvidersApi,
  analyticsApi,
} from '@/lib/api'

/**
 * Shared hooks for common API data fetching patterns.
 * Eliminates duplicated query logic across pages.
 */

export function useCurrentOrg() {
  const { currentOrganization } = useOrganizationStore()
  return currentOrganization
}

export function useGateways() {
  const org = useCurrentOrg()
  return useQuery({
    queryKey: ['gateways', org?.id],
    queryFn: () => gatewaysApi.getAll(),
    enabled: !!org,
  })
}

export function useTools(params?: { limit?: number; page?: number }) {
  const org = useCurrentOrg()
  return useQuery({
    queryKey: ['tools', org?.id, params?.page, params?.limit],
    queryFn: () => toolsApi.getAll(org?.id, params),
    enabled: !!org,
    placeholderData: (prev: any) => prev,
  })
}

export function useApis() {
  const org = useCurrentOrg()
  return useQuery({
    queryKey: ['apis', org?.id],
    queryFn: () => apisApi.getAll(),
    enabled: !!org,
  })
}

export function useAgents() {
  const org = useCurrentOrg()
  return useQuery({
    queryKey: ['agents', org?.id],
    queryFn: () => agentsApi.getAll(),
    enabled: !!org,
  })
}

export function useLlmProviders() {
  const org = useCurrentOrg()
  return useQuery({
    queryKey: ['llm-providers', org?.id],
    queryFn: () => llmProvidersApi.getAll(),
    enabled: !!org,
  })
}

export function useAgent(id: string | undefined) {
  const org = useCurrentOrg()
  return useQuery({
    queryKey: ['agent', id],
    queryFn: () => agentsApi.getById(id!),
    enabled: !!id && !!org,
  })
}

export function useTool(id: string | undefined) {
  const org = useCurrentOrg()
  return useQuery({
    queryKey: ['tool', id],
    queryFn: () => toolsApi.getById(id!, org!.id),
    enabled: !!id && !!org,
  })
}

export function useGateway(id: string | undefined) {
  const org = useCurrentOrg()
  return useQuery({
    queryKey: ['gateway', id],
    queryFn: () => gatewaysApi.getById(id!),
    enabled: !!id && !!org,
  })
}

/**
 * Extract arrays from paginated API responses.
 * Handles both { tools: [...], total } and direct array responses.
 */
export function extractList<T>(data: any, key: string): T[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (data[key] && Array.isArray(data[key])) return data[key]
  return []
}

export function extractTotal(data: any, fallback: number = 0): number {
  return data?.total ?? fallback
}
