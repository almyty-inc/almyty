import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Check, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { EmptyState } from '@/components/ui/empty-state'
import { interfaceTypeIcons } from '@/components/agents/detail/constants'
import { useNotifications } from '@/store/app'
import { agentsApi } from '@/lib/api'
import {
  DISTRIBUTION_BLURBS,
  DISTRIBUTION_LABELS,
  agentAppsApi,
  type AppDistribution,
  type DistributionStatus,
  type DistributionTarget,
} from '@/lib/agent-apps'
import { AppAgentsPanel } from '@/components/agent-apps/app-agents-panel'
import { AppSettingsPanel } from '@/components/agent-apps/app-settings-panel'
import { AddDistributionDialog } from '@/components/agent-apps/add-distribution-dialog'
import { DistributionPanel } from '@/components/agent-apps/distribution-panel'

/** How each distribution status reads and colours in a badge. */
const STATUS: Record<DistributionStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  live: { label: 'Live', variant: 'default' },
  built: { label: 'Built', variant: 'secondary' },
  building: { label: 'Building', variant: 'outline' },
  draft: { label: 'Not shipped yet', variant: 'outline' },
  failed: { label: 'Build failed', variant: 'destructive' },
}

/**
 * One app: what it is made of, and everywhere it ships.
 *
 * Structured like every other detail page in the product — a header, a
 * row of tabbed sections, cards for the things it contains, and dialogs
 * for editing them. An app is a configuration entity, the same shape as
 * a gateway, so it is presented the same way rather than as a canvas.
 */
export function AppDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [editing, setEditing] = useState<DistributionTarget | null>(null)
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
      setEditing(null)
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

  const distributions = app.distributions ?? []
  const openDistribution = distributions.find((d) => d.target === editing)
  const refusals = check?.refusals ?? []

  return (
    <div className="space-y-8">
      {/* Header — matches the other detail pages: back link, name, slug,
          and the page's primary action on the right. */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/apps"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            Apps
          </Link>
          <h1 className="truncate font-heading text-2xl font-extrabold tracking-tight sm:text-4xl">
            {app.branding?.appName || app.name}
          </h1>
          <code className="text-xs text-muted-foreground">{app.slug}</code>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Ship somewhere
        </Button>
      </div>

      {/* What is stopping it from shipping, if anything — the same
          continuously-updated list, but as a banner rather than tucked
          inside a node. */}
      {refusals.length > 0 ? (
        <Card className="border-amber-400 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            Not ready to ship yet
          </div>
          <ul className="mt-2 space-y-1.5">
            {refusals.map((r) => (
              <li key={r.code} className="text-xs text-muted-foreground">
                {r.message}
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
          <Check className="h-4 w-4" />
          Ready to ship
        </p>
      )}

      <Tabs defaultValue="distributions" className="space-y-4">
        <TabsList>
          <TabsTrigger value="distributions">
            Distributions ({distributions.length})
          </TabsTrigger>
          <TabsTrigger value="agents">Agents ({app.agentIds.length})</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        {/* Distributions — cards, one per place the product ships, edited
            through a dialog like every other create/edit surface. */}
        <TabsContent value="distributions" className="space-y-4">
          {distributions.length === 0 ? (
            <EmptyState
              title="Not shipping anywhere yet"
              description="Ship this product to a web app, a terminal, a desktop app, or a messaging platform your users already use."
              action={
                <Button onClick={() => setAddOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Ship somewhere
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {distributions.map((distribution) => (
                <DistributionCard
                  key={distribution.target}
                  distribution={distribution}
                  onEdit={() => setEditing(distribution.target)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="agents">
          <Card className="p-6">
            <AppAgentsPanel app={app} agents={agents} onSaved={invalidate} />
          </Card>
        </TabsContent>

        <TabsContent value="settings">
          <Card className="p-6">
            <AppSettingsPanel app={app} onSaved={invalidate} />
          </Card>
        </TabsContent>
      </Tabs>

      {/* Editing a distribution — a centered dialog, the same pattern as
          every other edit in the product. */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          {openDistribution && (
            <>
              <DialogHeader>
                <DialogTitle>{DISTRIBUTION_LABELS[openDistribution.target]}</DialogTitle>
                <DialogDescription>
                  How this app ships to {DISTRIBUTION_LABELS[openDistribution.target]}.
                </DialogDescription>
              </DialogHeader>
              <DistributionPanel
                app={app}
                distribution={openDistribution}
                agents={agents}
                onSaved={invalidate}
              />
              <Button
                variant="ghost"
                className="mt-2 w-full text-destructive"
                disabled={removeDistribution.isPending}
                onClick={() => removeDistribution.mutate(openDistribution.target)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Stop shipping to {DISTRIBUTION_LABELS[openDistribution.target]}
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AddDistributionDialog
        app={app}
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={invalidate}
      />
    </div>
  )
}

/** One place the product ships to, as a card in the grid. */
function DistributionCard({
  distribution,
  onEdit,
}: {
  distribution: AppDistribution
  onEdit: () => void
}) {
  const status = STATUS[distribution.status] ?? STATUS.draft

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onEdit()
        }
      }}
      className="cursor-pointer p-4 transition-colors hover:border-primary/50"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-lg" aria-hidden>
            {interfaceTypeIcons[distribution.target] ?? '📦'}
          </span>
          <span className="truncate font-medium">
            {DISTRIBUTION_LABELS[distribution.target]}
          </span>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {DISTRIBUTION_BLURBS[distribution.target]}
      </p>
    </Card>
  )
}

export default AppDetailPage
