/**
 * Memory tab for the agent detail page. Displays a table of agent
 * memories; "Add memory" opens an inline form at the top of the card.
 */
import React, { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus,
  Tag,
  Brain,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { memoriesApi, type MemoryScopeType, type MemoryTier } from '@/lib/api'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { getApiErrorMessage } from '@/lib/api-error'
import { formatDateTime } from '@/lib/utils'
import { MEMORY_TIER_LABELS, MEMORY_TYPE_LABELS, memoryTypeLabel } from '@/components/memory/memory-words'

/** A memory item as the canonical memory API lists it (POST /memory/canonical/list). */
export interface AgentMemoryItem {
  id: string
  content: string
  tier?: MemoryTier | null
  tags?: string[]
  /** `type` is what kind of memory it is (fact, preference, ...), when it was saved with one. */
  metadata?: Record<string, unknown> | null
  access_count?: number
  created_at?: string
}

interface MemoryTabProps {
  agentId: string
  /** The memory the agent's runs use (agentMemoryScope); the organization's shared memory when absent. */
  scope?: { scope_type: MemoryScopeType; scope_id: string }
  memories: AgentMemoryItem[]
  /**
   * The memories query lives on the agent detail page, so the failure has to
   * be handed down: without it a fetch that failed rendered the same "no
   * memories yet" line as an agent that genuinely has none.
   */
  error?: unknown
  onRetry?: () => void
}

export function MemoryTab({ agentId, scope, memories, error, onRetry }: MemoryTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [addMemoryOpen, setAddMemoryOpen] = useState(false)
  const [contentError, setContentError] = useState<string | null>(null)
  const [newMemoryContent, setNewMemoryContent] = useState('')
  const [newMemoryType, setNewMemoryType] = useState<string>('fact')
  const [newMemoryTags, setNewMemoryTags] = useState('')
  // The row whose whole content is open; the list cuts each to one line.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // A half-written memory asks before a navigation throws it away. Cancel
  // and a successful add both reset the fields, so neither asks.
  const guard = useLeaveGuard(
    addMemoryOpen && (newMemoryContent !== '' || newMemoryTags !== '' || newMemoryType !== 'fact'),
  )

  // Map the legacy `type` hint into the canonical tier:
  //   'fact'/'preference'/'instruction' → 'long' (durable)
  //   'context' → 'short' (within-session)
  //   'episode' → 'project' (work-product)
  // The agent-runtime helper does the same mapping; we duplicate it
  // here so the form can talk directly to the canonical API
  // without an intermediary service.
  const tierForLegacyType = (t: string) =>
    t === 'context' ? 'short'
    : (t === 'fact' || t === 'preference' || t === 'instruction') ? 'long'
    : 'project'
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)

  const addMemoryMutation = useMutation({
    mutationFn: async () => {
      return memoriesApi.put({
        mode: 'memory',
        scope: scope ?? { scope_type: 'workspace', scope_id: orgId! },
        content: newMemoryContent,
        tier: tierForLegacyType(newMemoryType),
        tags: newMemoryTags.split(',').map(t => t.trim()).filter(Boolean),
        // The tier keeps how long; the type keeps what it is, shown in the list.
        metadata: { type: newMemoryType },
        provenance: {
          agent_id: agentId,
          session_id: null, collab_id: null,
          model: null, provider: null,
          tool_chain: ['ui_agent_memory_tab'],
          created_by: 'user',
          source_backend: 'almyty-native',
        },
      })
    },
    onSuccess: () => {
      success('Memory added', 'Memory has been created for this agent.')
      queryClient.invalidateQueries({ queryKey: ['agent-memories', agentId] })
      // The Memory page lists the same rows under its own key, and a
      // memory added here is the org's memory too.
      queryClient.invalidateQueries({ queryKey: ['memories', 'list'] })
      closeForm()
    },
    onError: (err: any) => {
      errorNotif('Failed', getApiErrorMessage(err, 'Failed to add memory'))
    },
  })

  function closeForm() {
    setAddMemoryOpen(false)
    setNewMemoryContent('')
    setNewMemoryType('fact')
    setNewMemoryTags('')
    setContentError(null)
  }

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!newMemoryContent.trim()) {
      setContentError('Write what the agent should remember.')
      return
    }
    setContentError(null)
    addMemoryMutation.mutate()
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Memories</CardTitle>
              <CardDescription className="text-xs mt-1">
                Knowledge and context accessible to this agent
              </CardDescription>
            </div>
            {!addMemoryOpen && (
              <Button size="sm" onClick={() => setAddMemoryOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add memory
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {addMemoryOpen && (
            <form
              onSubmit={submit}
              noValidate
              aria-label="Add memory"
              data-testid="add-memory-form"
              className="space-y-4 rounded-md border bg-muted/20 p-4"
            >
              <div>
                <h4 className="text-sm font-semibold">Add memory</h4>
                <p className="text-xs text-muted-foreground">A memory entry this agent can recall on later runs.</p>
              </div>
              <Field id="memory-content" label="Content" required error={contentError}>
                <Textarea
                  placeholder="Enter memory content..."
                  value={newMemoryContent}
                  onChange={(e) => {
                    setNewMemoryContent(e.target.value)
                    if (contentError) setContentError(null)
                  }}
                  rows={4}
                  autoFocus
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="memory-type">Type</Label>
                  <Select value={newMemoryType} onValueChange={setNewMemoryType}>
                    <SelectTrigger id="memory-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(MEMORY_TYPE_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Field id="memory-tags" label="Tags" hint="Comma-separated.">
                  <Input
                    placeholder="tag1, tag2, tag3"
                    value={newMemoryTags}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewMemoryTags(e.target.value)}
                  />
                </Field>
              </div>
              <InlineFormActions
                onCancel={closeForm}
                submitLabel="Add memory"
                submitting={addMemoryMutation.isPending}
              />
            </form>
          )}
          {error ? (
            <QueryError error={error} onRetry={onRetry} title="Couldn't load memories" />
          ) : memories.length === 0 ? (
            addMemoryOpen ? null : (
            <EmptyState
              icon={Brain}
              title="No memories yet"
              description="Memories are the knowledge this agent carries between runs — facts, preferences and instructions it should not have to be told twice."
              action={
                <Button onClick={() => setAddMemoryOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add memory
                </Button>
              }
            />
            )
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Content</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Kept</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Access count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {memories.map((mem) => {
                    const open = expandedId === mem.id
                    const toggle = () => setExpandedId(open ? null : mem.id)
                    return (
                      <React.Fragment key={mem.id}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/50"
                          role="button"
                          tabIndex={0}
                          aria-expanded={open}
                          onClick={toggle}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              toggle()
                            }
                          }}
                        >
                          <TableCell className="px-2">
                            {open
                              ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                              : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                          </TableCell>
                          <TableCell className="text-sm max-w-[300px] truncate">
                            {mem.content}
                          </TableCell>
                          <TableCell>
                            {memoryTypeLabel(mem.metadata) ? (
                              <Badge variant="outline" className="text-xs">{memoryTypeLabel(mem.metadata)}</Badge>
                            ) : '--'}
                          </TableCell>
                          <TableCell>
                            {mem.tier ? (
                              <Badge variant="secondary" className="text-xs">{MEMORY_TIER_LABELS[mem.tier] ?? mem.tier}</Badge>
                            ) : '--'}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {mem.tags && mem.tags.length > 0 ? (
                              <div className="flex gap-1 flex-wrap">
                                {mem.tags.map((tag, idx) => (
                                  <span key={idx} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted text-[10px]">
                                    <Tag className="h-2.5 w-2.5" />{tag}
                                  </span>
                                ))}
                              </div>
                            ) : '--'}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {mem.access_count ?? 0}
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow>
                            <TableCell colSpan={6} className="bg-muted/30 p-4">
                              {/* w-0 min-w-full: the text fills the row without widening the table. */}
                              <div className="w-0 min-w-full space-y-2" data-testid="memory-full-content">
                                <p className="text-sm whitespace-pre-wrap break-words">{mem.content}</p>
                                {mem.created_at && (
                                  <p className="text-xs text-muted-foreground">Saved {formatDateTime(mem.created_at)}</p>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      {guard.element}
    </>
  )
}
