import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { QueryError } from '@/components/ui/query-error'
import { Skeleton } from '@/components/ui/skeleton'
import { formatContextLength } from '@/components/models/catalog-columns'
import { EditModelForm } from '@/components/models/edit-model-form'
import { CapabilityBadges, PrivacyTierBadge, SelectableIndicator, ValidationBadge } from '@/components/models/model-badges'
import { ModelSourceBadge, modelSource } from '@/components/models/model-origin'
import { HostingPanel } from '@/components/models/hosting/hosting-panel'
import { useHostedModels, useHostingActions, useProviderMap } from '@/components/models/use-model-data'
import { getApiErrorMessage as errorMessage } from '@/lib/api-error'
import { isTerminalState } from '@/lib/deployments-api'
import { deploymentForCard, lineageFacts, runsOn } from '@/lib/model-hosting'
import { formatModelPrice, modelsApi, PRICING_SOURCE_LABELS } from '@/lib/models-api'
import { formatRelativeTime } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { LEAVE_WITHOUT_ASKING } from '@/hooks/use-leave-guard'
import type { ModelDeployment } from '@/types/deployments'
import type { ModelCard, UpdateModelBody } from '@/types/models'

/** Why a model is not usable, in one sentence, or null when it is. */
export function whyNotUsable(card: Pick<ModelCard, 'selectable' | 'status' | 'validationStatus' | 'providerId' | 'endpointRef'>, hosted?: ModelDeployment): string | null {
  if (card.selectable) return null
  if (hosted && card.status !== 'active') return 'It becomes usable once it is running on your cloud and a validation run passes.'
  if (card.status !== 'active') return `Its status is ${card.status}. Set it active to use it.`
  if (!card.providerId && !card.endpointRef?.url) return 'Nothing can call it: it has no inference provider.'
  if (card.validationStatus === 'failed') return 'The last validation run failed. Fix the cause and validate again.'
  return 'Validate it once to make it usable. A validation run makes one real call.'
}

/**
 * One model, all of it, on its own page: where it runs, what it costs,
 * whether agents may use it and why not, its settings (edited in place),
 * and for a model hosted on your cloud its running state, hourly cost,
 * budget and controls. Hosting is part of the model, not a separate thing
 * to find elsewhere.
 */
