import React, { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useNotifications } from '@/store/app'
import { agentsApi } from '@/lib/api'
import {
  DISTRIBUTION_LABELS,
  agentAppsApi,
  type DistributionTarget,
} from '@/lib/agent-apps'
import { AppCanvas } from '@/components/agent-apps/app-canvas'
import { AppAgentsPanel } from '@/components/agent-apps/app-agents-panel'
import { AppSettingsPanel } from '@/components/agent-apps/app-settings-panel'
import { AddDistributionDialog } from '@/components/agent-apps/add-distribution-dialog'
import { DistributionPanel } from '@/components/agent-apps/distribution-panel'

type OpenPanel =
  | { kind: 'agents' }
  | { kind: 'settings' }
  | { kind: 'distribution'; target: DistributionTarget }
  | null

/**
 * One app: what it is made of, and everywhere it ships.
 *
 * The canvas is the page rather than a tab on it. Editing happens in
 * panels opened from the node you clicked, so the thing you are
 * changing stays visible in context instead of being replaced by a
 * form.
 */
export function AppDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [panel, setPanel] = useState<OpenPanel>(null)
  const [addOpen, setAddOpen] = useState(false)

  const {
    data: app,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['agent-app', slug],
    queryFn: () => agentAppsApi.getById(slug),
    enabled: !!slug,
  })

  // Refetched alongside the app so the blockers on the product node
  // reflect the edit that was just saved, not the previous state.
  const { data: check } = useQuery({
    queryKey: ['agent-app-check', slug],
    queryFn: () => agentAppsApi.check(slug),
    enabled: !!app,
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.getAll(),
  })

  const agents = (() => {
    const raw = (agentsData as any)?.agents ?? agentsData
    return Array.isArray(raw) ? raw : []
  })()

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['agent-app', slug] })
    queryClient.invalidateQueries({ queryKey: ['agent-app-check', slug] })
  }

  const removeDistribution = useMutation({
    mutationFn: (target: DistributionTarget) => agentAppsApi.removeDistribution(slug, target),
    onSuccess: () => {
      success('Stopped shipping', 'That distribution has been removed.')
      setPanel(null)
      invalidate()
    },
    onError: (err: any) =>
      errorNotif('Could not remove', err?.response?.data?.message || 'Something went wrong.'),
  })

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }

  if (isError || !app) {
    return <QueryError error={error} onRetry={() => refetch()} />
  }

  const openDistribution = app.distributions?.find(
    (d) => panel?.kind === 'distribution' && d.target === panel.target,
  )

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <Link
            to="/apps"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            Apps
          </Link>
          <h1 className="truncate font-heading text-2xl font-semibold">
            {app.branding?.appName || app.name}
          </h1>
          <code className="text-xs text-muted-foreground">{app.slug}</code>
        </div>
      </div>

      <AppCanvas
        app={app}
        agents={agents}
        check={check}
        onSelectAgents={() => setPanel({ kind: 'agents' })}
        onSelectApp={() => setPanel({ kind: 'settings' })}
        onSelectDistribution={(target) => setPanel({ kind: 'distribution', target })}
        onAddDistribution={() => setAddOpen(true)}
      />

      <Sheet open={panel !== null} onOpenChange={(open) => !open && setPanel(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {panel?.kind === 'agents' && (
            <>
              <SheetHeader>
                <SheetTitle>Agents in this app</SheetTitle>
                <SheetDescription>
                  The first one is where a new conversation starts.
                </SheetDescription>
              </SheetHeader>
              <AppAgentsPanel
                app={app}
                agents={agents}
                onSaved={() => {
                  invalidate()
                  setPanel(null)
                }}
              />
            </>
          )}

          {panel?.kind === 'settings' && (
            <>
              <SheetHeader>
                <SheetTitle>App settings</SheetTitle>
                <SheetDescription>
                  Branding, who can use it, and what it may touch.
                </SheetDescription>
              </SheetHeader>
              <AppSettingsPanel app={app} onSaved={invalidate} />
            </>
          )}

          {panel?.kind === 'distribution' && openDistribution && (
            <>
              <SheetHeader>
                <SheetTitle>{DISTRIBUTION_LABELS[panel.target]}</SheetTitle>
                <SheetDescription>
                  How this app ships to {DISTRIBUTION_LABELS[panel.target]}.
                </SheetDescription>
              </SheetHeader>
              <DistributionPanel
                app={app}
                distribution={openDistribution}
                agents={agents}
                onSaved={invalidate}
              />
              <Button
                variant="ghost"
                className="mt-6 w-full text-destructive"
                disabled={removeDistribution.isPending}
                onClick={() => removeDistribution.mutate(panel.target)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Stop shipping to {DISTRIBUTION_LABELS[panel.target]}
              </Button>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AddDistributionDialog
        app={app}
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={invalidate}
      />
    </div>
  )
}

export default AppDetailPage
