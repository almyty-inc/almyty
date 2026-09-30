/**
 * /memories/move -- move memories from one memory account to another.
 *
 * Pick the account they are in, whose memories (the organization's, an
 * agent's own, your own), and the account they go to; an account can be
 * added right here. "Check first" counts them and says what the target
 * cannot keep, without moving anything. Moving copies each memory to the
 * target and then deletes it from the source; the move's own page shows
 * its progress, and resumes it if it stopped.
 */
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { agentsApi, memoriesApi, type MemoryAccountRow, type MemoryMovePreview } from '@/lib/api'
import { pluralized } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import {
  AddMemoryAccountFlow,
  MEMORY_ACCOUNTS_PATH,
  MEMORY_MOVES_QUERY_KEY,
  NATIVE_ACCOUNT_ID,
  accountLabel,
  memoryMovePath,
  useMemoryAccountsOverview,
} from '@/components/memory/memory-accounts'
import type { Connection } from '@/types/connections'

type Whose = 'workspace' | 'agent' | 'user'

const WHOSE_LABELS: Record<Whose, string> = {
  workspace: "The organization's memories",
  agent: "One agent's own memories",
  user: 'Your own memories',
}

/** What a target cannot keep, in words. */
const LOSS_WORDS: Record<string, string> = {
  bi_temporal: 'the history of corrected memories',
  ttl: 'expiry dates (almyty deletes them there on schedule instead, where it can)',
  soft_delete: 'deleted memories',
  mode_document: 'documents',
}

