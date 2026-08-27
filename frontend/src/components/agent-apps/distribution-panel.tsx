import React, { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useNotifications } from '@/store/app'
import {
  DISTRIBUTION_BLURBS,
  DISTRIBUTION_LABELS,
  PACKAGED_TARGETS,
  agentAppsApi,
  isBuildable,
  isChannelTarget,
  servesOverGateway,
  type AgentApp,
  type AppDistribution,
} from '@/lib/agent-apps'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { BuildPanel } from './build-panel'

/** Stands in for "the product's default", because a Select cannot take ''. */
const DEFAULT_AGENT = 'default'

export interface DistributionPanelProps {
  app: AgentApp
  distribution: AppDistribution
  /** Every agent in the org, so this surface can name one of the app's. */
  agents?: Array<{ id: string; name: string }>
  onSaved: () => void
}

/**
 * One distribution: what its medium needs, and how to actually ship it.
 *
 * Branding is not repeated here. It belongs to the app so the product
 * looks the same everywhere; this panel carries only what the medium
 * forces, which for a packaged target is an identity to sign under.
 */
export function DistributionPanel({
  app,
  distribution,
  agents = [],
  onSaved,
}: DistributionPanelProps) {
  const { success, error: errorNotif } = useNotifications()

  const [bundleId, setBundleId] = useState(
    (distribution.configuration?.bundleId as string) ?? `com.example.${app.slug}`,
  )

  const packaged = PACKAGED_TARGETS.includes(distribution.target)
  const channel = isChannelTarget(distribution.target)

  const { data: check } = useQuery({
    queryKey: ['agent-app-distribution-check', app.slug, distribution.target],
    queryFn: () => agentAppsApi.checkDistribution(app.slug, distribution.target),
  })

  // The certificate this distribution signs with. Kept on the
  // distribution rather than the app, because a customer can hold one
  // identity for macOS and another for Windows.
  const signingCredentialId =
    (distribution.configuration?.signingCredentialId as string | undefined) ?? ''

  // Which agent answers here. Empty means the product's default, which
  // is its first — stated rather than left to be inferred.
  const answeredBy = (distribution.configuration?.agentId as string | undefined) ?? ''
  const appAgents = app.agentIds
    .map((id) => agents.find((a) => a.id === id) ?? { id, name: id })
    .filter(Boolean)

  const live = distribution.status === 'live'

  const publish = useMutation({
    mutationFn: () =>
      live
        ? agentAppsApi.unpublishDistribution(app.slug, distribution.target)
        : agentAppsApi.publishDistribution(app.slug, distribution.target),
    onSuccess: () => {
      success(
        live ? 'Taken down' : 'Published',
        live
          ? 'It has stopped answering. Its settings and address are kept.'
          : 'It is answering now.',
      )
      onSaved()
    },
    onError: (err: any) =>
      errorNotif(
        live ? 'Could not take it down' : 'Could not publish',
        err?.response?.data?.message || 'Something went wrong.',
      ),
  })

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown> = {}) =>
      agentAppsApi.addDistribution(app.slug, distribution.target, {
        ...(distribution.configuration ?? {}),
        bundleId,
        ...patch,
      }),
    onSuccess: () => {
      success('Saved', 'Distribution updated.')
      onSaved()
    },
    onError: (err: any) =>
      errorNotif('Could not save', err?.response?.data?.message || 'Something went wrong.'),
  })

  return (
    <div className="mt-6 space-y-6">
      <p className="text-sm text-muted-foreground">
        {DISTRIBUTION_BLURBS[distribution.target]}
      </p>

      {check && !check.ok && (
        <ul className="space-y-2 rounded-md border border-amber-400 bg-amber-50 p-3 dark:bg-amber-950">
          {check.refusals.map((refusal) => (
            <li
              key={refusal.code}
              className="flex gap-2 text-xs text-amber-700 dark:text-amber-300"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{refusal.message}</span>
            </li>
          ))}
        </ul>
      )}

      {check?.ok && (
        <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
          <Check className="h-4 w-4" />
          Ready to ship
        </p>
      )}

      {packaged && (
        <div className="space-y-1.5">
          <Label htmlFor="dist-bundle-id">Bundle identifier</Label>
          <Input
            id="dist-bundle-id"
            value={bundleId}
            onChange={(e) => setBundleId(e.target.value)}
            placeholder="com.acme.assistant"
          />
          <p className="text-xs text-muted-foreground">
            Every signing toolchain needs one, and it must be yours rather than a placeholder.
          </p>
          <Button
            className="mt-2 w-full"
            disabled={save.isPending}
            onClick={() => save.mutate({})}
          >
            {save.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      )}

      {channel && (
        <p className="rounded-md border p-3 text-xs text-muted-foreground">
          This platform needs its own credentials. Add them under Gateways, then this
          distribution will use them.
        </p>
      )}

      {/* A product can carry several agents, and which one answers is
          per surface: a billing channel should be able to reach the
          billing agent. Only worth asking when there is a choice. */}
      {servesOverGateway(distribution.target) && appAgents.length > 1 && (
        <div className="space-y-1.5">
          <Label htmlFor="dist-agent">Answered by</Label>
          <Select
            value={answeredBy || DEFAULT_AGENT}
            onValueChange={(value) =>
              save.mutate({ agentId: value === DEFAULT_AGENT ? '' : value })
            }
          >
            <SelectTrigger id="dist-agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_AGENT}>
                {appAgents[0].name} (the product default)
              </SelectItem>
              {appAgents.slice(1).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Adding a distribution records where a product will ship.
          Publishing is the separate decision to let people reach it. */}
      {servesOverGateway(distribution.target) && (
        <div className="space-y-2">
          <Button
            className="w-full"
            variant={live ? 'outline' : 'default'}
            disabled={publish.isPending}
            onClick={() => publish.mutate()}
          >
            {publish.isPending
              ? live
                ? 'Taking it down...'
                : 'Publishing...'
              : live
                ? 'Take it down'
                : 'Publish'}
          </Button>
          <p className="text-xs text-muted-foreground">
            {live
              ? 'Taking it down stops it answering and keeps its address, so publishing again needs no re-registration.'
              : 'Publishing stands up the surface and points it at this product.'}
          </p>
        </div>
      )}

      {/* Builds run on our machines, so this is a button rather than a
          command to paste into a terminal. */}
      {isBuildable(distribution.target) && (
        <BuildPanel
          app={app}
          target={distribution.target}
          signingCredentialId={signingCredentialId}
          onSigningCredentialChange={(id) => save.mutate({ signingCredentialId: id })}
        />
      )}

      {distribution.lastBuild && (
        <div className="space-y-1 rounded-md border p-3 text-xs">
          <div className="font-medium">Last build</div>
          {distribution.lastBuild.error ? (
            <p className="text-destructive">{distribution.lastBuild.error}</p>
          ) : (
            <p className="text-muted-foreground">
              v{distribution.lastBuild.version ?? '?'} for{' '}
              {distribution.lastBuild.platform ?? 'unknown platform'}
              {distribution.lastBuild.signed ? ', signed' : ', unsigned'}
            </p>
          )}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        {DISTRIBUTION_LABELS[distribution.target]} · {distribution.status}
      </p>
    </div>
  )
}
