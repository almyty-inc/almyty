import React from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { HostingPanel } from '@/components/models/hosting/hosting-panel'
import { useHostedModels, useHostingActions } from '@/components/models/use-model-data'
import { readableModelName } from '@/lib/model-hosting'

/**
 * A model on your cloud that has no entry in the list yet (the backend
 * creates one with the request, so this is the rare leftover). Once it has
 * one, this page forwards to the model's own page.
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

  if (d?.modelId) return <Navigate to={`/models/${d.modelId}`} replace />
  if (!d) {
    return (
      <div className="space-y-4">
        {back}
        {hosted.deploymentsQuery.isLoading ? <Skeleton className="h-48 w-full" /> : <p className="text-muted-foreground">This model is not on any of your clouds.</p>}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        {back}
        <h1 className={cn("mt-1", DETAIL_TITLE_CLASSES)}>{readableModelName(d.modelRef)}</h1>
        <p className="text-muted-foreground">Hosted on your cloud. It gets its full entry in the list once your cloud reports it running.</p>
      </div>
      <Card>
        <CardContent className="pt-6">
          <HostingPanel deployment={d} adapters={hosted.adapters} versions={hosted.versions} budgets={hosted.budgets} onScale={actions.onScale} onTeardown={actions.onTeardown} busy={actions.busy} />
        </CardContent>
      </Card>
    </div>
  )
}
