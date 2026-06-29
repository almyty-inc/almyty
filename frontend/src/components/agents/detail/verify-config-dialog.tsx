/**
 * Configure the autonomous agent's verifier panel from the UI (previously
 * JSON-only). Set enable/policy/triggers/revision-budget and the cross-vendor
 * checker list (each pointed at a provider + model). Saves to agentConfig.verify
 * via PATCH /agents/:id, preserving the rest of agentConfig.
 */
import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Loader2, Settings2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog'

import { agentsApi, llmProvidersApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import type { Agent } from '@/types'

type Policy = 'all_pass' | 'majority' | 'any_fail_blocks'
type Trigger = 'on_final_output' | 'every_n_steps' | 'on_tool_result'
interface Checker { name: string; providerId: string; model: string; instructions: string }

const TRIGGERS: { id: Trigger; label: string }[] = [
  { id: 'on_final_output', label: 'On final output (gate + revise)' },
  { id: 'every_n_steps', label: 'Every N steps (advisory)' },
  { id: 'on_tool_result', label: 'On tool result (advisory)' },
]

export function VerifyConfigDialog({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [open, setOpen] = useState(false)

  const { data: providersData } = useQuery<any>({
    queryKey: ['llm-providers'],
    queryFn: () => llmProvidersApi.getAll(),
  })
  const providers: any[] = Array.isArray(providersData)
    ? providersData
    : providersData?.providers || []

  const v = agent.agentConfig?.verify
  const [enabled, setEnabled] = useState(false)
  const [policy, setPolicy] = useState<Policy>('any_fail_blocks')
  const [maxReviseLoops, setMaxReviseLoops] = useState(2)
  const [triggers, setTriggers] = useState<Trigger[]>(['on_final_output'])
  const [everyNSteps, setEveryNSteps] = useState(5)
  const [checkers, setCheckers] = useState<Checker[]>([])

  // Re-seed the form from the agent each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setEnabled(v?.enabled ?? false)
    setPolicy((v?.policy as Policy) ?? 'any_fail_blocks')
    setMaxReviseLoops(v?.maxReviseLoops ?? 2)
    setTriggers((v?.triggers as Trigger[]) ?? ['on_final_output'])
    setEveryNSteps(v?.everyNSteps ?? 5)
    setCheckers(
      (v?.checkers ?? []).map((c) => ({
        name: c.name ?? '',
        providerId: c.providerId ?? '',
        model: c.model ?? '',
        instructions: c.instructions ?? '',
      })),
    )
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTrigger = (t: Trigger) =>
    setTriggers((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))

  const setChecker = (i: number, patch: Partial<Checker>) =>
    setCheckers((cur) => cur.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))

  const mutation = useMutation({
    mutationFn: () =>
      agentsApi.update(agent.id, {
        agentConfig: {
          ...(agent.agentConfig || {}),
          verify: {
            enabled,
            policy,
            maxReviseLoops: Number(maxReviseLoops),
            triggers,
            everyNSteps: Number(everyNSteps),
            checkers: checkers
              .filter((c) => c.providerId)
              .map((c) => ({
                name: c.name.trim() || undefined,
                providerId: c.providerId,
                model: c.model.trim() || undefined,
                instructions: c.instructions.trim() || undefined,
              })),
          },
        },
      }),
    onSuccess: () => {
      success('Verification saved')
      queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
      setOpen(false)
    },
    onError: (e: any) => errorNotif('Save failed', e?.response?.data?.message || e?.message),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Settings2 className="h-3.5 w-3.5" />
          Configure
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Verification</DialogTitle>
          <DialogDescription>
            A panel of LLM reviewers checks this agent's answers. Point each reviewer at any provider
            to build a cross-vendor panel.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="verify-enabled">Enable verification</Label>
            <Switch id="verify-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {enabled && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Merge policy</Label>
                  <Select value={policy} onValueChange={(p) => setPolicy(p as Policy)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any_fail_blocks">Any fail blocks</SelectItem>
                      <SelectItem value="majority">Majority</SelectItem>
                      <SelectItem value="all_pass">All pass</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="max-loops">Max revise loops</Label>
                  <Input
                    id="max-loops"
                    type="number"
                    min={0}
                    value={maxReviseLoops}
                    onChange={(e) => setMaxReviseLoops(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Triggers</Label>
                {TRIGGERS.map((t) => (
                  <div key={t.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`trig-${t.id}`}
                      checked={triggers.includes(t.id)}
                      onCheckedChange={() => toggleTrigger(t.id)}
                    />
                    <Label htmlFor={`trig-${t.id}`} className="text-sm font-normal">{t.label}</Label>
                    {t.id === 'every_n_steps' && triggers.includes('every_n_steps') && (
                      <Input
                        type="number"
                        min={1}
                        className="h-7 w-20 ml-2"
                        value={everyNSteps}
                        onChange={(e) => setEveryNSteps(Number(e.target.value))}
                      />
                    )}
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Reviewers</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1"
                    onClick={() =>
                      setCheckers((c) => [
                        ...c,
                        { name: '', providerId: providers[0]?.id || '', model: '', instructions: '' },
                      ])
                    }
                  >
                    <Plus className="h-3.5 w-3.5" /> Add reviewer
                  </Button>
                </div>
                {checkers.length === 0 && (
                  <p className="text-xs text-muted-foreground">No reviewers yet — add at least one.</p>
                )}
                {checkers.map((c, i) => (
                  <div key={i} className="rounded border p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Reviewer name"
                        className="h-8"
                        value={c.name}
                        onChange={(e) => setChecker(i, { name: e.target.value })}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive shrink-0"
                        onClick={() => setCheckers((cur) => cur.filter((_, idx) => idx !== i))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Select value={c.providerId} onValueChange={(p) => setChecker(i, { providerId: p })}>
                        <SelectTrigger className="h-8"><SelectValue placeholder="Provider" /></SelectTrigger>
                        <SelectContent>
                          {providers.map((p: any) => (
                            <SelectItem key={p.id} value={p.id}>{p.name || p.type}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        placeholder="Model (optional)"
                        className="h-8"
                        value={c.model}
                        onChange={(e) => setChecker(i, { model: e.target.value })}
                      />
                    </div>
                    <Input
                      placeholder="Focus instructions (optional)"
                      className="h-8"
                      value={c.instructions}
                      onChange={(e) => setChecker(i, { instructions: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="gap-1.5">
            {mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
