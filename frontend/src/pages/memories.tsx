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
  const [tab, setTab] = useState<'browse' | 'search' | 'backends'>('browse')

  // ── browse + filters ────────────────────────────────────────────────
  const [tierFilter, setTierFilter] = useState<MemoryTier | 'all'>('all')
  const [modeFilter, setModeFilter] = useState<MemoryMode>('memory')

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

  // ── render ──────────────────────────────────────────────────────────
  if (!orgId) {
    return <div className="p-8"><EmptyState icon={Brain} title="No organization" description="Switch to an organization to view memory." /></div>
  }

  const items: Item[] = (list.data?.data?.items ?? []) as Item[]
  const backends: Backend[] = (backendsQ.data?.data ?? []) as Backend[]
  const health: Record<string, { ok: boolean; latency_ms: number }> = (healthQ.data?.data ?? {}) as any

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
          <p className="text-sm text-muted-foreground">
            Adapters available for routing. Pin a backend per scope under
            <span className="font-mono mx-1">memory_workspace_config.overrides.routing</span>
            and link the matching credential id from the Credentials tab.
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

export default MemoriesPage
