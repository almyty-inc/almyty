import { useState, type ReactNode } from 'react'
import { Copy } from 'lucide-react'

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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useCopy } from '@/lib/clipboard'
import { BLANK, formatBytes, manifestSummaryOf } from '@/lib/deployments-api'
import { formatDateTime, formatRelativeTime } from '@/lib/utils'
import type { ModelVersion } from '@/types/deployments'

export interface VersionDetailSheetProps {
  version: ModelVersion | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDelete: (id: string) => void
  onDeploy?: (version: ModelVersion) => void
  /** How many deployments still point at this version; blocks delete when > 0. */
  deploymentCount?: number
  busy?: boolean
}

export function VersionDetailSheet({ version, open, onOpenChange, onDelete, onDeploy, deploymentCount = 0, busy }: VersionDetailSheetProps) {
  const copy = useCopy()
  const [confirmDelete, setConfirmDelete] = useState(false)
  if (!version) return null
  const v = version
  const manifest = manifestSummaryOf(v)

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{v.name}</SheetTitle>
            <SheetDescription>
              {v.base}. Registered {formatRelativeTime(v.createdAt)}.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-6">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Registry URI</h3>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" title={v.registryUri}>
                  {v.registryUri}
                </code>
                <Button type="button" variant="outline" size="sm" onClick={() => copy(v.registryUri, 'Registry URI')} aria-label="Copy registry URI">
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Details</h3>
              <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1.5 text-sm">
                <Row label="Size" value={formatBytes(v.sizeBytes)} />
                <Row label="Manifest sha" value={v.manifestSha ? <span className="font-mono text-xs">{v.manifestSha}</span> : BLANK} />
                <Row
                  label="Quantizations"
                  value={
                    v.quantizations?.length ? (
                      <span className="flex flex-wrap gap-1">
                        {v.quantizations.map((q) => (
                          <Badge key={q} variant="secondary" className="font-mono text-[11px]">
                            {q}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      BLANK
                    )
                  }
                />
                <Row label="Parent version" value={v.lineage?.parentVersionId ?? BLANK} mono />
                <Row label="Dataset" value={v.lineage?.datasetRef ?? BLANK} mono />
                <Row label="Training job" value={v.lineage?.trainingJobId ?? BLANK} mono />
                <Row label="Created" value={formatDateTime(v.createdAt)} />
              </dl>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">Manifest</h3>
              {manifest ? (
                <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1.5 text-sm">
                  <Row label="License" value={manifest.license || BLANK} />
                  <Row label="Tokenizer" value={manifest.tokenizer || BLANK} mono />
                  <Row label="Chat template" value={manifest.chatTemplate ?? BLANK} />
                  <Row label="Weight files" value={Number.isFinite(manifest.fileCount) ? `${manifest.fileCount} ${manifest.fileCount === 1 ? 'file' : 'files'}` : BLANK} />
                  <Row label="Manifest created" value={manifest.created ? formatDateTime(manifest.created) : BLANK} />
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {v.metadata?.scheme === 'hf' || v.metadata?.scheme === 'file'
                    ? 'No almyty-manifest.json at this URI. Base and quantizations come from what was entered at registration.'
                    : 'No manifest summary from the registry for this version.'}
                </p>
              )}
            </section>

            <Separator />

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Actions</h3>
              <div className="flex flex-wrap gap-2">
                {onDeploy && (
                  <Button type="button" onClick={() => onDeploy(v)} disabled={busy}>
                    Deploy this version
                  </Button>
                )}
                <Button type="button" variant="destructive" disabled={busy || deploymentCount > 0} onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              </div>
              {deploymentCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {deploymentCount} {deploymentCount === 1 ? 'deployment points' : 'deployments point'} at this version. Tear them down first.
                </p>
              )}
            </section>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {v.name}?</AlertDialogTitle>
            <AlertDialogDescription>Removes the version record from almyty. The weights in the registry are not touched; register the same URI again to bring it back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setConfirmDelete(false)
                onDelete(v.id)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-xs' : 'truncate'}>{value}</dd>
    </div>
  )
}