export function ModelDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const [confirmRemove, setConfirmRemove] = useState(false)

  const cardQuery = useQuery({ queryKey: ['models', 'detail', id], queryFn: () => modelsApi.get(id), enabled: !!id })
  const { providers } = useProviderMap()
  const hostedModels = useHostedModels()
  const hosting = useHostingActions(hostedModels.orgId)
  const card = cardQuery.data ?? null
  const hosted = card ? deploymentForCard(card, hostedModels.deployments) : undefined

  useEffect(() => {
    document.title = card ? `${card.name} | Models | almyty` : 'Models | almyty'
    return () => { document.title = 'almyty' }
  }, [card])

  // #settings (from Edit settings in the list) lands on the inline form.
  const location = useLocation()
  useEffect(() => {
    if (card && location.hash === '#settings') document.getElementById('settings')?.scrollIntoView?.({ block: 'start' })
  }, [card, location.hash])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['models'] })

  const validate = useMutation({
    mutationFn: () => modelsApi.validate(id),
    onSettled: invalidate,
    onSuccess: (result) => {
      if (result?.passed) notifications.success('Validation passed', `${card?.name ?? 'The model'} answered in ${result.latencyMs} ms and is now usable.`)
      else notifications.error('Validation failed', result?.error || `${card?.name ?? 'The model'} did not answer the validation call.`)
    },
    onError: (error: any) => notifications.error('Validation failed', errorMessage(error, 'The model did not answer the validation call.')),
  })
  const update = useMutation({
    mutationFn: ({ body }: { id: string; body: UpdateModelBody }) => modelsApi.update(id, body),
    onSuccess: () => {
      invalidate()
      notifications.success('Model updated', 'Changes saved')
    },
    onError: (error: any) => notifications.error('Could not update model', errorMessage(error, 'Changes were not saved')),
  })
  const remove = useMutation({
    mutationFn: () => modelsApi.remove(id),
    onSuccess: () => {
      invalidate()
      notifications.success('Model removed', 'The model is no longer in the list')
      // The Remove confirm was the one question; unsaved settings edits
      // went with the model, so the leave guard is not asked again.
      navigate('/models', { state: LEAVE_WITHOUT_ASKING })
    },
    onError: (error: any) => notifications.error('Could not remove model', errorMessage(error, 'The model was not removed')),
  })

  const back = (
    <Link to="/models" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Models
    </Link>
  )

  if (cardQuery.isError) {
    return (
      <div className="space-y-4">
        {back}
        <QueryError error={cardQuery.error} onRetry={() => cardQuery.refetch()} title="Couldn't load this model" />
      </div>
    )
  }
  if (!card) {
    return (
      <div className="space-y-4" aria-busy="true">
        {back}
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  const source = card.pricingOverride ? 'manual' : card.pricingSource
  const reason = whyNotUsable(card, hosted)
  const stillRunning = !!hosted && !isTerminalState(hosted.state)
  const provider = card.providerId && providers[card.providerId] && !hosted ? providers[card.providerId] : null
  const lineage = !hosted ? lineageFacts({ base: card.base }) : null
  const where = runsOn(card, providers, hostedModels.adapters, hosted)

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-2">
        {back}
        <h1 className={DETAIL_TITLE_CLASSES}>{card.name}</h1>
        <p className="break-all font-mono text-sm text-muted-foreground">{card.vendorModelId}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <ModelSourceBadge source={modelSource(card, hosted)} />
          <PrivacyTierBadge tier={card.privacyTier} />
          <ValidationBadge card={card} />
        </div>
      </div>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <SelectableIndicator selectable={card.selectable} />
          {reason && <p className="text-sm text-muted-foreground">{reason}</p>}
          {card.validationStatus === 'failed' && card.lastValidationError && (
            <p className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-xs text-destructive">{card.lastValidationError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={validate.isPending} onClick={() => validate.mutate()}>
              {validate.isPending ? 'Validating...' : 'Validate'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={stillRunning}
              title={stillRunning ? 'Shut it down on your cloud first' : undefined}
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </Button>
          </div>
          {stillRunning && <p className="text-xs text-muted-foreground">To remove it, shut it down on your cloud first, so nothing keeps billing.</p>}

          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 pt-2 text-sm sm:grid-cols-2">
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-xs text-muted-foreground">Runs on</dt>
              <dd className="break-words">
                {where}
                {card.region ? `, ${card.region}` : ''}
              </dd>
              {provider && (
                <dd className="text-xs">
                  <Link to={`/llm-providers/${provider.id}`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    Through the inference provider {provider.name}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </dd>
              )}
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Price / MTok</dt>
              <dd>{formatModelPrice(card.effectivePricing)}</dd>
              <dd className="text-xs text-muted-foreground">{PRICING_SOURCE_LABELS[source] || source}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Context</dt>
              <dd>{formatContextLength(card.contextLength)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Latency (p50)</dt>
              <dd>{card.measuredLatencyMs?.p50 ? `${Math.round(card.measuredLatencyMs.p50)} ms` : 'Not measured'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last validated</dt>
              <dd>{card.lastValidatedAt ? formatRelativeTime(card.lastValidatedAt) : 'Never'}</dd>
            </div>
            {lineage && (
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Made from</dt>
                <dd>{lineage}</dd>
              </div>
            )}
            <div className="sm:col-span-2">
              <dt className="mb-1 text-xs text-muted-foreground">Capabilities</dt>
              <dd>
                <CapabilityBadges capabilities={card.capabilities} />
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {hosted && (
        <section aria-labelledby="hosting-heading" className="space-y-3">
          <h2 id="hosting-heading" className="text-lg font-semibold">On your cloud</h2>
          <Card>
            <CardContent className="pt-6">
              <HostingPanel
                deployment={hosted}
                adapters={hostedModels.adapters}
                versions={hostedModels.versions}
                budgets={hostedModels.budgets}
                onScale={hosting.onScale}
                onTeardown={hosting.onTeardown}
                busy={hosting.busy}
              />
            </CardContent>
          </Card>
        </section>
      )}

      <section id="settings" aria-labelledby="settings-heading" className="scroll-mt-6 space-y-3">
        <h2 id="settings-heading" className="text-lg font-semibold">Settings</h2>
        <Card>
          <CardContent className="pt-6">
            <EditModelForm card={card} onSubmit={(cardId, body) => update.mutateAsync({ id: cardId, body }).catch(() => undefined)} submitting={update.isPending} />
          </CardContent>
        </Card>
      </section>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this model?</AlertDialogTitle>
            <AlertDialogDescription>Agents routed to it pick another model; agents pinned to it fail until repointed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
