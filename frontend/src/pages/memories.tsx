import React, { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Brain, Plus, MoreHorizontal, Trash2, Pencil, Search, X, Sparkles, Tag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { DataTable, createActionsColumn } from '@/components/ui/data-table'
import { memoriesApi, agentsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import type { Memory, MemoryType, MemoryScope, PaginatedMemories } from '@/types'

// ── Constants ──

const MEMORY_TYPES: { value: MemoryType; label: string }[] = [
  { value: 'fact', label: 'Fact' },
  { value: 'preference', label: 'Preference' },
  { value: 'context', label: 'Context' },
  { value: 'episode', label: 'Episode' },
  { value: 'instruction', label: 'Instruction' },
]

const MEMORY_SCOPES: { value: MemoryScope; label: string }[] = [
  { value: 'agent', label: 'Agent' },
  { value: 'shared', label: 'Shared' },
  { value: 'global', label: 'Global' },
]

const TYPE_COLORS: Record<MemoryType, string> = {
  fact: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  preference: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
  context: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
  episode: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  instruction: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
}

const SCOPE_COLORS: Record<MemoryScope, string> = {
  agent: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  shared: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  global: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
}

// ── Helpers ──

function formatDate(date: string | null | undefined): string {
  if (!date) return 'Never'
  const d = new Date(date)
  const diff = Date.now() - d.getTime()
  if (diff < 60000) return 'Just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString()
}

function truncate(text: string, maxLength = 100): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

// ── Form state type ──

interface MemoryFormState {
  content: string
  type: MemoryType
  scope: MemoryScope
  agentIds: string[]
  tags: string
}

const EMPTY_FORM: MemoryFormState = {
  content: '',
  type: 'fact',
  scope: 'global',
  agentIds: [],
  tags: '',
}

// ── Main Page ──

export function MemoriesPage() {
  const qc = useQueryClient()
  const notify = useNotifications()

  // Pagination
  const [page, setPage] = useState(1)
  const pageSize = 50

  // Filters
  const [searchText, setSearchText] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [scopeFilter, setScopeFilter] = useState<string>('all')
  const [tagFilter, setTagFilter] = useState<string>('all')

  // Semantic search
  const [semanticMode, setSemanticMode] = useState(false)
  const [semanticResults, setSemanticResults] = useState<Memory[] | null>(null)
  const [isSearching, setIsSearching] = useState(false)

  // Dialog state
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null)
  const [deletingMemory, setDeletingMemory] = useState<Memory | null>(null)

  // Form state
  const [form, setForm] = useState<MemoryFormState>(EMPTY_FORM)

  useEffect(() => {
    document.title = 'Memory | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  // ── Queries ──

  const buildParams = (): Record<string, string> => {
    const params: Record<string, string> = { page: String(page), limit: String(pageSize) }
    if (searchText && !semanticMode) params.search = searchText
    if (typeFilter !== 'all') params.type = typeFilter
    if (scopeFilter !== 'all') params.scope = scopeFilter
    if (tagFilter !== 'all') params.tag = tagFilter
    return params
  }

  const { data: memoriesRaw, isLoading, refetch } = useQuery({
    queryKey: ['memories', page, searchText, typeFilter, scopeFilter, tagFilter, semanticMode],
    queryFn: () => memoriesApi.getAll(buildParams()),
    enabled: !semanticMode,
  })

  const paginatedData = memoriesRaw as PaginatedMemories | undefined
  const memories: Memory[] = semanticResults
    ? semanticResults
    : paginatedData?.data
      ? paginatedData.data
      : Array.isArray(memoriesRaw)
        ? memoriesRaw as Memory[]
        : []

  const totalCount = semanticResults
    ? semanticResults.length
    : paginatedData?.total ?? memories.length

  const totalPages = semanticResults
    ? 1
    : paginatedData?.totalPages ?? Math.ceil(totalCount / pageSize)

  const { data: tagsRaw } = useQuery({
    queryKey: ['memory-tags'],
    queryFn: () => memoriesApi.getTags(),
  })
  const tags: string[] = Array.isArray(tagsRaw) ? tagsRaw : (tagsRaw as any)?.tags || []

  const { data: agentsRaw } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.getAll(),
  })
  const agents: { id: string; name: string }[] = Array.isArray(agentsRaw)
    ? agentsRaw
    : (agentsRaw as any)?.data || (agentsRaw as any)?.agents || []

  // ── Mutations ──

  const createMut = useMutation({
    mutationFn: (data: any) => memoriesApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories'] })
      qc.invalidateQueries({ queryKey: ['memory-tags'] })
      notify.success('Created', 'Memory created successfully')
      setIsCreateOpen(false)
      setForm(EMPTY_FORM)
    },
    onError: (err: any) => notify.error('Error', err.response?.data?.message || 'Failed to create memory'),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => memoriesApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories'] })
      qc.invalidateQueries({ queryKey: ['memory-tags'] })
      notify.success('Updated', 'Memory updated successfully')
      setEditingMemory(null)
      setForm(EMPTY_FORM)
    },
    onError: (err: any) => notify.error('Error', err.response?.data?.message || 'Failed to update memory'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => memoriesApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memories'] })
      qc.invalidateQueries({ queryKey: ['memory-tags'] })
      notify.success('Deleted', 'Memory deleted successfully')
      setDeletingMemory(null)
    },
    onError: (err: any) => notify.error('Error', err.response?.data?.message || 'Failed to delete memory'),
  })

  // ── Semantic Search ──

  const handleSearch = async () => {
    if (!searchText.trim()) {
      setSemanticResults(null)
      setSemanticMode(false)
      return
    }
    if (!semanticMode) return
    setIsSearching(true)
    try {
      const opts: any = {}
      if (typeFilter !== 'all') opts.type = typeFilter
      if (scopeFilter !== 'all') opts.scope = scopeFilter
      opts.limit = pageSize
      const results = await memoriesApi.search(searchText, opts)
      const items = Array.isArray(results) ? results : (results as any)?.data || (results as any)?.memories || []
      setSemanticResults(items)
    } catch (err: any) {
      notify.error('Search Failed', err.response?.data?.message || 'Semantic search failed')
      setSemanticResults(null)
    } finally {
      setIsSearching(false)
    }
  }

  // Reset semantic results when toggling off
  useEffect(() => {
    if (!semanticMode) setSemanticResults(null)
  }, [semanticMode])

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1)
  }, [searchText, typeFilter, scopeFilter, tagFilter])

  // ── Form helpers ──

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setIsCreateOpen(true)
  }

  const openEdit = (memory: Memory) => {
    setForm({
      content: memory.content,
      type: memory.type,
      scope: memory.scope,
      agentIds: memory.agentIds || [],
      tags: (memory.tags || []).join(', '),
    })
    setEditingMemory(memory)
  }

  const handleSubmitCreate = () => {
    if (!form.content.trim()) return
    createMut.mutate({
      content: form.content,
      type: form.type,
      scope: form.scope,
      agentIds: form.scope === 'agent' ? form.agentIds : [],
      tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
    })
  }

  const handleSubmitEdit = () => {
    if (!editingMemory || !form.content.trim()) return
    updateMut.mutate({
      id: editingMemory.id,
      data: {
        content: form.content,
        type: form.type,
        scope: form.scope,
        agentIds: form.scope === 'agent' ? form.agentIds : [],
        tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
      },
    })
  }

  const toggleAgentId = (agentId: string) => {
    setForm(f => ({
      ...f,
      agentIds: f.agentIds.includes(agentId)
        ? f.agentIds.filter(id => id !== agentId)
        : [...f.agentIds, agentId],
    }))
  }

  // ── Table columns ──

  const columns = useMemo(() => [
    {
      accessorKey: 'content',
      header: 'Content',
      cell: ({ row }: any) => {
        const m = row.original as Memory
        return (
          <div className="max-w-md">
            <span className="text-sm">{truncate(m.content)}</span>
            {m.similarity != null && (
              <Badge variant="outline" className="ml-2 text-xs">
                {(m.similarity * 100).toFixed(1)}% match
              </Badge>
            )}
          </div>
        )
      },
    },
    {
      accessorKey: 'type',
      header: 'Type',
      cell: ({ row }: any) => {
        const m = row.original as Memory
        return (
          <Badge className={TYPE_COLORS[m.type] + ' border-0'}>
            {m.type}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'scope',
      header: 'Scope',
      cell: ({ row }: any) => {
        const m = row.original as Memory
        return (
          <Badge className={SCOPE_COLORS[m.scope] + ' border-0'}>
            {m.scope}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'tags',
      header: 'Tags',
      cell: ({ row }: any) => {
        const m = row.original as Memory
        if (!m.tags?.length) return <span className="text-muted-foreground text-sm">--</span>
        return (
          <div className="flex gap-1 flex-wrap">
            {m.tags.slice(0, 3).map((tag: string) => (
              <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
            ))}
            {m.tags.length > 3 && <Badge variant="outline" className="text-xs">+{m.tags.length - 3}</Badge>}
          </div>
        )
      },
    },
    {
      accessorKey: 'accessCount',
      header: 'Access Count',
      cell: ({ row }: any) => (
        <span className="text-sm text-muted-foreground">{(row.original as Memory).accessCount}</span>
      ),
    },
    {
      accessorKey: 'lastAccessedAt',
      header: 'Last Accessed',
      cell: ({ row }: any) => (
        <span className="text-sm text-muted-foreground">{formatDate((row.original as Memory).lastAccessedAt)}</span>
      ),
    },
    createActionsColumn<Memory>({
      cell: ({ row }: any) => {
        const m = row.original as Memory
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 w-8 p-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEdit(m)}>
                <Pencil className="h-4 w-4 mr-2" /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => setDeletingMemory(m)}>
                <Trash2 className="h-4 w-4 mr-2" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
    }),
  ], [])

  // ── Render ──

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
              Memory
            </h1>
            <p className="text-muted-foreground">Centralized memory store for agents and tools</p>
          </div>
          <Badge variant="secondary" className="text-sm">{totalCount}</Badge>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> Add Memory
        </Button>
      </div>

      {/* Search & Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={semanticMode ? 'Semantic search...' : 'Search memories...'}
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && semanticMode) handleSearch() }}
            className="pl-9 pr-9"
          />
          {searchText && (
            <button
              onClick={() => { setSearchText(''); setSemanticResults(null) }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button
          variant={semanticMode ? 'default' : 'outline'}
          size="sm"
          onClick={() => {
            setSemanticMode(!semanticMode)
            if (semanticMode) setSemanticResults(null)
          }}
          title="Toggle semantic search"
        >
          <Sparkles className="h-4 w-4 mr-1" />
          Semantic
        </Button>
        {semanticMode && (
          <Button size="sm" onClick={handleSearch} disabled={isSearching || !searchText.trim()}>
            {isSearching ? 'Searching...' : 'Search'}
          </Button>
        )}

        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {MEMORY_TYPES.map(t => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Scopes</SelectItem>
            {MEMORY_SCOPES.map(s => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {tags.length > 0 && (
          <Select value={tagFilter} onValueChange={setTagFilter}>
            <SelectTrigger className="w-[150px]">
              <Tag className="h-3.5 w-3.5 mr-1" />
              <SelectValue placeholder="Tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tags</SelectItem>
              {tags.map(tag => (
                <SelectItem key={tag} value={tag}>{tag}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="pt-6">
          <DataTable
            columns={columns}
            data={memories}
            loading={isLoading || isSearching}
            hideColumnsButton
            hideSelectionCount
            manualPagination={!semanticResults}
            pageCount={totalPages}
            pageIndex={page - 1}
            onPageChange={(idx) => setPage(idx + 1)}
            pageSize={pageSize}
            emptyState={
              <EmptyState
                icon={Brain}
                title={
                  searchText || typeFilter !== 'all' || scopeFilter !== 'all' || tagFilter !== 'all'
                    ? 'No memories match your filters'
                    : 'No memories yet'
                }
                description={
                  searchText || typeFilter !== 'all' || scopeFilter !== 'all' || tagFilter !== 'all'
                    ? 'Try clearing the filters or searching for a different term.'
                    : 'Memories give agents persistent knowledge — facts, preferences, instructions, conversation history. Create your first memory to start.'
                }
                action={
                  !(searchText || typeFilter !== 'all' || scopeFilter !== 'all' || tagFilter !== 'all') && (
                    <Button onClick={openCreate}>
                      <Plus className="h-4 w-4 mr-1" /> Add Memory
                    </Button>
                  )
                }
                className="py-12"
              />
            }
          />
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <MemoryFormDialog
        open={isCreateOpen}
        onOpenChange={v => { setIsCreateOpen(v); if (!v) setForm(EMPTY_FORM) }}
        title="Add Memory"
        description="Create a new memory entry for agents to recall."
        form={form}
        setForm={setForm}
        agents={agents}
        onToggleAgent={toggleAgentId}
        isPending={createMut.isPending}
        onSubmit={handleSubmitCreate}
        submitLabel="Create Memory"
        pendingLabel="Creating..."
      />

      {/* Edit Dialog */}
      <MemoryFormDialog
        open={!!editingMemory}
        onOpenChange={v => { if (!v) { setEditingMemory(null); setForm(EMPTY_FORM) } }}
        title="Edit Memory"
        description="Update this memory entry."
        form={form}
        setForm={setForm}
        agents={agents}
        onToggleAgent={toggleAgentId}
        isPending={updateMut.isPending}
        onSubmit={handleSubmitEdit}
        submitLabel="Save Changes"
        pendingLabel="Saving..."
      />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingMemory} onOpenChange={v => { if (!v) setDeletingMemory(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Memory</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this memory? This action cannot be undone.
              {deletingMemory && (
                <span className="block mt-2 text-xs font-mono bg-muted p-2 rounded max-h-20 overflow-hidden">
                  {truncate(deletingMemory.content, 200)}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deletingMemory && deleteMut.mutate(deletingMemory.id)}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── Reusable Form Dialog ──

interface MemoryFormDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description: string
  form: MemoryFormState
  setForm: React.Dispatch<React.SetStateAction<MemoryFormState>>
  agents: { id: string; name: string }[]
  onToggleAgent: (id: string) => void
  isPending: boolean
  onSubmit: () => void
  submitLabel: string
  pendingLabel: string
}

function MemoryFormDialog({
  open,
  onOpenChange,
  title,
  description,
  form,
  setForm,
  agents,
  onToggleAgent,
  isPending,
  onSubmit,
  submitLabel,
  pendingLabel,
}: MemoryFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div>
            <Label>Content</Label>
            <Textarea
              placeholder="Enter the memory content..."
              rows={4}
              value={form.content}
              onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
            />
          </div>

          <div>
            <Label>Type</Label>
            <Select value={form.type} onValueChange={(v: MemoryType) => setForm(f => ({ ...f, type: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MEMORY_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Scope</Label>
            <Select value={form.scope} onValueChange={(v: MemoryScope) => setForm(f => ({ ...f, scope: v, agentIds: v !== 'agent' ? [] : f.agentIds }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MEMORY_SCOPES.map(s => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.scope === 'agent' && (
            <div>
              <Label>Agents</Label>
              <p className="text-xs text-muted-foreground mb-2">Select which agents can access this memory.</p>
              {agents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No agents available.</p>
              ) : (
                <div className="flex gap-2 flex-wrap max-h-32 overflow-y-auto border rounded-md p-2">
                  {agents.map(agent => (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => onToggleAgent(agent.id)}
                      className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                        form.agentIds.includes(agent.id)
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-muted-foreground border-border hover:border-primary/50'
                      }`}
                    >
                      {agent.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div>
            <Label>Tags</Label>
            <Input
              placeholder="Comma-separated, e.g. api, onboarding, user-prefs"
              value={form.tags}
              onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
            />
          </div>

          <Button
            className="w-full"
            disabled={!form.content.trim() || isPending}
            onClick={onSubmit}
          >
            {isPending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
