import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Brain, Plus, Trash2, Search, ArrowRightLeft, HeartPulse, Tags as TagsIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { memoriesApi, type MemoryTier, type MemoryMode } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { TeamFilter, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'

type Item = {
  id: string
  mode: MemoryMode
  scope_type: string
  scope_id: string
  content: string
  tier: MemoryTier | null
  tags: string[]
  embedding_status: 'pending' | 'ready' | 'failed' | 'skipped'
  valid_until: string | null
  created_at: string
}

type RankedItem = { item: Item; score: number; signal: 'vector' | 'fts' | 'hybrid' }

type Backend = {
  id: string
  capabilities: string[]
  modes: MemoryMode[]
}

const TIERS: MemoryTier[] = ['short', 'project', 'long', 'shared']

export function MemoriesPage() {
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const notify = useNotifications()
  const qc = useQueryClient()

  useEffect(() => {
    document.title = 'Memory | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const scope = orgId ? { scope_type: 'workspace' as const, scope_id: orgId } : null

  // ── tabs ────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<'browse' | 'search' | 'backends' | 'audit'>('browse')

  // ── browse + filters ────────────────────────────────────────────────
  const [tierFilter, setTierFilter] = useState<MemoryTier | 'all'>('all')
  const [modeFilter, setModeFilter] = useState<MemoryMode>('memory')
  // Memory items use scope_type/scope_id (workspace) not the org/team
  // visibility split, but the dropdown is rendered for UI parity with
  // the other list pages. `filterByTeamVisibility` is a no-op when items
  // lack a `visibility` field except for the 'org' filter, which would
  // hide everything — so we only let it apply once items carry it.
  const [teamFilter, setTeamFilter] = useState<TeamFilterValue>('all')

  const list = useQuery({
    queryKey: ['memories', 'list', orgId, modeFilter, tierFilter],
    enabled: !!scope,
    queryFn: () => memoriesApi.list({
      scope: scope!,
      mode: modeFilter,
      tier: tierFilter === 'all' ? undefined : tierFilter,
      limit: 100,
    }),
  })

  // ── search ──────────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<RankedItem[]>([])
  const [searching, setSearching] = useState(false)

  async function runSearch() {
    if (!scope || !query.trim()) return
    setSearching(true)
    try {
      const res: any = await memoriesApi.search({ scope, query, top_k: 20 })
      setSearchResults((res?.data ?? res ?? []) as RankedItem[])
    } catch (err: any) {
      notify.error('Search failed', err.message ?? String(err))
    } finally {
      setSearching(false)
    }
  }

  // ── put dialog ──────────────────────────────────────────────────────
  const [putOpen, setPutOpen] = useState(false)
  const [draft, setDraft] = useState({
    content: '',
    tier: 'short' as MemoryTier,
    tags: '',
    mode: 'memory' as MemoryMode,
    source_uri: '',
  })

  const putMut = useMutation({
    mutationFn: () => memoriesApi.put({
      mode: draft.mode,
      scope: scope!,
      content: draft.content,
      tier: draft.mode === 'memory' ? draft.tier : undefined,
      tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
      source_uri: draft.mode === 'document' ? draft.source_uri : undefined,
      source_version: draft.mode === 'document' ? 1 : undefined,
      provenance: {
        agent_id: null, session_id: null, collab_id: null,
        model: null, provider: null, tool_chain: ['ui_put'],
        created_by: 'user', source_backend: 'almyty-native',
      },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories', 'list', orgId] })
      setPutOpen(false)
      setDraft({ content: '', tier: 'short', tags: '', mode: 'memory', source_uri: '' })
      notify.success('Memory stored')
    },
    onError: (err: any) => {
      notify.error('Store failed', err.message ?? String(err))
    },
  })

  // ── delete ──────────────────────────────────────────────────────────
  const removeMut = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'soft' | 'hard' }) => memoriesApi.remove(id, mode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories', 'list', orgId] })
      notify.success('Deleted')
    },
  })

  // ── backends + transfer ─────────────────────────────────────────────
  const backendsQ = useQuery({
    queryKey: ['memories', 'backends'],
    queryFn: () => memoriesApi.listBackends(),
  })
  const healthQ = useQuery({
    queryKey: ['memories', 'backends', 'health'],
    queryFn: () => memoriesApi.backendsHealth(),
    enabled: tab === 'backends',
    refetchInterval: 30_000,
  })

  const [transferOpen, setTransferOpen] = useState(false)
  const [transfer, setTransfer] = useState({ source: 'almyty-native', target: 'mem0', dry_run: true })
  const transferMut = useMutation({
    mutationFn: () => memoriesApi.transfer({
      scope_type: scope!.scope_type, scope_id: scope!.scope_id,
      source: transfer.source, target: transfer.target,
      mode: 'memory', dry_run: transfer.dry_run,
    }),
    onSuccess: (res: any) => {
      const r = res?.data ?? res
      notify.success(
        transfer.dry_run ? 'Dry run complete' : 'Transfer complete',
        `${r.succeeded ?? 0} of ${r.total_source ?? 0} items, ${r.warnings?.length ?? 0} warnings`,
      )
      setTransferOpen(false)
    },
    onError: (err: any) => {
      notify.error('Transfer failed', err.message ?? String(err))
    },
  })

  // ── workspace config (per-scope routing + credentials) ─────────────
  const configQ = useQuery({
    queryKey: ['memories', 'config', orgId],
    queryFn: () => memoriesApi.getConfig('workspace', orgId!),
    enabled: !!orgId && tab === 'backends',
  })
  const updateConfigMut = useMutation({
    mutationFn: (patch: Parameters<typeof memoriesApi.updateConfig>[0]) =>
      memoriesApi.updateConfig(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories', 'config', orgId] })
      qc.invalidateQueries({ queryKey: ['memories', 'backends', 'health'] })
      notify.success('Saved')
    },
    onError: (err: any) => notify.error('Save failed', err.message ?? String(err)),
  })

  // Credentials list — for the "wire credential to backend" picker.
  const credsQ = useQuery({
    queryKey: ['credentials', 'memory-backend'],
    queryFn: async () => {
      const res: any = await import('@/lib/api').then((m) => m.credentialsApi.getAll())
      const list = (res?.data ?? res ?? []) as any[]
      return list.filter((c) => c?.type === 'memory_backend')
    },
    enabled: tab === 'backends',
  })

  // ── render ──────────────────────────────────────────────────────────
  if (!orgId) {
    return <div className="p-8"><EmptyState icon={Brain} title="No organization" description="Switch to an organization to view memory." /></div>
  }

  // `apiPost` already calls `extractData` which peels off the
  // { success, data } envelope, so memoriesApi.list() returns the
  // raw payload (`{ items: […], next_cursor }`). The earlier
  // `list.data?.data?.items` double-unwrap kept returning undefined
  // — i.e. the Memory page rendered "No memories yet" no matter how
  // many memories the org actually had.
  const rawItems: Item[] = (list.data?.items ?? []) as Item[]
  const items: Item[] = teamFilter === 'all' ? rawItems : filterByTeamVisibility(rawItems as any[], teamFilter) as Item[]
  const backends: Backend[] = (backendsQ.data ?? []) as Backend[]
  const health: Record<string, { ok: boolean; latency_ms: number }> = (healthQ.data ?? {}) as any

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Brain className="h-6 w-6" /> Memory</h1>
          <p className="text-sm text-muted-foreground">
            Canonical schema v1 — bi-temporal memory + document mode + multi-backend routing.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setTransferOpen(true)}>
            <ArrowRightLeft className="h-4 w-4 mr-2" /> Transfer
          </Button>
          <Button onClick={() => setPutOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> New memory
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="browse">Browse</TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
          <TabsTrigger value="backends">Backends</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        {/* ── Browse ─────────────────────────────────────────────── */}
        <TabsContent value="browse" className="space-y-4">
          <div className="flex gap-3">
            <Select value={modeFilter} onValueChange={(v) => setModeFilter(v as MemoryMode)}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="memory">Memory mode</SelectItem>
                <SelectItem value="document">Document mode</SelectItem>
              </SelectContent>
            </Select>
            <Select value={tierFilter} onValueChange={(v) => setTierFilter(v as any)}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tiers</SelectItem>
                {TIERS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <TeamFilter
              organizationId={orgId ?? undefined}
              value={teamFilter}
              onChange={setTeamFilter}
            />
          </div>

          {list.isLoading ? <LoadingSpinner /> : items.length === 0 ? (
            <EmptyState icon={Brain} title="No memories yet" description="Click 'New memory' to write one." />
          ) : (
            <div className="grid gap-3">
              {items.map((m) => (
                <Card key={m.id}>
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex gap-2 items-center mb-2 flex-wrap">
                          {m.tier && <Badge variant="outline">{m.tier}</Badge>}
                          <Badge variant="secondary">{m.mode}</Badge>
                          <Badge variant={m.embedding_status === 'ready' ? 'default' : 'outline'}>
                            embedding: {m.embedding_status}
                          </Badge>
                          {(m.tags ?? []).slice(0, 6).map((t) => (
                            <Badge key={t} variant="outline" className="font-normal"><TagsIcon className="h-3 w-3 mr-1" />{t}</Badge>
                          ))}
                        </div>
                        <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          {new Date(m.created_at).toLocaleString()} • id {m.id.slice(0, 8)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeMut.mutate({ id: m.id, mode: 'soft' })}
                        title="Soft delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Search ─────────────────────────────────────────────── */}
        <TabsContent value="search" className="space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Hybrid search (vector + FTS)…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                className="pl-9"
              />
            </div>
            <Button onClick={runSearch} disabled={searching || !query.trim()}>
              {searching ? <LoadingSpinner /> : 'Search'}
            </Button>
          </div>

          <div className="grid gap-3">
            {searchResults.map((r) => (
              <Card key={r.item.id}>
                <CardContent className="p-4">
                  <div className="flex gap-2 items-center mb-2">
                    <Badge variant="outline">{r.signal}</Badge>
                    <Badge>score: {r.score.toFixed(3)}</Badge>
                    {r.item.tier && <Badge variant="secondary">{r.item.tier}</Badge>}
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{r.item.content}</p>
                </CardContent>
              </Card>
            ))}
            {!searching && query && searchResults.length === 0 && (
              <p className="text-sm text-muted-foreground">No results.</p>
            )}
          </div>
        </TabsContent>

        {/* ── Backends ───────────────────────────────────────────── */}
        <TabsContent value="backends" className="space-y-4">
          <ConfigCard
            config={configQ.data}
            backends={backends}
            credentials={credsQ.data ?? []}
            saving={updateConfigMut.isPending}
            onSave={(patch) => updateConfigMut.mutate(patch)}
            orgId={orgId}
          />
          <p className="text-sm text-muted-foreground">
            Per-backend capabilities and live health below. Pinning a backend without a wired credential id falls back to almyty-native.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {backends.map((b) => {
              const h = health[b.id]
              return (
                <Card key={b.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base font-mono">{b.id}</CardTitle>
                      <Badge variant={h?.ok ? 'default' : 'outline'} className="flex items-center gap-1">
                        <HeartPulse className="h-3 w-3" />
                        {h?.ok ? `${h.latency_ms}ms` : 'unconfigured'}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Modes</p>
                      <div className="flex flex-wrap gap-1">
                        {b.modes.map((m) => <Badge key={m} variant="secondary">{m}</Badge>)}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Capabilities</p>
                      <div className="flex flex-wrap gap-1">
                        {b.capabilities.map((c) => (
                          <Badge key={c} variant="outline" className="font-mono text-xs">{c}</Badge>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </TabsContent>

        {/* ── Audit ──────────────────────────────────────────────── */}
        <TabsContent value="audit" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Per-tier soft-cap warnings logged when an agent wrote past the configured byte ceiling.
            Behavior is set per scope under Backends → Soft-cap behavior.
          </p>
          <ConsolidationCard orgId={orgId} />
          <SoftcapAuditList orgId={orgId} enabled={tab === 'audit'} />
        </TabsContent>
      </Tabs>

      {/* ── Put dialog ───────────────────────────────────────────── */}
      <Dialog open={putOpen} onOpenChange={setPutOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New memory</DialogTitle>
            <DialogDescription>
              Writes to the canonical store. Routes to whichever backend the scope is configured for.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Mode</Label>
                <Select value={draft.mode} onValueChange={(v) => setDraft({ ...draft, mode: v as MemoryMode })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="memory">memory</SelectItem>
                    <SelectItem value="document">document</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {draft.mode === 'memory' ? (
                <div>
                  <Label>Tier</Label>
                  <Select value={draft.tier} onValueChange={(v) => setDraft({ ...draft, tier: v as MemoryTier })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TIERS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div>
                  <Label>Source URI</Label>
                  <Input
                    placeholder="https://… or almyty:file/…"
                    value={draft.source_uri}
                    onChange={(e) => setDraft({ ...draft, source_uri: e.target.value })}
                  />
                </div>
              )}
            </div>
            <div>
              <Label>Content</Label>
              <Textarea
                rows={6}
                placeholder="The fact, preference, decision, or document body."
                value={draft.content}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              />
            </div>
            <div>
              <Label>Tags (comma-separated)</Label>
              <Input
                placeholder="user-pref, infrastructure"
                value={draft.tags}
                onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPutOpen(false)}>Cancel</Button>
            <Button onClick={() => putMut.mutate()} disabled={putMut.isPending || !draft.content.trim()}>
              {putMut.isPending ? <LoadingSpinner /> : 'Store'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Transfer dialog ──────────────────────────────────────── */}
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer memory between backends</DialogTitle>
            <DialogDescription>
              Streams items from the source's list into the target's batchPut. Capabilities the source
              has and the target lacks (bi_temporal, ttl, soft_delete, document mode) appear as warnings —
              dry run shows the warnings without writing.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Source</Label>
              <Select value={transfer.source} onValueChange={(v) => setTransfer({ ...transfer, source: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {backends.map((b) => <SelectItem key={b.id} value={b.id}>{b.id}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Target</Label>
              <Select value={transfer.target} onValueChange={(v) => setTransfer({ ...transfer, target: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {backends.map((b) => <SelectItem key={b.id} value={b.id}>{b.id}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="dry-run"
              type="checkbox"
              checked={transfer.dry_run}
              onChange={(e) => setTransfer({ ...transfer, dry_run: e.target.checked })}
            />
            <Label htmlFor="dry-run">Dry run (preview warnings, no writes)</Label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTransferOpen(false)}>Cancel</Button>
            <Button onClick={() => transferMut.mutate()} disabled={transferMut.isPending || transfer.source === transfer.target}>
              {transferMut.isPending ? <LoadingSpinner /> : transfer.dry_run ? 'Run dry-run' : 'Transfer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── ConfigCard ──────────────────────────────────────────────────────
//
// Per-scope routing + softcap behavior + credentials wiring. Reads the
// server-side workspace_config row and writes patches via /memory/canonical/config.
// Each backend that needs credentials gets a Select tied to the org's
// memory_backend credential rows; saving here is what makes the
// per-org credentials work I built actually usable from the product.

interface ConfigCardProps {
  config?: {
    scopeType: string
    scopeId: string
    embeddingModel: string
    embeddingDim: number
    softcapBehavior: 'reject' | 'warn_log' | 'silent'
    overrides: {
      routing?: {
        memory_backend?: string
        document_backend?: string
        mirror_backend?: string
        credentials?: Record<string, string>
      }
    } & Record<string, unknown>
  } | null
  backends: Backend[]
  credentials: Array<{ id: string; name: string; type: string }>
  saving: boolean
  orgId: string
  onSave: (patch: {
    scope_type: 'workspace'
    scope_id: string
    softcap_behavior?: 'reject' | 'warn_log' | 'silent'
    overrides?: Record<string, unknown>
  }) => void
}

function ConfigCard({ config, backends, credentials, saving, orgId, onSave }: ConfigCardProps) {
  const routing = config?.overrides?.routing ?? {}
  const memBackend = routing.memory_backend ?? 'almyty-native'
  const docBackend = routing.document_backend ?? 'almyty-native'
  const mirror = routing.mirror_backend ?? ''
  const creds = routing.credentials ?? {}
  const softcap = config?.softcapBehavior ?? 'warn_log'

  const externalBackends = backends.filter((b) => b.id !== 'almyty-native')

  function patch(next: Partial<typeof routing> | { softcap_behavior?: typeof softcap }) {
    const isSoftcap = 'softcap_behavior' in next
    if (isSoftcap) {
      onSave({
        scope_type: 'workspace',
        scope_id: orgId,
        softcap_behavior: (next as any).softcap_behavior,
      })
      return
    }
    onSave({
      scope_type: 'workspace',
      scope_id: orgId,
      overrides: {
        routing: { ...routing, ...next },
      },
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Routing & credentials for this workspace</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Memory-mode backend</Label>
            <Select value={memBackend} onValueChange={(v) => patch({ memory_backend: v })} disabled={saving}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {backends.filter((b) => b.modes.includes('memory')).map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Document-mode backend</Label>
            <Select value={docBackend} onValueChange={(v) => patch({ document_backend: v })} disabled={saving}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {backends.filter((b) => b.modes.includes('document')).map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Mirror backend (best-effort)</Label>
            <Select value={mirror || '__none__'} onValueChange={(v) => patch({ mirror_backend: v === '__none__' ? undefined : v })} disabled={saving}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {externalBackends.filter((b) => b.modes.includes('memory')).map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Soft-cap behavior</Label>
            <Select value={softcap} onValueChange={(v) => patch({ softcap_behavior: v as any })} disabled={saving}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="warn_log">warn_log</SelectItem>
                <SelectItem value="reject">reject</SelectItem>
                <SelectItem value="silent">silent</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label className="text-xs">Credentials per backend</Label>
          <p className="text-xs text-muted-foreground mb-2">
            Wire a memory_backend credential (managed in Credentials → Vault) to each external backend. Native needs no credential.
          </p>
          <div className="grid md:grid-cols-2 gap-2">
            {externalBackends.map((b) => (
              <div key={b.id} className="flex items-center gap-2">
                <span className="text-xs font-mono w-44 shrink-0">{b.id}</span>
                <Select
                  value={creds[b.id] ?? '__none__'}
                  onValueChange={(v) =>
                    patch({
                      credentials: { ...creds, [b.id]: v === '__none__' ? '' : v },
                    })
                  }
                  disabled={saving}
                >
                  <SelectTrigger className="flex-1"><SelectValue placeholder="(unconfigured)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">(unconfigured)</SelectItem>
                    {credentials.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            {credentials.length === 0 && (
              <p className="text-xs text-muted-foreground italic">
                No credentials of type <span className="font-mono">memory_backend</span> exist yet — add one from the Credentials page.
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}


// ── SoftcapAuditList ────────────────────────────────────────────────
interface SoftcapWarning {
  id: string
  memoryId: string
  scopeType: string
  scopeId: string
  tier: string | null
  mode: 'memory' | 'document'
  sizeBytes: number
  softCap: number
  at: string
}


// ── ConsolidationCard ───────────────────────────────────────────────
//
// Manual trigger button + last-run summary. The repeating BullMQ job
// runs every hour automatically; this is for "I just had a long
// session, consolidate now" or for forcing a run when the cadence
// hasn't fired yet.
function ConsolidationCard({ orgId }: { orgId: string }) {
  const notify = useNotifications()
  const [last, setLast] = useState<{ consolidated_facts: number; superseded: number; skipped: boolean; reason?: string } | null>(null)
  const mut = useMutation({
    mutationFn: (force: boolean) =>
      memoriesApi.consolidate({ scope_type: 'workspace', scope_id: orgId, force }),
    onSuccess: (res: any) => {
      const r = res?.data ?? res
      setLast(r)
      if (r.skipped) {
        notify.info('Consolidation skipped', r.reason)
      } else {
        notify.success(
          'Consolidation done',
          `${r.consolidated_facts} fact(s) written, ${r.superseded} short-tier row(s) superseded`,
        )
      }
    },
    onError: (err: any) => notify.error('Consolidation failed', err.message ?? String(err)),
  })

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Consolidation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Distills short-tier memories into durable long-tier facts via the org's LLM provider.
          Runs hourly when enabled in Backends config; you can also trigger it now.
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => mut.mutate(false)} disabled={mut.isPending}>
            {mut.isPending ? <LoadingSpinner /> : 'Run if eligible'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => mut.mutate(true)} disabled={mut.isPending}>
            Force run
          </Button>
        </div>
        {last && (
          <div className="text-xs text-muted-foreground">
            Last run: {last.skipped
              ? <>skipped — <span className="font-mono">{last.reason}</span></>
              : <><span className="font-mono">{last.consolidated_facts}</span> facts, <span className="font-mono">{last.superseded}</span> superseded</>
            }
          </div>
        )}
      </CardContent>
    </Card>
  )
}
function SoftcapAuditList({ orgId, enabled }: { orgId: string; enabled: boolean }) {
  const q = useQuery({
    queryKey: ['memories', 'softcap-warnings', orgId],
    queryFn: () => memoriesApi.listSoftcapWarnings('workspace', orgId, 100),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
  })
  // listSoftcapWarnings goes through apiGet → extractData, so q.data
  // is already the flat array.
  const rows: SoftcapWarning[] = Array.isArray(q.data) ? (q.data as SoftcapWarning[]) : []
  if (q.isLoading) return <LoadingSpinner />
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No soft-cap warnings recorded for this scope.</p>
  }
  return (
    <div className="grid gap-2">
      {rows.map((w) => (
        <Card key={w.id}>
          <CardContent className="p-3 flex items-center justify-between gap-4">
            <div>
              <div className="flex gap-2 items-center mb-1">
                <Badge variant="outline">{w.tier ?? w.mode}</Badge>
                <Badge variant="secondary" className="font-mono text-xs">
                  {(w.sizeBytes / 1024).toFixed(1)} KB / {(w.softCap / 1024).toFixed(0)} KB
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                memory {w.memoryId.slice(0, 8)} • {new Date(w.at).toLocaleString()}
              </p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
export default MemoriesPage
