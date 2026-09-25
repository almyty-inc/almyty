/**
 * Where the old Models and inference-provider addresses land now. Bookmarks,
 * docs and links in older builds keep working; each one goes to the page
 * that replaced it.
 */
import { Navigate, useLocation, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { Skeleton } from '@/components/ui/skeleton'
import { modelsApi } from '@/lib/models-api'
import { modelDeploymentsApi } from '@/lib/deployments-api'
import { deploymentForCard } from '@/lib/model-hosting'

/** /llm-providers/:id and /llm-providers/:id/edit: the provider's page. */
export function ProviderRedirect() {
  const { id = '' } = useParams<{ id: string }>()
  return <Navigate to={`/models/providers/${encodeURIComponent(id)}`} replace />
}

/** /llm-providers/new and /models/new: connect a provider, keeping ?type. */
export function ConnectRedirect() {
  const location = useLocation()
  const type = new URLSearchParams(location.search).get('type')
  return <Navigate to={type ? `/models/connect?type=${encodeURIComponent(type)}` : '/models/connect'} replace />
}

/** /models/:id, a model's old page: its provider's page, at the model. */
export function ModelRedirect() {
  const { id = '' } = useParams<{ id: string }>()
  const cardQuery = useQuery({ queryKey: ['models', 'detail', id], queryFn: () => modelsApi.get(id), enabled: !!id, retry: false })
  const card = cardQuery.data
  const hostedQuery = useQuery({
    queryKey: ['model-deployments', 'for-card', id],
    queryFn: async () => {
      const rows = await modelDeploymentsApi.list()
      return Array.isArray(rows) ? rows : []
    },
    enabled: !!card && !card.providerId,
    retry: false,
  })

  if (cardQuery.isError) return <Navigate to="/models" replace />
  if (card?.providerId) return <Navigate to={`/models/providers/${card.providerId}#model-${card.id}`} replace />
  if (card && (hostedQuery.isSuccess || hostedQuery.isError)) {
    const hosted = hostedQuery.data ? deploymentForCard(card, hostedQuery.data) : undefined
    return <Navigate to={hosted ? `/models/hosting/${hosted.id}` : '/models'} replace />
  }
  return <Skeleton className="h-48 w-full" aria-busy="true" />
}
