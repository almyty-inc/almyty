/**
 * The Models card of the autonomous builder: the roles that work on a
 * request. Each role is a model (chosen with the shared ModelPicker, or
 * routed by policy) or, for a panelist or a teammate, another agent.
 *
 * One role is the main role; it runs the loop. The Main purpose cannot be
 * given to a second role while one exists: the main role is changed by
 * changing its model, which keeps the role that steps and costs are
 * recorded against the same.
 */
import { useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Cpu, Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ModelPicker } from '@/components/model-picker'
import { cn } from '@/lib/utils'
import type { AgentModelRole, AgentModels, RolePurpose } from '@/types/agent-models'
import {
  PURPOSE_DESCRIPTIONS,
  PURPOSE_LABELS,
  ROLE_PURPOSES,
  STRATEGY_LABELS,
  allowsMultiple,
  canBeAgent,
  defaultRoleName,
  isDefaultName,
  newRole,
  roleIsUsed,
} from './agent-models'

export interface ModelsSectionProps {
  models: AgentModels
  onChange: (next: AgentModels) => void
  /** This agent, left out of the agents a role can be. */
  agentId?: string
  availableAgents: Array<{ id: string; name: string }>
}

export function ModelsSection({ models, onChange, agentId, availableAgents }: ModelsSectionProps) {
  const [adding, setAdding] = useState(false)
  const otherAgents = availableAgents.filter((a) => a.id !== agentId)
  const roles = models.roles

  const setRoles = (next: AgentModelRole[]) => onChange({ ...models, roles: next })
  const patch = (i: number, next: AgentModelRole) => setRoles(roles.map((r, idx) => (idx === i ? next : r)))
  const mainCount = roles.filter((r) => r.purpose === 'main').length

  // One-of purposes already on the agent are not offered again.
  const addable = ROLE_PURPOSES.filter((p) => allowsMultiple(p) || !roles.some((r) => r.purpose === p))

  return (
    <Card data-testid="models-card">
      <CardHeader>
        <CardTitle className="text-base">Models</CardTitle>
        <CardDescription className="text-xs">
          The models this agent uses. A panelist or a teammate can also be another agent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="space-y-3">
          {roles.map((role, i) => (
            <RoleRow
              key={role.key}
              role={role}
              index={i}
              strategyLabel={STRATEGY_LABELS[models.strategy]}
              used={roleIsUsed(models.strategy, role)}
              removable={!(role.purpose === 'main' && mainCount === 1)}
              otherAgents={otherAgents}
              roles={roles}
              onChange={(next) => patch(i, next)}
              onRemove={() => setRoles(roles.filter((_, idx) => idx !== i))}
            />
          ))}
        </ol>

        {adding ? (
          <div data-testid="add-role-choices" className="rounded-md border border-dashed p-3 space-y-2">
            <p className="text-xs font-medium">Add a role</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {addable.map((purpose) => (
                <button
                  key={purpose}
                  type="button"
                  className="rounded-md border px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                  onClick={() => {
                    setRoles([...roles, newRole(roles, purpose)])
                    setAdding(false)
                  }}
                >
                  <span className="block text-sm font-medium">{PURPOSE_LABELS[purpose]}</span>
                  <span className="block text-xs text-muted-foreground">{PURPOSE_DESCRIPTIONS[purpose]}</span>
                </button>
              ))}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add role
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function RoleRow({
  role,
  index,
  strategyLabel,
  used,
  removable,
  otherAgents,
  roles,
  onChange,
  onRemove,
}: {
  role: AgentModelRole
  index: number
  strategyLabel: string
  used: boolean
  removable: boolean
  otherAgents: Array<{ id: string; name: string }>
  roles: AgentModelRole[]
  onChange: (next: AgentModelRole) => void
  onRemove: () => void
}) {
  const [advanced, setAdvanced] = useState(false)
  const id = `role-${role.key}`
  const agentAllowed = canBeAgent(role.purpose)
  const label = role.name.trim() || PURPOSE_LABELS[role.purpose]

  const changePurpose = (purpose: RolePurpose) => {
    const next: AgentModelRole = { ...role, purpose }
    // A name the page gave follows the purpose; one the person typed stays.
    if (isDefaultName(role.name, role.purpose)) {
      next.name = defaultRoleName(roles.filter((r) => r.key !== role.key), purpose)
    }
    // Only panelists and teammates can be another agent.
    if (role.kind === 'agent' && !canBeAgent(purpose)) {
      next.kind = 'model'
      delete next.agentId
    }
    onChange(next)
  }

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
    <li className="rounded-md border p-3 space-y-3" data-testid={`role-${role.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        {role.kind === 'agent' ? (
          <Bot className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
        ) : (
          <Cpu className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
        )}
        <Input
          aria-label={`Role ${index + 1} name`}
          value={role.name}
          onChange={(e) => onChange({ ...role, name: e.target.value })}
          className="h-8 w-40 min-w-0 flex-1 sm:flex-none text-sm font-medium"
        />
        {role.purpose === 'main' && (
          <Badge className="bg-violet-600 hover:bg-violet-600 text-white dark:bg-violet-500 text-[10px]">Main</Badge>
        )}
        {!used && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground" data-testid={`role-${role.key}-unused`}>
            Not used by {strategyLabel}
          </Badge>
        )}
        <div className="flex-1" />
        {removable && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={`Remove ${label}`}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5 min-w-0">
          <Label htmlFor={`${id}-purpose`} className="text-xs">Purpose</Label>
          <Select value={role.purpose} onValueChange={(v) => changePurpose(v as RolePurpose)}>
            <SelectTrigger id={`${id}-purpose`} className="h-8 text-xs" aria-label={`${label} purpose`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_PURPOSES.map((p) => (
                <SelectItem
                  key={p}
                  value={p}
                  // One main, one drafter, checker, summariser: a one-of
                  // purpose another role holds is not offered here.
                  disabled={p !== role.purpose && !allowsMultiple(p) && roles.some((r) => r.key !== role.key && r.purpose === p)}
                >
                  {PURPOSE_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground" data-testid={`${id}-purpose-hint`}>
            {PURPOSE_DESCRIPTIONS[role.purpose]}
          </p>
        </div>

        <div className="space-y-1.5 min-w-0">
          <Label className="text-xs">Filled by</Label>
          <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1" role="radiogroup" aria-label={`${label} is filled by`}>
            <button
              type="button"
              role="radio"
              aria-checked={role.kind === 'model'}
              className={cn(
                'rounded px-2 py-1 text-xs transition-colors',
                role.kind === 'model' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => changeKind('model')}
            >
              A model
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={role.kind === 'agent'}
              disabled={!agentAllowed || otherAgents.length === 0}
              className={cn(
                'rounded px-2 py-1 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                role.kind === 'agent' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => changeKind('agent')}
            >
              Another agent
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground" data-testid={`${id}-kind-hint`}>
            {!agentAllowed
              ? 'Only panelists and teammates can be another agent.'
              : otherAgents.length === 0
                ? 'No other agents yet, so a model fills it.'
                : role.kind === 'agent'
                  ? 'The agent answers with a run of its own.'
                  : 'Or one of your other agents.'}
          </p>
        </div>
      </div>

      {role.kind === 'agent' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-agent`} className="text-xs">Agent</Label>
          <Select value={role.agentId || ''} onValueChange={(agentId) => onChange({ ...role, agentId })}>
            <SelectTrigger id={`${id}-agent`} className="h-8 text-xs" aria-label={`${label} agent`}>
              <SelectValue placeholder="Select agent" />
            </SelectTrigger>
            <SelectContent>
              {otherAgents.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <ModelPicker
          idPrefix={id}
          compact
          allowRouting
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

      <div>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={advanced}
          aria-controls={`${id}-advanced`}
          onClick={() => setAdvanced((v) => !v)}
        >
          {advanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Advanced
        </button>
        {advanced && (
          <div id={`${id}-advanced`} className="mt-2 space-y-3">
            {role.kind === 'model' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-temperature`} className="text-xs">Temperature</Label>
                  <Input
                    id={`${id}-temperature`}
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    placeholder="Model default"
                    className="h-8 text-xs"
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
                    className="h-8 text-xs"
                    value={role.maxTokens ?? ''}
                    onChange={(e) => {
                      const { maxTokens: _x, ...rest } = role
                      onChange(e.target.value === '' ? rest : { ...rest, maxTokens: Number(e.target.value) })
                    }}
                  />
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-instructions`} className="text-xs">Instructions (optional)</Label>
              <Textarea
                id={`${id}-instructions`}
                rows={2}
                className="text-xs"
                placeholder={
                  role.purpose === 'checker'
                    ? 'What to check hardest, e.g. every figure has a source'
                    : role.purpose === 'teammate'
                      ? 'What this teammate is for, so the main role knows when to hand it work'
                      : 'Extra instructions for this role'
                }
                value={role.instructions || ''}
                onChange={(e) => {
                  const { instructions: _i, ...rest } = role
                  onChange(e.target.value ? { ...rest, instructions: e.target.value } : rest)
                }}
              />
            </div>
          </div>
        )}
      </div>
    </li>
  )
}
