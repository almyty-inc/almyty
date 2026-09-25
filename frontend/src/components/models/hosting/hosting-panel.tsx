import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, ExternalLink, Play, Power, Square } from 'lucide-react'

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
import { useCopy } from '@/lib/clipboard'
import { BLANK, canScale, canTeardown, deploymentModelRef, formatCents } from '@/lib/deployments-api'
import { cloudAccountLabel, hostedStatus, hourlyCents, lineageFacts } from '@/lib/model-hosting'
import { formatDateTime, formatRelativeTime } from '@/lib/utils'
import type { ModelAdapter, ModelDeployment, ModelVersion, SpendBudgetSummary } from '@/types/deployments'
import { HostedStatusBadge } from './hosted-status-badge'
import { describeBudget } from './host-body'

export interface HostingPanelProps {
  deployment: ModelDeployment
  adapters: ModelAdapter[]
  /** Pinned weight records, only to read lineage facts off. */
  versions?: ModelVersion[]
  budgets?: SpendBudgetSummary[]
  onScale: (id: string, replicas: number) => void
  /** Shut down, and for a failed start, clean up what it left behind. The backend never deletes the record. */
  onTeardown: (id: string) => void
  busy?: boolean
}

/** Only what stops or removes something asks first; starting and resizing just happen. */
type Confirm = { kind: 'stop' } | { kind: 'teardown' } | { kind: 'cleanup' } | null

/** "meta-llama/Llama-3.1-8B-Instruct, pinned to 5206a32" from the stored reference. */
export function describeSource(reference: string): string {
  const scheme = reference.indexOf('://')
  if (scheme <= 0) return reference
  const body = reference.slice(scheme + 3)
  const at = body.lastIndexOf('@')
  if (at <= 0 || body.slice(at + 1).includes('/')) return body
  const pin = body.slice(at + 1)
  return `${body.slice(0, at)}, pinned to ${/^[0-9a-f]{40}$/i.test(pin) ? pin.slice(0, 7) : pin}`
}

/**
 * Everything about a model hosted on your own cloud account, shown on the
 * model itself: whether it is running, what it costs by the hour, the
 * budget that caps it, and the controls to start, stop, resize or shut it
 * down. Every control writes desired state; the reconcile loop is what
 * talks to the cloud.
 */
