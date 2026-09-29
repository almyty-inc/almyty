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
import { connectProviderPath, providerPath } from '@/components/llm-providers/paths'

/** /llm-providers: the Models page, or connecting a provider for ?new=1 (the old command palette link). */
export function ProvidersRedirect() {
  const location = useLocation()
  const wantsNew = new URLSearchParams(location.search).get('new') === '1'
  return <Navigate to={wantsNew ? connectProviderPath() : '/models'} replace />
}

/** /llm-providers/:id, /llm-providers/:id/edit and /models/providers/:id: the connection's page under Credentials, at the same model. */
export function ProviderRedirect() {
  const { id = '' } = useParams<{ id: string }>()
  const location = useLocation()
  return <Navigate to={`${providerPath(id)}${location.search}${location.hash}`} replace />
}

/** /llm-providers/new, /models/new and /models/connect: connect a provider under Credentials, keeping ?type and ?returnTo. */
export function ConnectRedirect() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  return <Navigate to={connectProviderPath(params.get('type'), params.get('returnTo'))} replace />
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
  if (card?.providerId) return <Navigate to={providerPath(card.providerId, card.id)} replace />
  if (card && (hostedQuery.isSuccess || hostedQuery.isError)) {
    const hosted = hostedQuery.data ? deploymentForCard(card, hostedQuery.data) : undefined
    return <Navigate to={hosted ? `/models/hosting/${hosted.id}` : '/models'} replace />
  }
  return <Skeleton className="h-48 w-full" aria-busy="true" />
}
