import React, { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNotifications } from '@/store/app'
import { agentAppsApi, type AgentApp } from '@/lib/agent-apps'

export interface AppAgentsPanelProps {
  app: AgentApp
  agents: Array<{ id: string; name: string }>
  onSaved: () => void
}

/**
 * Which agents make up this app, and in what order.
 *
 * Order is meaningful rather than decorative: the first agent is where
 * a new conversation starts, so promoting one is how an operator
 * changes what a user meets first without rebuilding anything.
 */
export function AppAgentsPanel({ app, agents, onSaved }: AppAgentsPanelProps) {
  const { success, error: errorNotif } = useNotifications()
  const [selected, setSelected] = useState<string[]>(app.agentIds)

  const available = agents.filter((a) => !selected.includes(a.id))
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id

  const move = (index: number, delta: number) => {
    const next = [...selected]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setSelected(next)
  }

  const save = useMutation({
    mutationFn: () => agentAppsApi.update(app.slug, { agentIds: selected }),
    onSuccess: () => {
      success('Agents updated', 'This app now uses those agents.')
      onSaved()
    },
    onError: (err: any) =>
      errorNotif('Could not save', err?.response?.data?.message || 'Something went wrong.'),
  })

  return (
    <div className="mt-6 space-y-4">
      {selected.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No agents yet. An app with none has nothing for a user to talk to, so it cannot be published.
        </p>
      ) : (
        <ol className="space-y-2">
          {selected.map((id, index) => (
            <li
              key={id}
              className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm"
            >
              <span className="w-5 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{nameOf(id)}</span>
              {index === 0 && (
                <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                  Default
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={`Move ${nameOf(id)} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={`Move ${nameOf(id)} down`}
                disabled={index === selected.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={`Remove ${nameOf(id)}`}
                onClick={() => setSelected(selected.filter((x) => x !== id))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ol>
      )}

      {available.length > 0 && (
        <Select value="" onValueChange={(id) => setSelected([...selected, id])}>
          <SelectTrigger aria-label="Add an agent">
            <SelectValue placeholder="Add an agent" />
          </SelectTrigger>
          <SelectContent>
            {available.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="flex justify-end">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
