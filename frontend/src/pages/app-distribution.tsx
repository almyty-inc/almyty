import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { WithApp, WithDistribution } from '@/components/agent-apps/app-page-loader'
import { DistributionSettings } from '@/components/agent-apps/distribution-settings'
import { agentsApi } from '@/lib/api'

/** /apps/:slug/distributions/:target -- one distribution's settings. */
export function AppDistributionPage() {
  const { slug = '', target } = useParams<{ slug: string; target: string }>()

  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.getAll(),
  })
  const raw = (agentsData as any)?.agents ?? agentsData
  const agents = Array.isArray(raw) ? raw : []

  return (
    <WithApp slug={slug}>
      {(app) => (
        <WithDistribution app={app} target={target}>
          {(distribution) => (
            <DistributionSettings
              key={distribution.id}
              app={app}
              distribution={distribution}
              agents={agents}
            />
          )}
        </WithDistribution>
      )}
    </WithApp>
  )
}

export default AppDistributionPage
