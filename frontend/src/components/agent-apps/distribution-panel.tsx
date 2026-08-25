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
  type AgentApp,
  type AppDistribution,
} from '@/lib/agent-apps'
import { BuildPanel } from './build-panel'

export interface DistributionPanelProps {
  app: AgentApp
  distribution: AppDistribution
  onSaved: () => void
}

/**
 * One distribution: what its medium needs, and how to actually ship it.
 *
 * Branding is not repeated here. It belongs to the app so the product
 * looks the same everywhere; this panel carries only what the medium
 * forces, which for a packaged target is an identity to sign under.
 */
export function DistributionPanel({ app, distribution, onSaved }: DistributionPanelProps) {
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

  const save = useMutation({
    mutationFn: () =>
      agentAppsApi.addDistribution(app.slug, distribution.target, { bundleId }),
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
            onClick={() => save.mutate()}
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

      {/* Builds run on our machines, so this is a button rather than a
          command to paste into a terminal. */}
      {isBuildable(distribution.target) && (
        <BuildPanel app={app} target={distribution.target} />
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
