/**
 * The one list of memories: the Memory page and an agent's Memory tab show
 * the same table with the same columns. Each row is one line of the
 * memory's text; opening it shows the whole memory rendered as markdown
 * (safely: raw HTML is skipped, images become links), with any embedded
 * `{"message": ...}` shown as the message (memoryText).
 */
import React, { useState } from 'react'
import { ChevronDown, ChevronUp, Tag, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AssistantMarkdown } from '@/components/hosted-chat/assistant-markdown'
import type { MemoryTier } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'
import { MEMORY_TIER_LABELS, memoryTypeLabel } from './memory-words'
import { memoryPreview, memoryText } from './memory-text'

/** A memory as the canonical memory API lists it. */
export interface MemoryTableItem {
  id: string
  content: string
  mode?: string | null
  tier?: MemoryTier | null
  tags?: string[] | null
  /** `type` is what kind of memory it is (fact, preference, ...), when it was saved with one. */
  metadata?: Record<string, unknown> | null
  embedding_status?: 'pending' | 'ready' | 'failed' | 'skipped' | string | null
  access_count?: number | null
  created_at?: string | null
}

const COLUMNS = 8
/**
 * The columns a phone leaves out, so the memory's text keeps the row; the
 * open row says them. On one line each, so the text column gives way first.
 */
const WIDE = 'hidden md:table-cell whitespace-nowrap'

export function MemoryTable({
  items,
  onDelete,
}: {
  items: MemoryTableItem[]
  /** Asks "Delete memory?" and deletes; the row's delete button calls it. */
  onDelete: (item: MemoryTableItem) => void
}) {
  // The row whose whole content is open; the list cuts each to one line.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  return (
    <div className="overflow-x-auto">
      <Table data-testid="memory-table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Content</TableHead>
            <TableHead className={WIDE}>Type</TableHead>
            <TableHead className={WIDE}>Kept</TableHead>
            <TableHead className={WIDE}>Tags</TableHead>
            <TableHead className={WIDE}>Used</TableHead>
            <TableHead className={WIDE}>Saved</TableHead>
            <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((mem) => {
            const open = expandedId === mem.id
            const toggle = () => setExpandedId(open ? null : mem.id)
            const type = mem.mode === 'document' ? 'Document' : memoryTypeLabel(mem.metadata)
            const unsearchable = mem.embedding_status === 'pending' || mem.embedding_status === 'failed'
            return (
              <React.Fragment key={mem.id}>
                <TableRow
                  className="cursor-pointer hover:bg-muted/50"
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('[data-row-action]')) return
                    toggle()
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
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
                  <TableCell className="text-sm w-full max-w-0 truncate" data-testid="memory-preview">
                    {memoryPreview(mem.content)}
                  </TableCell>
                  <TableCell className={WIDE}>
                    <div className="flex gap-1">
                      {type ? <Badge variant="outline" className="text-xs">{type}</Badge> : '--'}
                      {/* Only the case a person can act on: it will not come up in search. */}
                      {unsearchable && (
                        <Badge variant="outline" className="text-xs">{mem.embedding_status === 'pending' ? 'Not in search yet' : 'Not searchable'}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className={WIDE}>
                    {mem.tier ? (
                      <Badge variant="secondary" className="text-xs">{MEMORY_TIER_LABELS[mem.tier] ?? mem.tier}</Badge>
                    ) : '--'}
                  </TableCell>
                  <TableCell className={`${WIDE} text-xs text-muted-foreground`}>
                    {mem.tags && mem.tags.length > 0 ? (
                      <div className="flex gap-1">
                        {mem.tags.slice(0, 6).map((tag, idx) => (
                          <span key={idx} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted text-[10px]">
                            <Tag className="h-2.5 w-2.5" />{tag}
                          </span>
                        ))}
                      </div>
                    ) : '--'}
                  </TableCell>
                  <TableCell className={`${WIDE} text-sm text-muted-foreground`}>
                    {mem.access_count ?? 0}
                  </TableCell>
                  <TableCell className={`${WIDE} text-xs text-muted-foreground whitespace-nowrap`}>
                    {mem.created_at ? formatDateTime(mem.created_at) : '--'}
                  </TableCell>
                  <TableCell className="px-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      data-row-action
                      onClick={() => onDelete(mem)}
                      title="Delete memory"
                      aria-label="Delete memory"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
                {open && (
                  <TableRow>
                    <TableCell colSpan={COLUMNS} className="bg-muted/30 p-4">
                      {/* w-0 min-w-full: the text fills the row without widening the table. */}
                      <div className="w-0 min-w-full space-y-2" data-testid="memory-full-content">
                        <div className="text-sm break-words">
                          <AssistantMarkdown>{memoryText(mem.content)}</AssistantMarkdown>
                        </div>
                        {/* On a phone the row leaves out these columns; the open memory says them. */}
                        <p className="text-xs text-muted-foreground md:hidden">
                          {[type, mem.tier ? MEMORY_TIER_LABELS[mem.tier] ?? mem.tier : null, ...(mem.tags ?? [])].filter(Boolean).join(' · ')}
                        </p>
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
  )
}

/** The "Delete memory?" question, quoting enough of the memory to know which one. */
export function deleteMemoryQuestion(content: string) {
  const text = memoryPreview(content)
  return {
    title: 'Delete memory?',
    description: `No agent will find this memory again. It starts "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}".`,
    confirmLabel: 'Delete memory',
    destructive: true,
  }
}
