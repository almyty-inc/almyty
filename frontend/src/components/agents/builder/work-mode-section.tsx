/**
 * Work mode: how an autonomous agent works on each request, and which
 * models do it.
 *
 * The mode comes first, as one dropdown (Single, Cascade, Best of N,
 * Panel, Explore, extract, patch; the list is checked against the engine
 * by a source guard). The slots under it follow from the mode: Cascade
 * shows a drafter, a checker and the main model; Panel the main model,
 * its panelists and an optional judge. Each slot picks its model with
 * SlotModelChooser; a panelist can be another agent instead. Other
 * models the main model can hand work to sit under Advanced.
 *
 * Other agents it may call are picked once, in Capabilities.
 */
import { Bot, Cpu, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn, pluralized } from '@/lib/utils'
import type { AgentModelRole, AgentModels, AutonomousStrategyKey, RolePurpose } from '@/types/agent-models'
import {
  AUTONOMOUS_STRATEGY_KEYS,
  BEST_OF_N_DEFAULT,
  BEST_OF_N_MAX,
  BEST_OF_N_MIN,
  PURPOSE_DESCRIPTIONS,
  PURPOSE_LABELS,
  STRATEGY_DESCRIPTIONS,
  STRATEGY_LABELS,
  WORK_MODE_SLOTS,
  canBeAgent,
  newRole,
  withWorkMode,
  type SlotSpec,
} from './agent-models'
import { SlotModelChooser } from './slot-model-chooser'

export interface WorkModeSectionProps {
  models: AgentModels
  onChange: (next: AgentModels) => void
  /** This agent, left out of the agents a panelist can be. */
  agentId?: string
  availableAgents: Array<{ id: string; name: string }>
}

