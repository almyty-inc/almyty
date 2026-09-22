import React, { Suspense, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { CatalogTab } from '@/components/models/catalog-tab'
import { LlmProvidersPage } from '@/pages/llm-providers'

// Deployments and Versions are separate chunks: each pulls its own adapter
// schemas and registry client, and most visits stop at the catalog.
const DeploymentsTab = lazy(() => import('@/components/models/deployments-tab').then((m) => ({ default: m.DeploymentsTab })))
const VersionsTab = lazy(() => import('@/components/models/versions-tab').then((m) => ({ default: m.VersionsTab })))

export const MODELS_TABS = ['catalog', 'deployments', 'providers', 'versions'] as const
export type ModelsTab = (typeof MODELS_TABS)[number]

function TabFallback() {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

/**
 * The Models page. The catalog is the centre of it: which models this
 * organization can run right now, wherever they run. Deployments put a
 * model on a provider, Providers holds the vendor keys everything
 * dispatches through, and Tracked artifacts is the operator's optional
 * record of their own weights.
 */
export function ModelsPage() {
  useEffect(() => {
    document.title = 'Models | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('tab')
  const activeTab: ModelsTab = (MODELS_TABS as readonly string[]).includes(requested || '') ? (requested as ModelsTab) : 'catalog'

  const setTab = (tab: string) => {
    const next = new URLSearchParams(searchParams)
    if (tab === 'catalog') next.delete('tab')
    else next.set('tab', tab)
    setSearchParams(next)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-violet-500 to-cyan-400 bg-clip-text text-transparent">Models</h1>
        <p className="text-muted-foreground">
          Every model your agents can call, wherever it runs, and what it costs. Run one vendor or several together. almyty does not host models; it runs them through the providers.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="deployments">Deployments</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="versions">Tracked artifacts</TabsTrigger>
        </TabsList>
        <TabsContent value="catalog" className="mt-4">
          <CatalogTab />
        </TabsContent>
        <TabsContent value="deployments" className="mt-4">
          <Suspense fallback={<TabFallback />}>
            <DeploymentsTab />
          </Suspense>
        </TabsContent>
        <TabsContent value="versions" className="mt-4">
          <Suspense fallback={<TabFallback />}>
            <VersionsTab />
          </Suspense>
        </TabsContent>
        <TabsContent value="providers" className="mt-4">
          <LlmProvidersPage embedded />
        </TabsContent>
      </Tabs>
    </div>
  )
}
