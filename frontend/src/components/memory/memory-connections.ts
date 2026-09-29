import { credentialsApi } from '@/lib/api'

/** A memory service connection (a memory_backend credential). */
export interface MemoryConnection {
  id: string
  name: string
  type: string
}

/**
 * The organization's memory service connections: the Memory page's account
 * pickers and an agent's own account read the same list, under one key.
 */
export const memoryConnectionsQuery = {
  queryKey: ['credentials', 'memory-backend'] as const,
  queryFn: async (): Promise<MemoryConnection[]> => {
    const res: any = await credentialsApi.getAll()
    const list = (res?.data ?? res ?? []) as MemoryConnection[]
    return list.filter((c) => c?.type === 'memory_backend')
  },
}