export function WorkModeSection({ models, onChange, agentId, availableAgents }: WorkModeSectionProps) {
  const otherAgents = availableAgents.filter((a) => a.id !== agentId)
  const roles = models.roles
  const setRoles = (next: AgentModelRole[]) => onChange({ ...models, roles: next })
  const patchRole = (key: string, next: AgentModelRole) => setRoles(roles.map((r) => (r.key === key ? next : r)))
  const removeRole = (key: string) => setRoles(roles.filter((r) => r.key !== key))
  const addRole = (purpose: RolePurpose) => setRoles([...roles, newRole(roles, purpose)])
  const teammates = roles.filter((r) => r.purpose === 'teammate' && r.kind === 'model')

  return (
    <Card data-testid="work-mode-card">
      <CardHeader>
        <CardTitle className="text-base">Work mode</CardTitle>
        <CardDescription className="text-xs">How the agent works on each request, and which models do the work.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-sm space-y-1.5">
          <Label htmlFor="work-mode">Work mode</Label>
          <Select value={models.strategy} onValueChange={(v) => onChange(withWorkMode(models, v as AutonomousStrategyKey))}>
            <SelectTrigger id="work-mode" data-testid="work-mode-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTONOMOUS_STRATEGY_KEYS.map((key) => (
                <SelectItem key={key} value={key} data-strategy-key={key}>
                  {STRATEGY_LABELS[key]}
                  {key === 'explore_extract_patch' ? ' (experimental)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground" data-testid="work-mode-description">
            {STRATEGY_DESCRIPTIONS[models.strategy]}
          </p>
        </div>

        <div className="space-y-3" data-testid="work-mode-slots">
          {WORK_MODE_SLOTS[models.strategy].map((slot) => (
            <SlotGroup
              key={slot.purpose}
              slot={slot}
              roles={roles.filter((r) => r.purpose === slot.purpose)}
              otherAgents={otherAgents}
              onPatch={patchRole}
              onRemove={removeRole}
              onAdd={() => addRole(slot.purpose)}
            />
          ))}
          {models.strategy === 'best_of_n' && (
            <div className="space-y-1.5">
              <Label htmlFor="best-of-n-candidates">Answers to choose from</Label>
              <Input
                id="best-of-n-candidates"
                type="number"
                min={BEST_OF_N_MIN}
                max={BEST_OF_N_MAX}
                className="w-24"
                value={models.candidates ?? BEST_OF_N_DEFAULT}
                onChange={(e) => onChange({ ...models, candidates: Number(e.target.value) })}
              />
              <p className="text-xs text-muted-foreground">
                The main model writes this many answers, {BEST_OF_N_MIN} to {BEST_OF_N_MAX}, and the checker picks one.
              </p>
            </div>
          )}
        </div>

        <Disclosure
          title="Advanced"
          summary={teammates.length ? `${pluralized(teammates.length, 'other model')} it can hand work to` : 'Other models it can hand work to'}
          testId="work-mode-advanced"
          defaultOpen={teammates.length > 0}
          bodyClassName="space-y-3"
        >
          <div className="space-y-1">
            <p className="text-sm font-medium">Other models it can hand work to</p>
            <p className="text-xs text-muted-foreground">
              The main model can pass a piece of work to one of these and use the answer, in any work mode. Other agents it may call are chosen under Capabilities.
            </p>
          </div>
          {teammates.map((role) => (
            <SlotRow
              key={role.key}
              role={role}
              removable
              otherAgents={otherAgents}
              onChange={(next) => patchRole(role.key, next)}
              onRemove={() => removeRole(role.key)}
            />
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => addRole('teammate')}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add a model
          </Button>
        </Disclosure>
      </CardContent>
    </Card>
  )
}

/** "a judge", "an explorer". */
function withArticle(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`
}

/** One slot of the mode: its role (or roles, for panelists and explorers), and how to add one. */
function SlotGroup({
  slot,
  roles,
  otherAgents,
  onPatch,
  onRemove,
  onAdd,
}: {
  slot: SlotSpec
  roles: AgentModelRole[]
  otherAgents: Array<{ id: string; name: string }>
  onPatch: (key: string, next: AgentModelRole) => void
  onRemove: (key: string) => void
  onAdd: () => void
}) {
  const label = PURPOSE_LABELS[slot.purpose]
  if (slot.optional && roles.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-3 space-y-2" data-testid={`slot-${slot.purpose}-empty`}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">Optional</span>
        </div>
        <p className="text-xs text-muted-foreground">{PURPOSE_DESCRIPTIONS[slot.purpose]}</p>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Add {withArticle(label.toLowerCase())}
        </Button>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {roles.map((role) => (
        <SlotRow
          key={role.key}
          role={role}
          optional={slot.optional}
          removable={slot.optional || (slot.many && roles.length > slot.min)}
          otherAgents={otherAgents}
          onChange={(next) => onPatch(role.key, next)}
          onRemove={() => onRemove(role.key)}
        />
      ))}
      {slot.many && (
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Add {withArticle(label.toLowerCase())}
        </Button>
      )}
    </div>
  )
}

function SlotRow({
  role,
  optional = false,
  removable,
  otherAgents,
  onChange,
  onRemove,
}: {
  role: AgentModelRole
  optional?: boolean
  removable: boolean
  otherAgents: Array<{ id: string; name: string }>
  onChange: (next: AgentModelRole) => void
  onRemove: () => void
}) {
  const id = `role-${role.key}`
  const label = role.name.trim() || PURPOSE_LABELS[role.purpose]
  const agentAllowed = canBeAgent(role.purpose) && role.purpose !== 'teammate'

  const changeKind = (kind: 'model' | 'agent') => {
    if (kind === role.kind) return
    if (kind === 'agent') {
      const { providerId: _p, model: _m, routing: _r, temperature: _t, maxTokens: _x, ...rest } = role
      onChange({ ...rest, kind: 'agent', agentId: '' })
    } else {
      const { agentId: _a, ...rest } = role
      onChange({ ...rest, kind: 'model' })
    }
  }

  return (
    <div className="rounded-md border p-3 space-y-3" data-testid={`slot-${role.key}`} data-purpose={role.purpose}>
      <div className="flex items-center gap-2">
        {role.kind === 'agent' ? (
          <Bot className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
        ) : (
          <Cpu className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
        )}
        <span className="text-sm font-medium">{label}</span>
        {optional && <span className="text-xs text-muted-foreground">Optional</span>}
        <div className="flex-1" />
        {removable && (
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Remove ${label}`} onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground" data-testid={`${id}-hint`}>{PURPOSE_DESCRIPTIONS[role.purpose]}</p>

      {agentAllowed && otherAgents.length > 0 && (
        <div className="grid max-w-xs grid-cols-2 gap-1 rounded-md bg-muted p-1" role="radiogroup" aria-label={`${label} is`}>
          {(['model', 'agent'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={role.kind === kind}
              className={cn(
                'rounded px-2 py-1 text-xs transition-colors',
                role.kind === kind ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => changeKind(kind)}
            >
              {kind === 'model' ? 'A model' : 'Another agent'}
            </button>
          ))}
        </div>
      )}

      {role.kind === 'agent' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-agent`} className="text-xs">Agent</Label>
          <Select value={role.agentId || ''} onValueChange={(agentId) => onChange({ ...role, agentId })}>
            <SelectTrigger id={`${id}-agent`} aria-label={`${label} agent`}>
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent>
              {otherAgents.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <SlotModelChooser
          idPrefix={id}
          value={{ providerId: role.providerId, model: role.model, routing: role.routing }}
          onChange={(next) => {
            const { providerId: _p, model: _m, routing: _r, ...rest } = role
            onChange({
              ...rest,
              ...(next.providerId ? { providerId: next.providerId } : {}),
              ...(next.model ? { model: next.model } : {}),
              ...(next.routing ? { routing: next.routing } : {}),
            })
          }}
        />
      )}

      <Disclosure title="Advanced" summary="Name, sampling, extra instructions" testId={`${id}-advanced`} bodyClassName="space-y-3" className="text-sm">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`} className="text-xs">Name</Label>
            <Input id={`${id}-name`} value={role.name} onChange={(e) => onChange({ ...role, name: e.target.value })} />
          </div>
          {role.kind === 'model' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-temperature`} className="text-xs">Temperature</Label>
                <Input
                  id={`${id}-temperature`}
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  placeholder="Model default"
                  value={role.temperature ?? ''}
                  onChange={(e) => {
                    const { temperature: _t, ...rest } = role
                    onChange(e.target.value === '' ? rest : { ...rest, temperature: parseFloat(e.target.value) })
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-max-tokens`} className="text-xs">Max tokens</Label>
                <Input
                  id={`${id}-max-tokens`}
                  type="number"
                  min={1}
                  placeholder="Model default"
                  value={role.maxTokens ?? ''}
                  onChange={(e) => {
                    const { maxTokens: _x, ...rest } = role
                    onChange(e.target.value === '' ? rest : { ...rest, maxTokens: Number(e.target.value) })
                  }}
                />
              </div>
            </>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-instructions`} className="text-xs">Extra instructions</Label>
          <Textarea
            id={`${id}-instructions`}
            rows={2}
            placeholder={
              role.purpose === 'checker'
                ? 'What to check hardest, for example: every figure has a source'
                : role.purpose === 'teammate'
                  ? 'What this model is for, so the main model knows when to hand it work'
                  : 'Anything this role should do differently'
            }
            value={role.instructions || ''}
            onChange={(e) => {
              const { instructions: _i, ...rest } = role
              onChange(e.target.value ? { ...rest, instructions: e.target.value } : rest)
            }}
          />
        </div>
      </Disclosure>
    </div>
  )
}
