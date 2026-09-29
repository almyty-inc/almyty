import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Package } from 'lucide-react'

import { DISTRIBUTION_LABELS, appPlacesApi, type GatewayManagedBy } from '@/lib/agent-apps'

/** The app a gateway was published from, or null. Undefined while loading. */
export function useManagedByApp(gatewayId: string | undefined) {
  const { data } = useQuery({
    queryKey: ['gateway-app', gatewayId],
    queryFn: () => appPlacesApi.appForGateway(gatewayId!),
    enabled: !!gatewayId,
  })
  return data
}

/**
 * "Managed in <app>": a gateway an app stood up is configured on the app,
 * so its page says so once and links to the place, rather than offering
 * a second copy of the same settings.
 */
export function ManagedByAppBanner({ managedBy }: { managedBy: GatewayManagedBy }) {
  const place = DISTRIBUTION_LABELS[managedBy.target] ?? managedBy.target
  return (
    <div
      data-testid="managed-by-app"
      className="flex items-start gap-3 rounded-lg border border-violet-200 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-950/30"
    >
      <Package className="mt-0.5 h-5 w-5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium text-violet-900 dark:text-violet-200">Managed in {managedBy.app.name}</p>
        <p className="text-sm text-violet-700 dark:text-violet-400">
          Who can use it, its look and its settings are on the app.{' '}
          <Link
            to={`/apps/${managedBy.app.slug}/distributions/${managedBy.target}`}
            className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
          >
            Open {place} in {managedBy.app.name}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </p>
      </div>
    </div>
  )
}
