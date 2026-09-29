import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Brain, Plus, Trash2, Search, ArrowRightLeft, HeartPulse, Tags as TagsIcon, Building2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Disclosure } from '@/components/ui/disclosure'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/layout/page-header'
import { PageIntro } from '@/components/onboarding/page-intro'
import { Link } from 'react-router-dom'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { QueryError } from '@/components/ui/query-error'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { memoriesApi, type MemoryTier, type MemoryMode } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { TeamFilter, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'
import { ConnectAccountButton } from '@/components/connections/connect-flow'
import type { Connection } from '@/types/connections'
import { MEMORY_TIER_LABELS, memoryBackendName } from '@/components/memory/memory-words'

/**
 * Memory, in plain words.
 *
 * The page used to open on "Memory mode", "All scopes", "embedding:
 * ready" badges, a "Hybrid search (vector + FTS)" box and a Backends tab
 * of raw ids, capability flags and soft-cap enums. A person looking at it
 * wants to know what their agents remember and to fix a wrong fact. So:
 * two tabs for that (Memories, Search), one for where memories are kept
 * (Storage), and everything an operator tunes -- other storage services,
 * size limits, tidying, the service health cards -- under the shared
 * Advanced disclosure on Storage.
 */

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
  const [tab, setTab] = useState<'browse' | 'search' | 'storage'>('browse')

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

  const { confirm, dialog: confirmDialog } = useConfirm()
  const removeMut = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'soft' | 'hard' }) => memoriesApi.remove(id, mode),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories', 'list', orgId] })
      // Removing frees capacity, so the soft-cap warnings the sibling
      // key holds are stale too.
      qc.invalidateQueries({ queryKey: ['memories', 'softcap-warnings', orgId] })
      notify.success('Memory deleted')
    },
    // Without this a rejected delete left the row in place and said nothing.
    onError: (err: any) => {
      notify.error('Failed to delete memory', err?.message ?? String(err))
    },
  })

  // ── storage services ────────────────────────────────────────────────
  const backendsQ = useQuery({
    queryKey: ['memories', 'backends'],
    queryFn: () => memoriesApi.listBackends(),
  })
  const healthQ = useQuery({
    queryKey: ['memories', 'backends', 'health'],
    queryFn: () => memoriesApi.backendsHealth(),
    enabled: tab === 'storage',
    refetchInterval: 30_000,
  })

  // ── workspace config (per-scope routing + credentials) ─────────────
  const configQ = useQuery({
    queryKey: ['memories', 'config', orgId],
    queryFn: () => memoriesApi.getConfig('workspace', orgId!),
    enabled: !!orgId && tab === 'storage',
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
    enabled: tab === 'storage',
  })

  // ── render ──────────────────────────────────────────────────────────
  if (!orgId) {
    return (
      <EmptyState
        variant="panel"
        icon={Building2}
        title="No organization selected"
        description="Select or create an organization to see its memory."
      />
    )
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
    <div className="space-y-6">
      <PageHeader
        title="Memory"
        description="Facts your agents keep between runs, so they do not start from scratch every time."
        actions={
          <Button asChild>
            <Link to="/memories/new"><Plus className="h-4 w-4 mr-2" /> Add memory</Link>
          </Button>
        }
      />
      <PageIntro topic="memories" />

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="browse">Memories</TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
        </TabsList>

        {/* ── Memories ───────────────────────────────────────────── */}
        <TabsContent value="browse" className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Select value={modeFilter} onValueChange={(v) => setModeFilter(v as MemoryMode)}>
              <SelectTrigger className="w-[160px]" aria-label="Kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="memory">Facts</SelectItem>
                <SelectItem value="document">Documents</SelectItem>
              </SelectContent>
            </Select>
            <Select value={tierFilter} onValueChange={(v) => setTierFilter(v as any)}>
              <SelectTrigger className="w-[200px]" aria-label="How long it is kept"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Kept for any length</SelectItem>
                {TIERS.map((t) => <SelectItem key={t} value={t}>{MEMORY_TIER_LABELS[t]}</SelectItem>)}
              </SelectContent>
            </Select>
            <TeamFilter
              organizationId={orgId ?? undefined}
              value={teamFilter}
              onChange={setTeamFilter}
            />
          </div>

          {/*
            A failed fetch is not an empty vault. Collapsing the two told
            an org with hundreds of memories that it has none, and
            offered a "New memory" button as the remedy.
          */}
          {list.isError ? (
            <QueryError error={list.error} onRetry={() => list.refetch()} title="Couldn't load memories" />
          ) : list.isLoading ? <LoadingSpinner /> : items.length === 0 ? (
            <EmptyState
              variant="panel"
              icon={Brain}
              title="No memories yet"
              description="Agents with memory turned on save facts here as they work and look them up next time. You can add one yourself too."
              action={
                <Button asChild>
                  <Link to="/memories/new"><Plus className="h-4 w-4 mr-2" /> Add memory</Link>
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3">
              {items.map((m) => (
                <Card key={m.id}>
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex gap-2 items-center mb-2 flex-wrap">
                          {m.tier && <Badge variant="outline">{MEMORY_TIER_LABELS[m.tier] ?? m.tier}</Badge>}
                          {m.mode === 'document' && <Badge variant="secondary">Document</Badge>}
                          {/* Only the case a person can act on: it will not come up in search. */}
                          {(m.embedding_status === 'pending' || m.embedding_status === 'failed') && (
                            <Badge variant="outline">{m.embedding_status === 'pending' ? 'Not in search yet' : 'Not searchable'}</Badge>
                          )}
                          {(m.tags ?? []).slice(0, 6).map((t) => (
                            <Badge key={t} variant="outline" className="font-normal"><TagsIcon className="h-3 w-3 mr-1" />{t}</Badge>
                          ))}
                        </div>
                        <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          Saved {formatDateTime(m.created_at)}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          const ok = await confirm({
                            title: 'Delete memory?',
                            description: `No agent will find this memory again. It starts "${m.content.slice(0, 80)}${m.content.length > 80 ? '…' : ''}".`,
                            confirmLabel: 'Delete memory',
                            destructive: true,
                          })
                          if (ok) removeMut.mutate({ id: m.id, mode: 'soft' })
                        }}
                        title="Delete memory"
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
                placeholder="Search what your agents remember…"
                aria-label="Search memories"
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
          <p className="text-xs text-muted-foreground">Finds memories by meaning as well as by the exact words, best matches first.</p>

          <div className="grid gap-3">
            {searchResults.map((r) => (
              <Card key={r.item.id}>
                <CardContent className="p-4">
                  {r.item.tier && (
                    <div className="flex gap-2 items-center mb-2">
                      <Badge variant="outline">{MEMORY_TIER_LABELS[r.item.tier] ?? r.item.tier}</Badge>
                    </div>
                  )}
                  <p className="text-sm whitespace-pre-wrap">{r.item.content}</p>
                </CardContent>
              </Card>
            ))}
            {!searching && query && searchResults.length === 0 && (
              <p className="text-sm text-muted-foreground">No results.</p>
            )}
          </div>
        </TabsContent>

        {/* ── Storage ────────────────────────────────────────────── */}
        <TabsContent value="storage" className="space-y-4">
          <ConfigCard
            config={configQ.data}
            backends={backends}
            credentials={credsQ.data ?? []}
            saving={updateConfigMut.isPending}
            onSave={(patch) => updateConfigMut.mutate(patch)}
            orgId={orgId}
          >
            <div className="space-y-2">
              <p className="text-sm font-medium">Storage services</p>
              <p className="text-xs text-muted-foreground">
                What each service can hold and whether it answers right now.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {backends.map((b) => {
                  const h = health[b.id]
                  return (
                    <Card key={b.id}>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-base">{memoryBackendName(b.id)}</CardTitle>
                          <Badge variant={h?.ok ? 'default' : 'outline'} className="flex items-center gap-1">
                            <HeartPulse className="h-3 w-3" />
                            {/*
                              Three states, not two: a probe in flight and a
                              backend that did not answer both used to read
                              as "unconfigured", so almyty-native -- which is
                              always configured -- showed a config error
                              while its own health check was still running.
                            */}
                            {healthQ.isLoading ? 'Checking…' : h?.ok ? `${h.latency_ms}ms` : h ? 'Unreachable' : 'Not set up'}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        <div className="flex flex-wrap gap-1">
                          {b.modes.map((m) => <Badge key={m} variant="secondary">{m === 'memory' ? 'Facts' : 'Documents'}</Badge>)}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {b.capabilities.map((c) => (
                            <Badge key={c} variant="outline" className="font-mono text-xs">{c}</Badge>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </div>
            <ConsolidationCard orgId={orgId} />
            <div className="space-y-2">
              <p className="text-sm font-medium">Too-big memories</p>
              <p className="text-xs text-muted-foreground">
                Each time an agent saved more than the size limit. What happens then is set above.
              </p>
              <SoftcapAuditList orgId={orgId} enabled={tab === 'storage'} />
            </div>
            <div>
              <Button variant="outline" asChild>
                <Link to="/memories/transfer"><ArrowRightLeft className="h-4 w-4 mr-2" /> Move memories to another service</Link>
              </Button>
            </div>
          </ConfigCard>
        </TabsContent>
      </Tabs>
      {/*
        The trash button sits inches from the memory body, so deleting used
        to happen on a single stray click with no way back. Confirm first,
        quoting enough of the memory that you know which one you picked.
      */}
      {confirmDialog}
    </div>
  )
}

// ── ConfigCard ──────────────────────────────────────────────────────
//
// Where this workspace keeps its memories, and the rest of the routing
// under Advanced. Reads the server-side workspace_config row and writes
// patches via /memory/canonical/config. Each external service that needs
// credentials gets a picker tied to the org's memory_backend credential
// rows.

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
  /** Operator detail rendered at the end of the Advanced section. */
  children?: React.ReactNode
}

function ConfigCard({ config, backends, credentials, saving, orgId, onSave, children }: ConfigCardProps) {
  const routing = config?.overrides?.routing ?? {}
  const memBackend = routing.memory_backend ?? 'almyty-native'
  const docBackend = routing.document_backend ?? 'almyty-native'
  const mirror = routing.mirror_backend ?? ''
  const creds = routing.credentials ?? {}
  const softcap = config?.softcapBehavior ?? 'warn_log'

  const externalBackends = backends.filter((b) => b.id !== 'almyty-native')
  // Accounts connected through the connect sheet during this visit, so the
  // picker can name them before the credentials list catches up.
  const [connected, setConnected] = useState<Record<string, Connection>>({})

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

  // The one choice most people ever make here: which service keeps the
  // memories. An outside service needs an account, so it is picked next
  // to where it is connected.
  const needsAccount = memBackend !== 'almyty-native'

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Where memories are kept</CardTitle>
          <CardDescription>
            almyty keeps them for you unless you pick another memory service. Most teams never change this.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-sm space-y-1.5">
            <Label htmlFor="memory-backend">Memory service</Label>
            <Select value={memBackend} onValueChange={(v) => patch({ memory_backend: v })} disabled={saving}>
              <SelectTrigger id="memory-backend"><SelectValue /></SelectTrigger>
              <SelectContent>
                {backends.filter((b) => b.modes.includes('memory')).map((b) => (
                  <SelectItem key={b.id} value={b.id}>{memoryBackendName(b.id)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {needsAccount && (
            <AccountPicker
              backendId={memBackend}
              value={creds[memBackend]}
              credentials={credentials}
              connected={connected[memBackend]}
              saving={saving}
              onPick={(id) => patch({ credentials: { ...creds, [memBackend]: id } })}
              onConnected={(connection) => {
                setConnected((prev) => ({ ...prev, [memBackend]: connection }))
                patch({ credentials: { ...creds, [memBackend]: connection.id } })
              }}
            />
          )}
        </CardContent>
      </Card>

      <Disclosure title="Advanced" summary="Documents, a backup copy, size limits, tidying up">
        <div className="grid md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="document-backend">Where documents are kept</Label>
            <Select value={docBackend} onValueChange={(v) => patch({ document_backend: v })} disabled={saving}>
              <SelectTrigger id="document-backend"><SelectValue /></SelectTrigger>
              <SelectContent>
                {backends.filter((b) => b.modes.includes('document')).map((b) => (
                  <SelectItem key={b.id} value={b.id}>{memoryBackendName(b.id)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mirror-backend">Also copy memories to</Label>
            <Select value={mirror || '__none__'} onValueChange={(v) => patch({ mirror_backend: v === '__none__' ? undefined : v })} disabled={saving}>
              <SelectTrigger id="mirror-backend"><SelectValue placeholder="Nowhere" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Nowhere</SelectItem>
                {externalBackends.filter((b) => b.modes.includes('memory')).map((b) => (
                  <SelectItem key={b.id} value={b.id}>{memoryBackendName(b.id)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">A best-effort second copy; a failed copy never blocks a save.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="softcap-behavior">When a memory is over the size limit</Label>
            <Select value={softcap} onValueChange={(v) => patch({ softcap_behavior: v as any })} disabled={saving}>
              <SelectTrigger id="softcap-behavior"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="warn_log">Save it and note it below</SelectItem>
                <SelectItem value="reject">Refuse to save it</SelectItem>
                <SelectItem value="silent">Save it without a note</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {externalBackends.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Accounts for other services</p>
            <p className="text-xs text-muted-foreground">
              The account each outside service signs in with. almyty's own storage needs none.
            </p>
            <div className="grid gap-2">
              {externalBackends.map((b) => (
                <AccountPicker
                  key={b.id}
                  backendId={b.id}
                  value={creds[b.id]}
                  credentials={credentials}
                  connected={connected[b.id]}
                  saving={saving}
                  onPick={(id) => patch({ credentials: { ...creds, [b.id]: id } })}
                  onConnected={(connection) => {
                    setConnected((prev) => ({ ...prev, [b.id]: connection }))
                    patch({ credentials: { ...creds, [b.id]: connection.id } })
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {children}
      </Disclosure>
    </div>
  )
}

function AccountPicker({
  backendId, value, credentials, connected, saving, onPick, onConnected,
}: {
  backendId: string
  value?: string
  credentials: Array<{ id: string; name: string }>
  connected?: Connection
  saving: boolean
  onPick: (id: string) => void
  onConnected: (connection: Connection) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-44 shrink-0 text-sm">{memoryBackendName(backendId)} account</span>
      <Select value={value || '__none__'} onValueChange={(v) => onPick(v === '__none__' ? '' : v)} disabled={saving}>
        <SelectTrigger className="min-w-[12rem] flex-1" aria-label={`${memoryBackendName(backendId)} account`}>
          <SelectValue placeholder="Not connected" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">Not connected</SelectItem>
          {credentials.map((c) => (
            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
          ))}
          {connected && !credentials.some((c) => c.id === connected.id) && (
            <SelectItem value={connected.id}>{connected.name} (just connected)</SelectItem>
          )}
        </SelectContent>
      </Select>
      <ConnectAccountButton kind="memory" label="Connect" onConnected={onConnected} />
    </div>
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
  const qc = useQueryClient()
  const [last, setLast] = useState<{ consolidated_facts: number; superseded: number; skipped: boolean; reason?: string } | null>(null)
  const mut = useMutation({
    mutationFn: (force: boolean) =>
      memoriesApi.consolidate({ scope_type: 'workspace', scope_id: orgId, force }),
    onSuccess: (res: any) => {
      const r = res?.data ?? res
      setLast(r)
      if (r.skipped) {
        notify.info('Nothing to tidy', r.reason)
      } else {
        notify.success(
          'Memories tidied',
          `${r.consolidated_facts} lasting fact(s) written, ${r.superseded} short-term note(s) folded in`,
        )
      }
      // The toast counts rows that the Memories tab was still listing unchanged.
      qc.invalidateQueries({ queryKey: ['memories', 'list', orgId] })
    },
    onError: (err: any) => notify.error('Tidying failed', err.message ?? String(err)),
  })

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Tidy up</p>
      <p className="text-xs text-muted-foreground">
        Turns short-term notes into a few lasting facts, using your organization's model. It runs by
        itself every hour; you can also run it now.
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => mut.mutate(false)} disabled={mut.isPending}>
          {mut.isPending ? <LoadingSpinner /> : 'Tidy up now'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => mut.mutate(true)} disabled={mut.isPending}>
          Tidy up even if it ran recently
        </Button>
      </div>
      {last && (
        <div className="text-xs text-muted-foreground">
          Last run: {last.skipped
            ? <>skipped: {last.reason}</>
            : <>{last.consolidated_facts} facts written, {last.superseded} notes folded in</>
          }
        </div>
      )}
    </div>
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
    return <p className="text-sm text-muted-foreground">None so far.</p>
  }
  return (
    <div className="grid gap-2">
      {rows.map((w) => (
        <Card key={w.id}>
          <CardContent className="p-3 flex items-center justify-between gap-4">
            <div>
              <div className="flex gap-2 items-center mb-1">
                <Badge variant="outline">{(w.tier && MEMORY_TIER_LABELS[w.tier as MemoryTier]) || (w.mode === 'document' ? 'Document' : 'Fact')}</Badge>
                <Badge variant="secondary" className="font-mono text-xs">
                  {(w.sizeBytes / 1024).toFixed(1)} KB of {(w.softCap / 1024).toFixed(0)} KB
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(w.at)}
              </p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
export default MemoriesPage
