import { QueryClient } from '@tanstack/react-query'

/**
 * The app's query client.
 *
 * Mutations are never retried by default. A mutation is a POST, PATCH or
 * DELETE: replaying one that failed runs the work twice (a second
 * provider connect, a second import, a second agent), and a 4xx answer
 * will not change on a replay anyway. The axios layer already retries
 * only idempotent methods (see lib/api.ts); this keeps react-query from
 * undoing that one layer up. A mutation that is safe to repeat opts in
 * with its own `retry`.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30000, // 30 seconds before refetch
        gcTime: 5 * 60 * 1000, // keep unused data 5 minutes
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}
