/**
 * /memories/transfer -- copy the workspace's memory from one backend to
 * another.
 *
 * Streams items from the source's list into the target's batchPut.
 * Capabilities the source has and the target lacks (bi_temporal, ttl,
 * soft_delete, document mode) come back as warnings. A dry run reports
 * them without writing and keeps you on this page to read them; a real
 * transfer returns to the memory list.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { memoriesApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { memoryBackendName } from '@/components/memory/memory-words'

type TransferResult = {
  succeeded?: number
  total_source?: number
  warnings?: Array<string | { message?: string; code?: string }>
}

export function TransferMemoryForm() {
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const notify = useNotifications()
  const qc = useQueryClient()
  const [transfer, setTransfer] = useState({ source: 'almyty-native', target: 'mem0', dry_run: true })
  const [error, setError] = useState<string | undefined>()
  const [dryRunResult, setDryRunResult] = useState<TransferResult | null>(null)
  const guard = useLeaveGuard(false)

  const backendsQ = useQuery({
    queryKey: ['memories', 'backends'],
    queryFn: () => memoriesApi.listBackends(),
  })
  const backends = ((backendsQ.data ?? []) as Array<{ id: string }>).map((b) => b.id)

  const transferMut = useMutation({
    mutationFn: () =>
      memoriesApi.transfer({
        scope_type: 'workspace',
        scope_id: orgId!,
        source: transfer.source,
        target: transfer.target,
        mode: 'memory',
        dry_run: transfer.dry_run,
      }),
    onSuccess: (res: any) => {
      const r: TransferResult = res?.data ?? res ?? {}
      notify.success(
        transfer.dry_run ? 'Dry run complete' : 'Transfer complete',
        `${r.succeeded ?? 0} of ${r.total_source ?? 0} items, ${r.warnings?.length ?? 0} warnings`,
      )
      if (transfer.dry_run) {
        setDryRunResult(r)
        return
      }
      // What was transferred and which backend is healthy both just changed.
      qc.invalidateQueries({ queryKey: ['memories', 'list', orgId] })
      qc.invalidateQueries({ queryKey: ['memories', 'backends', 'health'] })
      guard.leave('/memories')
    },
    onError: (err: any) => notify.error('Transfer failed', err?.message ?? String(err)),
  })

  const submit = () => {
    if (transfer.source === transfer.target) {
      setError('Pick a target different from the source.')
      return
    }
    setError(undefined)
    setDryRunResult(null)
    transferMut.mutate()
  }

  const set = (patch: Partial<typeof transfer>) => {
    setTransfer((t) => ({ ...t, ...patch }))
    setError(undefined)
    setDryRunResult(null)
  }

  return (
    <FormPage
      title="Move memories to another service"
      description="Copies every memory from one storage service to another. Try it first to see what the new service cannot keep, such as history or expiry dates."
      back={{ to: '/memories', label: 'Memory' }}
      guard={guard}
      onSubmit={submit}
      submitLabel={transfer.dry_run ? 'Run dry run' : 'Transfer'}
      submitting={transferMut.isPending}
      submitDisabled={!orgId}
      width="narrow"
    >
      <FormSection>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="transfer-source" label="From">
            <Select value={transfer.source} onValueChange={(v) => set({ source: v })}>
              <SelectTrigger id="transfer-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                {backends.map((b) => <SelectItem key={b} value={b}>{memoryBackendName(b)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field id="transfer-target" label="To" error={error}>
            <Select value={transfer.target} onValueChange={(v) => set({ target: v })}>
              <SelectTrigger id="transfer-target"><SelectValue /></SelectTrigger>
              <SelectContent>
                {backends.map((b) => <SelectItem key={b} value={b}>{memoryBackendName(b)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="transfer-dry-run"
            checked={transfer.dry_run}
            onCheckedChange={(v) => set({ dry_run: v === true })}
          />
          <Label htmlFor="transfer-dry-run" className="font-normal">Dry run (show what would happen, move nothing)</Label>
        </div>
      </FormSection>
      {dryRunResult && (
        <FormSection title="Dry run result" description="Nothing was written. Untick dry run to transfer for real.">
          <p className="text-sm" data-testid="transfer-dry-run-result">
            {dryRunResult.succeeded ?? 0} of {dryRunResult.total_source ?? 0} items would transfer.
          </p>
          {(dryRunResult.warnings?.length ?? 0) > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-400">
              {dryRunResult.warnings!.map((w, i) => (
                <li key={i}>{typeof w === 'string' ? w : w.message ?? w.code ?? JSON.stringify(w)}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No warnings.</p>
          )}
        </FormSection>
      )}
    </FormPage>
  )
}
