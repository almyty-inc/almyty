/**
 * Promoted Skills tab for the agent detail page. Lists skills distilled from
 * this agent's successful runs, with a SKILL.md viewer and delete.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Sparkles, Eye, Trash2, Play, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'

import { promotedSkillsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { formatDateTime } from '@/lib/utils'
import type { PromotedSkill } from '@/types'

interface PromotedSkillsTabProps {
  agentId: string
}

export function PromotedSkillsTab({ agentId }: PromotedSkillsTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [viewing, setViewing] = useState<PromotedSkill | null>(null)

  const { data, isLoading } = useQuery<PromotedSkill[]>({
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
    onError: (e: any) => errorNotif('Delete failed', e?.response?.data?.message || e?.message),
  })

  const replayMutation = useMutation({
    mutationFn: (id: string) => promotedSkillsApi.replay(id),
    onSuccess: (res: any) =>
      success('Replay started', res?.runId ? `Run ${res.runId} is running` : undefined),
    onError: (e: any) => errorNotif('Replay failed', e?.response?.data?.message || e?.message),
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Promoted Skills
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
        ) : skills.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No promoted skills yet. Promote a completed run from the Runs tab.
          </p>
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
                {skills.map((skill) => (
                  <TableRow key={skill.id}>
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
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" className="gap-1" onClick={() => setViewing(skill)}>
                        <Eye className="h-3.5 w-3.5" />
                        View
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
                        disabled={removeMutation.isPending}
                        onClick={() => removeMutation.mutate(skill.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewing?.name}</DialogTitle>
            <DialogDescription>SKILL.md (Agent Skills format)</DialogDescription>
          </DialogHeader>
          <pre className="bg-muted rounded p-3 text-xs whitespace-pre-wrap max-h-[60vh] overflow-auto">
            {viewing?.content}
          </pre>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
