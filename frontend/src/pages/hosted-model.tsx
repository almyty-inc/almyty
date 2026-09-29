import React from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { HostingPanel } from '@/components/models/hosting/hosting-panel'
import { useHostedModels, useHostingActions } from '@/components/models/use-model-data'
import { readableModelName } from '@/lib/model-hosting'

/**
 * An open model almyty runs on your own cloud account: whether it is
 * running, what it costs by the hour, and the controls to start, stop or
 * shut it down. The cloud account's provider page lists the same models.
 */
export function HostedModelPage() {
  const { deploymentId = '' } = useParams<{ deploymentId: string }>()
  const hosted = useHostedModels()
  const actions = useHostingActions(hosted.orgId)
  const d = hosted.deployments.find((x) => x.id === deploymentId)

  const back = (
    <Link to="/models" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Models
    </Link>
  )

  if (!d) {
    return (
      <div className="space-y-4">
        {back}
        {hosted.deploymentsQuery.isLoading ? <Skeleton className="h-48 w-full" /> : <p className="text-muted-foreground">This model is not running on any of your cloud accounts.</p>}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        {back}
        <h1 className={cn('mt-1', DETAIL_TITLE_CLASSES)}>{readableModelName(d.modelRef)}</h1>
        <p className="text-muted-foreground">Runs on your own cloud account. Agents can pick it like any other model once it is up.</p>
      </div>
      <Card>
        <CardContent className="pt-6">
          <HostingPanel deployment={d} adapters={hosted.adapters} versions={hosted.versions} budgets={hosted.budgets} onScale={actions.onScale} onTeardown={actions.onTeardown} busy={actions.busy} />
        </CardContent>
      </Card>
    </div>
  )
}
