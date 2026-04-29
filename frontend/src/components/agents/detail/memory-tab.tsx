/**
 * Memory tab for the agent detail page. Displays a table of agent
 * memories and provides an "Add Memory" dialog for creating new entries.
 */
import React, { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus,
  Tag,
  Brain,
  Loader2,
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { memoriesApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { Memory } from '@/types'

interface MemoryTabProps {
  agentId: string
  memories: Memory[]
}

export function MemoryTab({ agentId, memories }: MemoryTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [addMemoryOpen, setAddMemoryOpen] = useState(false)
  const [newMemoryContent, setNewMemoryContent] = useState('')
  const [newMemoryType, setNewMemoryType] = useState<string>('fact')
  const [newMemoryTags, setNewMemoryTags] = useState('')

  // Map the legacy `type` hint into the canonical tier:
  //   'fact'/'preference'/'instruction' → 'long' (durable)
  //   'context' → 'short' (within-session)
  //   'episode' → 'project' (work-product)
  // The agent-runtime helper does the same mapping; we duplicate it
  // here so the dialog can talk directly to the canonical API
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
        scope: { scope_type: 'workspace', scope_id: orgId! },
        content: newMemoryContent,
        tier: tierForLegacyType(newMemoryType),
        tags: newMemoryTags.split(',').map(t => t.trim()).filter(Boolean),
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
      success('Memory Added', 'Memory has been created for this agent.')
      queryClient.invalidateQueries({ queryKey: ['agent-memories', agentId] })
      setAddMemoryOpen(false)
      setNewMemoryContent('')
      setNewMemoryType('fact')
      setNewMemoryTags('')
    },
    onError: (err: any) => {
      errorNotif('Failed', err?.response?.data?.message || err?.message || 'Failed to add memory')
    },
  })

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
            <Button size="sm" onClick={() => setAddMemoryOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Memory
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {memories.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No memories yet. Add memories to give this agent persistent knowledge.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Content</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Tags</TableHead>
                    <TableHead>Access Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {memories.map((mem) => (
                    <TableRow key={mem.id}>
                      <TableCell className="text-sm max-w-[300px] truncate">
                        {mem.content}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">{mem.type}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="text-xs">{mem.scope}</Badge>
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
                        {mem.accessCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Memory Dialog */}
      <Dialog open={addMemoryOpen} onOpenChange={setAddMemoryOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Memory</DialogTitle>
            <DialogDescription>
              Create a new memory entry scoped to this agent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="memory-content">Content</Label>
              <Textarea
                id="memory-content"
                placeholder="Enter memory content..."
                value={newMemoryContent}
                onChange={(e) => setNewMemoryContent(e.target.value)}
                className="mt-1"
                rows={4}
              />
            </div>
            <div>
              <Label htmlFor="memory-type">Type</Label>
              <Select value={newMemoryType} onValueChange={setNewMemoryType}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fact">Fact</SelectItem>
                  <SelectItem value="preference">Preference</SelectItem>
                  <SelectItem value="context">Context</SelectItem>
                  <SelectItem value="episode">Episode</SelectItem>
                  <SelectItem value="instruction">Instruction</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="memory-tags">Tags (comma-separated)</Label>
              <Input
                id="memory-tags"
                placeholder="tag1, tag2, tag3"
                value={newMemoryTags}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewMemoryTags(e.target.value)}
                className="mt-1"
              />
            </div>
            <Button
              className="w-full"
              disabled={!newMemoryContent.trim() || addMemoryMutation.isPending}
              onClick={() => addMemoryMutation.mutate()}
            >
              {addMemoryMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Brain className="h-4 w-4 mr-2" />
                  Add Memory
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
