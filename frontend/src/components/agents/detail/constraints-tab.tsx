/**
 * Constraints tab for the agent detail page — the agent's failure memory.
 * Lists learned/manual constraints, toggles active state, and adds new ones.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert, Plus, Trash2, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

import { agentConstraintsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import type { AgentConstraint } from '@/types'

interface ConstraintsTabProps {
  agentId: string
}

export function ConstraintsTab({ agentId }: ConstraintsTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [rule, setRule] = useState('')

  const { data, isLoading } = useQuery<AgentConstraint[]>({
    queryKey: ['agent-constraints', agentId],
    queryFn: () => agentConstraintsApi.list(agentId),
  })
  const constraints = data || []
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['agent-constraints', agentId] })

  const addMutation = useMutation({
    mutationFn: () => agentConstraintsApi.add(agentId, rule.trim()),
    onSuccess: () => {
      success('Constraint added')
      setRule('')
      invalidate()
    },
    onError: (e: any) => errorNotif('Add failed', e?.response?.data?.message || e?.message),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      agentConstraintsApi.setActive(agentId, id, active),
    onSuccess: invalidate,
    onError: (e: any) => errorNotif('Update failed', e?.response?.data?.message || e?.message),
  })

  const removeMutation = useMutation({
    mutationFn: (id: string) => agentConstraintsApi.remove(agentId, id),
    onSuccess: () => {
      success('Constraint removed')
      invalidate()
    },
    onError: (e: any) => errorNotif('Remove failed', e?.response?.data?.message || e?.message),
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" />
            Constraints
          </CardTitle>
          <Badge variant="outline">{constraints.length}</Badge>
        </div>
        <CardDescription className="text-xs">
          Hard rules injected into the agent's prompt — learned from past failures or added by hand.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (rule.trim()) addMutation.mutate()
          }}
        >
          <Input
            value={rule}
            maxLength={1000}
            placeholder="Add a constraint, e.g. Never call the export API more than once per run"
            onChange={(e) => setRule(e.target.value)}
          />
          <Button type="submit" size="sm" className="gap-1 shrink-0" disabled={addMutation.isPending || !rule.trim()}>
            {addMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </Button>
        </form>

        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : constraints.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No constraints yet. Add one above, or enable auto-learn so failures become constraints.
          </p>
        ) : (
          <div className="space-y-2">
            {constraints.map((c) => (
              <div
                key={c.id}
                className={`flex items-start gap-3 p-2 rounded border text-sm ${
                  c.active ? 'bg-background' : 'bg-muted/40 opacity-60'
                }`}
              >
                <Switch
                  checked={c.active}
                  onCheckedChange={(active) => toggleMutation.mutate({ id: c.id, active })}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="break-words">{c.rule}</div>
                  <Badge variant="outline" className="text-[10px] mt-1">{c.origin}</Badge>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive shrink-0"
                  disabled={removeMutation.isPending}
                  onClick={() => removeMutation.mutate(c.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