export function MoveMemoriesForm() {
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const notify = useNotifications()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const overview = useMemoryAccountsOverview()
  const [created, setCreated] = useState<MemoryAccountRow | null>(null)
  const accounts = useMemo(() => {
    const list = overview.data?.accounts ?? []
    return created && !list.some((a) => a.id === created.id) ? [...list, created] : list
  }, [overview.data, created])

  const [from, setFrom] = useState(params.get('from') || NATIVE_ACCOUNT_ID)
  const [to, setTo] = useState('')
  const [whose, setWhose] = useState<Whose>('workspace')
  const [agentId, setAgentId] = useState('')
  const [kind, setKind] = useState<'memory' | 'document'>('memory')
  const [adding, setAdding] = useState(false)
  const [addService, setAddService] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ to?: string; agent?: string }>({})
  const [preview, setPreview] = useState<MemoryMovePreview | null>(null)
  const guard = useLeaveGuard(false)

  const agentsQ = useQuery({
    queryKey: ['agents-list'],
    queryFn: () => agentsApi.getAll(),
    enabled: whose === 'agent',
  })
  const agents: Array<{ id: string; name: string }> = Array.isArray(agentsQ.data) ? agentsQ.data : ((agentsQ.data as any)?.data ?? [])

  const sources = accounts.filter((a) => a.canMoveFrom)
  const targets = accounts.filter((a) => a.canMoveTo && a.id !== from)

  const body = () => ({
    source: from,
    target: to,
    scope_type: whose,
    scope_id: whose === 'agent' ? `${orgId}:agent:${agentId}` : orgId!,
    mode: kind,
  })

  const validate = (): boolean => {
    const next: typeof errors = {}
    if (!to) next.to = 'Pick the account to move them to.'
    else if (to === from) next.to = 'Pick a different account from the one they are in.'
    if (whose === 'agent' && !agentId) next.agent = 'Pick the agent.'
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const previewMut = useMutation({
    mutationFn: () => memoriesApi.previewMove(body()),
    onSuccess: (res) => setPreview(res),
    onError: (err: any) => notify.error('Could not check', err?.message ?? String(err)),
  })

  const startMut = useMutation({
    mutationFn: () => memoriesApi.startMove(body()),
    onSuccess: (move) => {
      qc.invalidateQueries({ queryKey: MEMORY_MOVES_QUERY_KEY })
      guard.leave(memoryMovePath(move.id))
    },
    onError: (err: any) => notify.error('Could not start the move', err?.message ?? String(err)),
  })

  const change = (fn: () => void) => {
    fn()
    setPreview(null)
    setErrors({})
  }

  const onConnected = (connection: Connection) => {
    const service = connection.connectorKey
    const row: MemoryAccountRow = {
      id: connection.id,
      service,
      serviceName: connection.connectorDisplayName ?? service,
      name: connection.name,
      accountLabel: connection.accountLabel ?? null,
      owner: connection.owner,
      health: { status: connection.health?.status ?? 'unknown', checkedAt: null, error: connection.health?.error ?? null },
      isDefault: false,
      canMoveFrom: true,
      canMoveTo: true,
    }
    setCreated(row)
    change(() => setTo(connection.id))
    setAdding(false)
    setAddService(null)
  }

  return (
    <FormPage
      title="Move memories"
      description="Copies each memory to the other account, then deletes it from this one. If the move stops part way, resume it from its page: nothing is copied twice."
      back={{ to: MEMORY_ACCOUNTS_PATH, label: 'Memory' }}
      guard={guard}
      onSubmit={() => {
        if (validate()) startMut.mutate()
      }}
      submitLabel="Move memories"
      submitting={startMut.isPending}
      submitDisabled={!orgId || overview.isLoading}
      footerStart={
        <button
          type="button"
          className="text-sm text-primary hover:underline disabled:opacity-50"
          disabled={previewMut.isPending || !orgId}
          onClick={() => {
            if (validate()) previewMut.mutate()
          }}
        >
          {previewMut.isPending ? 'Checking…' : 'Check first'}
        </button>
      }
      width="narrow"
    >
      <FormSection>
        <Field id="move-from" label="From">
          <Select value={from} onValueChange={(v) => change(() => setFrom(v))}>
            <SelectTrigger id="move-from"><SelectValue placeholder="Pick an account" /></SelectTrigger>
            <SelectContent>
              {sources.map((a) => <SelectItem key={a.id} value={a.id}>{accountLabel(a)}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>

        <Field id="move-whose" label="Whose memories">
          <Select value={whose} onValueChange={(v) => change(() => setWhose(v as Whose))}>
            <SelectTrigger id="move-whose"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(WHOSE_LABELS) as Whose[]).map((k) => <SelectItem key={k} value={k}>{WHOSE_LABELS[k]}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>

        {whose === 'agent' && (
          <Field id="move-agent" label="Agent" error={errors.agent}>
            <Select value={agentId} onValueChange={(v) => change(() => setAgentId(v))}>
              <SelectTrigger id="move-agent"><SelectValue placeholder={agentsQ.isLoading ? 'Loading agents' : 'Pick an agent'} /></SelectTrigger>
              <SelectContent>
                {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        )}

        <Field id="move-kind" label="What">
          <Select value={kind} onValueChange={(v) => change(() => setKind(v as 'memory' | 'document'))}>
            <SelectTrigger id="move-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="memory">Facts</SelectItem>
              <SelectItem value="document">Documents</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <div className="space-y-1.5">
          <Field id="move-to" label="To" error={errors.to}>
            {/* Radix reports '' while the value is briefly not among its items (an account added here): not a choice. */}
            <Select value={to} onValueChange={(v) => v && change(() => setTo(v))}>
              <SelectTrigger id="move-to"><SelectValue placeholder={targets.length ? 'Pick an account' : 'No other account yet'} /></SelectTrigger>
              <SelectContent>
                {targets.map((a) => <SelectItem key={a.id} value={a.id}>{accountLabel(a)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {!adding && (
            <p className="text-sm">
              <button type="button" className="inline-flex items-center gap-1 text-primary hover:underline" onClick={() => setAdding(true)} data-testid="move-add-account">
                <Plus className="h-3.5 w-3.5" aria-hidden /> Add an account here
              </button>
            </p>
          )}
          {adding && (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-4" data-testid="move-add-account-panel">
              <AddMemoryAccountFlow
                embedded
                services={overview.data?.services ?? []}
                service={addService}
                onPickService={setAddService}
                onConnected={onConnected}
                onCancel={() => {
                  setAdding(false)
                  setAddService(null)
                }}
              />
              {!addService && (
                <button type="button" className="text-sm text-muted-foreground hover:underline" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      </FormSection>

      {preview && (
        <FormSection title="What would move" description="Nothing was moved.">
          <p className="text-sm" data-testid="move-preview">
            {preview.more ? `More than ${preview.total}` : pluralized(preview.total, 'memory', 'memories')} would move.
          </p>
          {preview.warnings.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700 dark:text-amber-400">
              {preview.warnings.map((w, i) => (
                <li key={i}>
                  {pluralized(w.count, 'memory', 'memories')} would lose {LOSS_WORDS[w.capability] ?? w.field}.
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">The other account keeps everything these memories have.</p>
          )}
        </FormSection>
      )}
    </FormPage>
  )
}
