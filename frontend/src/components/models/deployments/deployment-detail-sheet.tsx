import { useEffect, useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'

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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useCopy } from '@/lib/clipboard'
import { BLANK, canScale, canTeardown, formatCents, isTerminalState } from '@/lib/deployments-api'
import { formatDateTime, formatRelativeTime } from '@/lib/utils'
import type { ModelAdapter, ModelDeployment, ModelVersion } from '@/types/deployments'
import { DeploymentStateBadge, deploymentStateLabel } from './deployment-state-badge'
import { adapterName, versionName } from './deployments-list'

export interface DeploymentDetailSheetProps {
  deployment: ModelDeployment | null
  adapters: ModelAdapter[]
  versions: ModelVersion[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onScale: (id: string, replicas: number) => void
  onTeardown: (id: string) => void
  onDelete: (id: string) => void
  busy?: boolean
}

type Confirm = { kind: 'scale'; replicas: number } | { kind: 'teardown' } | { kind: 'delete' } | null

export function DeploymentDetailSheet({ deployment, adapters, versions, open, onOpenChange, onScale, onTeardown, onDelete, busy }: DeploymentDetailSheetProps) {
  const copy = useCopy()
  const [replicasInput, setReplicasInput] = useState('')
  const [confirm, setConfirm] = useState<Confirm>(null)

  useEffect(() => {
    setReplicasInput(deployment?.desired?.replicas !== undefined ? String(deployment.desired.replicas) : '')
    setConfirm(null)
  }, [deployment?.id, deployment?.desired?.replicas])

  if (!deployment) return null
  const d = deployment
  const url = d.actual?.url
  const parsedReplicas = Number(replicasInput)
  const replicasValid = replicasInput.trim() !== '' && Number.isInteger(parsedReplicas) && parsedReplicas >= 0
  const replicasChanged = replicasValid && parsedReplicas !== d.desired?.replicas

  const runConfirm = () => {
    if (!confirm) return
    if (confirm.kind === 'scale') onScale(d.id, confirm.replicas)
    if (confirm.kind === 'teardown') onTeardown(d.id)
    if (confirm.kind === 'delete') onDelete(d.id)
    setConfirm(null)
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-3">
              {adapterName(adapters, d.providerType)}
              <DeploymentStateBadge state={d.state} />
            </SheetTitle>
            <SheetDescription>
              {versionName(versions, d.modelVersionId)} on {d.providerType}. Created {formatRelativeTime(d.createdAt)}.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-6">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Endpoint</h3>
              {url ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" title={url}>
                    {url}
                  </code>
                  <Button type="button" variant="outline" size="sm" onClick={() => copy(url, 'Endpoint URL')} aria-label="Copy endpoint URL">
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button asChild variant="ghost" size="sm" aria-label="Open endpoint URL">
                    <a href={url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No URL yet. The adapter reports one once the endpoint is ready.</p>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Desired vs actual</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <StateColumn
                  title="Desired"
                  rows={[
                    ['Replicas', d.desired?.replicas],
                    ['Min scale', d.desired?.minScale],
                    ['Max scale', d.desired?.maxScale],
                    ['Hardware', d.desired?.hardware],
                    ['Region', d.desired?.region],
                    ['Quantization', d.desired?.quantization],
                    ['Privacy tier', d.desired?.privacyTier],
                  ]}
                />
                <StateColumn
                  title="Actual"
                  rows={[
                    ['State', d.actual?.state],
                    ['Replicas', d.actual?.replicas],
                    ['Hardware', d.actual?.hardware],
                    ['Region', d.actual?.region],
                    ['Message', d.actual?.message],
                    ['Spent', d.actual?.spentCents !== undefined ? formatCents(d.actual.spentCents) : undefined],
                    ['Burn rate', d.actual?.ratePerHourCents !== undefined ? `${formatCents(d.actual.ratePerHourCents)}/h` : undefined],
                  ]}
                />
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Timeline</h3>
              <ol className="space-y-2 text-sm">
                <TimelineItem at={d.createdAt} label="Created" />
                {d.lastReconcileAt && <TimelineItem at={d.lastReconcileAt} label={`Last reconcile, now ${deploymentStateLabel(d.state)}`} />}
                {d.actual?.costObservedAt && <TimelineItem at={d.actual.costObservedAt} label="Cost observed" />}
                {!d.lastReconcileAt && <li className="text-muted-foreground">Not reconciled yet. The sweep runs every couple of minutes.</li>}
              </ol>
              {d.lastError && (
                <div role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  <div className="font-medium">Last error</div>
                  <div className="mt-1 break-words font-mono text-xs">{d.lastError}</div>
                </div>
              )}
            </section>

            {Object.keys(d.providerConfig ?? {}).length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Provider config</h3>
                <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1 text-sm">
                  {Object.entries(d.providerConfig).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="truncate text-muted-foreground">{k}</dt>
                      <dd className="truncate font-mono text-xs">{v === undefined || v === null || v === '' ? BLANK : String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            <Separator />

            <section className="space-y-4">
              <h3 className="text-sm font-semibold">Actions</h3>
              {canScale(d.state) && (
                <div className="space-y-1.5">
                  <Label htmlFor="deployment-replicas">Replicas</Label>
                  <div className="flex items-center gap-2">
                    <Input id="deployment-replicas" type="number" min={0} step={1} className="w-28" value={replicasInput} onChange={(e) => setReplicasInput(e.target.value)} disabled={busy} />
                    <Button type="button" variant="outline" disabled={!replicasChanged || busy} onClick={() => setConfirm({ kind: 'scale', replicas: parsedReplicas })}>
                      Scale
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">0 scales to zero. The change is applied on the next reconcile.</p>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {canTeardown(d.state) && (
                  <Button type="button" variant="destructive" disabled={busy} onClick={() => setConfirm({ kind: 'teardown' })}>
                    Tear down
                  </Button>
                )}
                {isTerminalState(d.state) && (
                  <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm({ kind: 'delete' })}>
                    Delete
                  </Button>
                )}
              </div>
            </section>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === 'scale' && `Scale to ${confirm.replicas} ${confirm.replicas === 1 ? 'replica' : 'replicas'}?`}
              {confirm?.kind === 'teardown' && 'Tear down this deployment?'}
              {confirm?.kind === 'delete' && 'Delete this deployment record?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === 'scale' && (confirm.replicas === 0 ? 'The endpoint stops serving and billing stops with it. Scale back up any time.' : 'The provider resizes the endpoint on the next reconcile. Costs change accordingly.')}
              {confirm?.kind === 'teardown' && 'The endpoint is removed from the provider. The weights stay in the registry, so you can deploy the version again.'}
              {confirm?.kind === 'delete' && 'Removes this row from the list. Nothing is running any more, so no provider resources are touched.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runConfirm} className={confirm?.kind === 'teardown' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}>
              {confirm?.kind === 'scale' && 'Scale'}
              {confirm?.kind === 'teardown' && 'Tear down'}
              {confirm?.kind === 'delete' && 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function StateColumn({ title, rows }: { title: string; rows: Array<[string, string | number | undefined | null]> }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <dl className="space-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate text-right font-medium" title={value === undefined || value === null ? undefined : String(value)}>
              {value === undefined || value === null || value === '' ? BLANK : String(value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function TimelineItem({ at, label }: { at: string; label: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
      <div>
        <div>{label}</div>
        <div className="text-xs text-muted-foreground" title={at}>
          {formatDateTime(at)} ({formatRelativeTime(at)})
        </div>
      </div>
    </li>
  )
}