export function HostingPanel({ deployment: d, adapters, versions = [], budgets = [], onScale, onTeardown, busy }: HostingPanelProps) {
  const copy = useCopy()
  const [copiesInput, setCopiesInput] = useState('')
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    setCopiesInput(d.desired?.replicas !== undefined ? String(d.desired.replicas) : '')
    setConfirm(null)
  }, [d.id, d.desired?.replicas])

  const status = hostedStatus(d)
  const url = d.actual?.url
  const rate = hourlyCents(d)
  const budget = d.budgetId ? budgets.find((b) => b.id === d.budgetId) : undefined
  const version = d.modelVersionId ? versions.find((v) => v.id === d.modelVersionId) : undefined
  const lineage = lineageFacts({ base: version?.base ?? d.modelBase, quantization: d.desired?.quantization })
  const reference = deploymentModelRef(d, versions)
  const stopped = d.desired?.replicas === 0
  const parsedCopies = Number(copiesInput)
  const copiesValid = copiesInput.trim() !== '' && Number.isInteger(parsedCopies) && parsedCopies >= 0
  const copiesChanged = copiesValid && parsedCopies !== d.desired?.replicas

  const runConfirm = () => {
    if (!confirm) return
    if (confirm.kind === 'stop') onScale(d.id, 0)
    if (confirm.kind === 'teardown') onTeardown(d.id)
    if (confirm.kind === 'cleanup') onTeardown(d.id)
    setConfirm(null)
  }

  return (
    <section className="space-y-4" aria-label="Hosting" data-testid="hosting-panel">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{cloudAccountLabel(d.providerType, adapters)}</h3>
          <HostedStatusBadge deployment={d} />
        </div>
        <p className="text-xs text-muted-foreground">{status.hint}</p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Fact label="Cost per hour" value={rate !== null ? `${formatCents(rate)}/h` : 'Not reported yet'} />
        <Fact label="Spent so far" value={formatCents(d.actual?.spentCents)} />
        <Fact label="Budget" value={budget ? describeBudget(budget) : d.budgetId ? 'Set' : 'None'} wide />
        <Fact label="Copies running" value={`${d.actual?.replicas ?? BLANK} of ${d.desired?.replicas ?? BLANK}`} />
        <Fact label="Region" value={d.actual?.region ?? d.desired?.region ?? 'Cloud chooses'} />
        <Fact label="Hardware" value={d.actual?.hardware ?? d.desired?.hardware ?? 'Cloud default'} />
        <Fact label="Source" value={describeSource(reference)} wide mono />
        {lineage && <Fact label="Made from" value={lineage} wide />}
      </dl>
      {budget && <p className="text-xs text-muted-foreground">Reaching the budget stops the model, and billing with it.</p>}

      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">Endpoint</div>
        {url ? (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" title={url}>
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
          <p className="text-sm text-muted-foreground">No URL yet. Your cloud reports one once the model is up.</p>
        )}
      </div>

      {d.lastError && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <div className="font-medium">Last error</div>
          <div className="mt-1 break-words font-mono text-xs">{d.lastError}</div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {canScale(d.state) && stopped && (
          <Button type="button" size="sm" className="gap-1.5" disabled={busy} onClick={() => onScale(d.id, 1)}>
            <Play className="h-4 w-4" aria-hidden="true" />
            Start
          </Button>
        )}
        {canScale(d.state) && !stopped && (
          <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => setConfirm({ kind: 'stop' })}>
            <Square className="h-4 w-4" aria-hidden="true" />
            Stop
          </Button>
        )}
        {canTeardown(d.state) && (
          <Button type="button" size="sm" variant="destructive" className="gap-1.5" disabled={busy} onClick={() => setConfirm({ kind: 'teardown' })}>
            <Power className="h-4 w-4" aria-hidden="true" />
            Shut down
          </Button>
        )}
        {d.state === 'failed' && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirm({ kind: 'cleanup' })}>
            Clean up on your cloud
          </Button>
        )}
      </div>

      {canScale(d.state) && (
        <div className="space-y-1.5">
          <Label htmlFor="hosting-copies">Copies</Label>
          <div className="flex items-center gap-2">
            <Input id="hosting-copies" type="number" min={0} step={1} className="w-24" value={copiesInput} onChange={(e) => setCopiesInput(e.target.value)} disabled={busy} />
            <Button type="button" variant="outline" size="sm" disabled={!copiesChanged || busy} onClick={() => (parsedCopies === 0 ? setConfirm({ kind: 'stop' }) : onScale(d.id, parsedCopies))}>
              Apply
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">How many copies of the model run. 0 stops it; you are billed per copy per hour.</p>
        </div>
      )}

      <div className="rounded-lg border border-dashed">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setDetailsOpen((prev) => !prev)}
          aria-expanded={detailsOpen}
        >
          {detailsOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
          Technical details
        </button>
        {detailsOpen && (
          <div className="space-y-4 px-3 pb-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <StateColumn
                title="Asked for"
                rows={[
                  ['Copies', d.desired?.replicas],
                  ['Min copies', d.desired?.minScale],
                  ['Max copies', d.desired?.maxScale],
                  ['Hardware', d.desired?.hardware],
                  ['Region', d.desired?.region],
                  ['Quantization', d.desired?.quantization],
                  ['Privacy', d.desired?.privacyTier],
                ]}
              />
              <StateColumn
                title="Reported by your cloud"
                rows={[
                  ['State', d.actual?.state],
                  ['Copies', d.actual?.replicas],
                  ['Hardware', d.actual?.hardware],
                  ['Region', d.actual?.region],
                  ['Message', d.actual?.message],
                ]}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Exact source</div>
              <code className="block break-all rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs">{reference}</code>
            </div>
            {Object.keys(d.providerConfig ?? {}).length > 0 && (
              <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1 text-xs">
                {Object.entries(d.providerConfig).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="truncate text-muted-foreground">{k}</dt>
                    <dd className="truncate font-mono">{v === undefined || v === null || v === '' ? BLANK : String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <ol className="space-y-2 text-xs">
              <TimelineItem at={d.createdAt} label="Requested" />
              {d.lastReconcileAt && <TimelineItem at={d.lastReconcileAt} label={`Last checked, ${status.label.toLowerCase()}`} />}
              {d.actual?.costObservedAt && <TimelineItem at={d.actual.costObservedAt} label="Cost read from your cloud" />}
              {!d.lastReconcileAt && <li className="text-muted-foreground">Not checked yet. almyty looks every couple of minutes.</li>}
            </ol>
          </div>
        )}
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === 'stop' && 'Stop this model?'}
              {confirm?.kind === 'teardown' && 'Shut this model down?'}
              {confirm?.kind === 'cleanup' && 'Clean up on your cloud?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === 'stop' && 'It stops serving and your cloud stops billing for it. Start it again any time.'}
              {confirm?.kind === 'teardown' && 'It is removed from your cloud account and billing stops. The model stays in this list so runs that used it keep their history; host it again to bring it back.'}
              {confirm?.kind === 'cleanup' && 'almyty asks your cloud to remove anything the failed start left behind, so nothing keeps billing. The model stays in the list with its history.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runConfirm} variant={confirm?.kind === 'teardown' ? 'destructive' : undefined}>
              {confirm?.kind === 'stop' && 'Stop'}
              {confirm?.kind === 'teardown' && 'Shut down'}
              {confirm?.kind === 'cleanup' && 'Clean up'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function Fact({ label, value, wide, mono }: { label: string; value: string; wide?: boolean; mono?: boolean }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`truncate ${mono ? 'font-mono text-xs' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  )
}

function StateColumn({ title, rows }: { title: string; rows: Array<[string, string | number | undefined | null]> }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <dl className="space-y-1 text-xs">
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
        <div className="text-muted-foreground" title={at}>
          {formatDateTime(at)} ({formatRelativeTime(at)})
        </div>
      </div>
    </li>
  )
}
