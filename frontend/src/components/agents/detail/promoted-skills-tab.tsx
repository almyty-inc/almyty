/**
 * Promoted Skills tab for the agent detail page. Lists skills distilled from
 * this agent's successful runs; View opens a skill's SKILL.md inline under
 * its row (it was a dialog), and Delete confirms first.
 */
import { Fragment, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Sparkles, Eye, Trash2, Play, Loader2, ChevronUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

import { promotedSkillsApi } from '@/lib/api'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { useNotifications } from '@/store/app'
import { formatDateTime } from '@/lib/utils'
import type { PromotedSkill } from '@/types'
import { getApiErrorMessage } from '@/lib/api-error'
import { useConfirm } from '@/components/ui/confirm-dialog'

interface PromotedSkillsTabProps {
  agentId: string
}

export function PromotedSkillsTab({ agentId }: PromotedSkillsTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [viewingId, setViewingId] = useState<string | null>(null)

  const { data, isLoading, isError, error, refetch } = useQuery<PromotedSkill[]>({
    queryKey: ['promoted-skills'],
    queryFn: () => promotedSkillsApi.list(),
  })

  const skills = (data || []).filter((s) => s.agentId === agentId)

  const removeMutation = useMutation({
    mutationFn: (id: string) => promotedSkillsApi.remove(id),
    onSuccess: () => {
      success('Skill deleted')
      queryClient.invalidateQueries({ queryKey: ['promoted-skills'] })
    },
    onError: (e: any) => errorNotif('Delete failed', getApiErrorMessage(e)),
  })

  const replayMutation = useMutation({
    mutationFn: (id: string) => promotedSkillsApi.replay(id),
    onSuccess: (res: any) =>
      success('Replay started', res?.runId ? `Run ${res.runId} is running` : undefined),
    onError: (e: any) => errorNotif('Replay failed', getApiErrorMessage(e)),
  })

  const { confirm, dialog: confirmDialog } = useConfirm()
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Promoted skills
          </CardTitle>
          <Badge variant="outline">{skills.length}</Badge>
        </div>
        <CardDescription className="text-xs">
          Reusable skills distilled from this agent's successful runs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          // Without this a failed fetch looked exactly like a brand-new agent
          // with nothing promoted yet -- the user was told to go promote a run
          // they had already promoted.
          <QueryError error={error} onRetry={() => refetch()} title="Couldn't load promoted skills" />
        ) : skills.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="No promoted skills yet"
            description="Promote a completed run from the Runs tab and it becomes a reusable skill other agents can call."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skills.map((skill) => {
                  const open = viewingId === skill.id
                  const panelId = `promoted-skill-${skill.id}-content`
                  return (
                    <Fragment key={skill.id}>
                      <TableRow>
                        <TableCell className="font-medium">{skill.name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[280px] truncate">
                          {skill.description || '--'}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">v{skill.version}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDateTime(skill.createdAt)}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1"
                            aria-expanded={open}
                            aria-controls={open ? panelId : undefined}
                            aria-label={`${open ? 'Hide' : 'View'} SKILL.md for ${skill.name}`}
                            onClick={() => setViewingId(open ? null : skill.id)}
                          >
                            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            {open ? 'Hide' : 'View'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1"
                            disabled={replayMutation.isPending}
                            onClick={() => replayMutation.mutate(skill.id)}
                          >
                            <Play className="h-3.5 w-3.5" />
                            Replay
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1 text-destructive"
                            aria-label={`Delete promoted skill ${skill.name}`}
                            disabled={removeMutation.isPending}
                            onClick={async () => {
                              const ok = await confirm({
                                title: 'Delete this promoted skill?',
                                description: `"${skill.name}" will no longer be offered to this agent. This cannot be undone.`,
                                confirmLabel: 'Delete skill',
                                destructive: true,
                              })
                              if (ok) removeMutation.mutate(skill.id)
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                      {open && (
                        // The SKILL.md opens in place under its row, so the
                        // list, Replay and Delete stay where they were.
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={5} className="bg-muted/30 p-4">
                            <section id={panelId} aria-label={`SKILL.md for ${skill.name}`} className="space-y-2">
                              <p className="text-xs text-muted-foreground">SKILL.md (Agent Skills format)</p>
                              <pre className="bg-background border rounded p-3 text-xs whitespace-pre-wrap break-words max-h-[60vh] overflow-auto">
                                {skill.content}
                              </pre>
                            </section>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      {confirmDialog}
    </Card>
  )
}
