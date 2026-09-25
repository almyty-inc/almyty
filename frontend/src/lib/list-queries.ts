import { agentsApi, gatewaysApi, toolsApi } from '@/lib/api'

/**
 * The one definition of each shared list query.
 *
 * Several pages wrote their own `useQuery` under the same key: the
 * dashboard, the APIs page and the gateway page cached the raw
 * `{ tools, total }` envelope under ['tools', orgId] while the node
 * config panel, chat and the analytics tab cached a bare array under the
 * very same key. React Query keeps whichever ran first, so the second
 * page read `.tools` off an array (or `.map` off an envelope) and showed
 * nothing. The Gateways page did the same against the analytics tab under
 * ['gateways', orgId]. One key, one queryFn, one shape -- see
 * llm-providers-query.ts for the first case of this and
 * lib/__tests__/one-shape-per-query-key.test.ts for the guard.
 */
export interface ListPage<T = any> {
  items: T[]
  total: number
}

/** Accepts a bare array or a `{ [field]: [], total }` envelope. */
export function toListPage<T = any>(raw: unknown, field: string): ListPage<T> {
  const body = raw as any
  const list = Array.isArray(body) ? body : body?.[field]
  const items: T[] = Array.isArray(list) ? list : []
  const total = typeof body?.total === 'number' ? body.total : items.length
  return { items, total }
}

export const toolsQuery = (organizationId: string | undefined) => ({
  queryKey: ['tools', organizationId] as const,
  queryFn: async (): Promise<ListPage> => toListPage(await toolsApi.getAll(organizationId), 'tools'),
})

export const gatewaysQuery = (organizationId: string | undefined) => ({
  queryKey: ['gateways', organizationId] as const,
  queryFn: async (): Promise<ListPage> => toListPage(await gatewaysApi.getAll(), 'gateways'),
})

/** GET /agents answers a bare array; kept as one so every reader agrees. */
export const agentsQuery = (organizationId: string | undefined) => ({
  queryKey: ['agents', organizationId] as const,
  queryFn: async (): Promise<any[]> => toListPage(await agentsApi.getAll(), 'agents').items,
})

/** One tool, as the tool page and the publish page both read it. */
export const toolQuery = (id: string | undefined, organizationId: string | undefined) => ({
  queryKey: ['tool', id] as const,
  queryFn: async () => {
    if (!id || !organizationId) throw new Error('No organization selected')
    return toolsApi.getById(id, organizationId)
  },
})