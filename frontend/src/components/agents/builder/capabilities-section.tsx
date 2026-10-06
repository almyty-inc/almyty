/**
 * Capabilities: what an autonomous agent may use and reach. Each part is
 * enforced by the server (agent-capabilities.ts, the step processor, the
 * built-in tools); nothing here is only shown.
 *
 *  - Tools and APIs: single tools, or a whole API, which means every tool
 *    of it, including tools added to it later.
 *  - How the model sees its tools: every tool, or search for them (the
 *    server's agent-tool-mode.ts), the switch-over threshold and the tools
 *    always shown in full.
 *  - Other agents: the ones it may call or hand work to, picked by name.
 *  - Machine: the labels of the machine its runner tools run on, and the
 *    machines that have them.
 *  - Temporary agents: whether it may create them, and how many per run
 *    and at once.
 *  - Acts as: its owner, or itself with its own access (Business).
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Bot, ChevronDown, ChevronRight, Search, Wrench, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RunnerLabelsField, parseRunnerLabels } from '@/components/agents/builder/runner-labels-field'
import { apisApi, runnersApi } from '@/lib/api'
import { pluralized } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { useEntitlement } from '@/hooks/use-entitlement'
import type { Agent, CodeWriteAction } from '@/types'

type AgentConfig = NonNullable<Agent['agentConfig']> & { runnerLabels?: Record<string, string> | string }

export const TEMPORARY_AGENTS_PER_RUN_DEFAULT = 3
export const TEMPORARY_AGENTS_ALIVE_DEFAULT = 5
export const TEMPORARY_AGENTS_MAX = 20

export interface CapabilitiesSectionProps {
  agentId?: string
  toolIds: string[]
  onToolIdsChange: (ids: string[]) => void
  tools: any[]
  agentConfig: AgentConfig
  onAgentConfigChange: (next: AgentConfig) => void
  availableAgents: Array<{ id: string; name: string; description?: string; isTemporary?: boolean }>
}

export function CapabilitiesSection({
  agentId,
  toolIds,
  onToolIdsChange,
  tools,
  agentConfig,
  onAgentConfigChange,
  availableAgents,
}: CapabilitiesSectionProps) {
  const set = (patch: Partial<AgentConfig>) => onAgentConfigChange({ ...agentConfig, ...patch })
  return (
    <Card data-testid="capabilities-card">
      <CardHeader>
        <CardTitle className="text-base">Capabilities</CardTitle>
        <CardDescription className="text-xs">What the agent may use and reach while it works. Anything not allowed here is refused.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ToolsAndApis
          tools={tools}
          toolIds={toolIds}
          onToolIdsChange={onToolIdsChange}
          apiIds={agentConfig.apiIds ?? []}
          onApiIdsChange={(apiIds) => set({ apiIds })}
        />
        <ToolModeSection
          agentConfig={agentConfig}
          usableTools={tools.filter((t) => toolIds.includes(t.id) || (t.apiId && (agentConfig.apiIds ?? []).includes(t.apiId)))}
          onChange={set}
        />
        <OtherAgents
          agentId={agentId}
          agents={availableAgents}
          value={agentConfig.callableAgentIds ?? []}
          everyAgent={!!agentConfig.canCallAgents && !Array.isArray(agentConfig.callableAgentIds)}
          onChange={(callableAgentIds) => set({ callableAgentIds, canCallAgents: callableAgentIds.length > 0 })}
        />
        <Machine value={agentConfig.runnerLabels} onChange={(runnerLabels) => set({ runnerLabels })} />
        <TemporaryAgents agentConfig={agentConfig} onChange={set} />
        <ActsAs agentConfig={agentConfig} onChange={set} />
      </CardContent>
    </Card>
  )
}

function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

/* ── Tools and APIs ─────────────────────────────────────────────────── */

interface ApiRow {
  id: string
  name: string
}

function ToolsAndApis({
  tools,
  toolIds,
  onToolIdsChange,
  apiIds,
  onApiIdsChange,
}: {
  tools: any[]
  toolIds: string[]
  onToolIdsChange: (ids: string[]) => void
  apiIds: string[]
  onApiIdsChange: (ids: string[]) => void
}) {
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const apisQ = useQuery({ queryKey: ['apis', orgId], queryFn: () => apisApi.getAll(), enabled: !!orgId })
  const apis: ApiRow[] = useMemo(() => {
    const raw: any = apisQ.data
    const list = Array.isArray(raw) ? raw : raw?.apis ?? raw?.data ?? []
    return Array.isArray(list) ? list.map((a: any) => ({ id: a.id, name: a.name })) : []
  }, [apisQ.data])
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())

  const q = search.trim().toLowerCase()
  const matches = (t: any) => !q || t.name?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q)
  // Grouped by the API each tool came from; tools of no API last.
  const groups = useMemo(() => {
    const byApi = new Map<string, any[]>()
    for (const t of tools) {
      const key = t.apiId && apis.some((a) => a.id === t.apiId) ? t.apiId : ''
      byApi.set(key, [...(byApi.get(key) ?? []), t])
    }
    const out = apis
      .filter((a) => byApi.has(a.id) || apiIds.includes(a.id))
      .map((a) => ({ id: a.id, name: a.name, tools: byApi.get(a.id) ?? [] }))
      .sort((a, b) => a.name.localeCompare(b.name))
    if (byApi.has('')) out.push({ id: '', name: 'Other tools', tools: byApi.get('') ?? [] })
    return out
  }, [tools, apis, apiIds])

  const toggleTool = (id: string, on: boolean) => onToolIdsChange(on ? [...toolIds, id] : toolIds.filter((t) => t !== id))
  const toggleApi = (id: string, on: boolean) => onApiIdsChange(on ? [...apiIds, id] : apiIds.filter((a) => a !== id))
  const apiName = (id: string) => apis.find((a) => a.id === id)?.name ?? id
  const toolName = (id: string) => tools.find((t) => t.id === id)?.name ?? id

  return (
    <section className="space-y-3" data-testid="capability-tools">
      <SectionHeading title="Tools and APIs" hint="Pick single tools, or a whole API: every tool of it, including tools added to it later." />
      {(apiIds.length > 0 || toolIds.length > 0) && (
        <div className="flex flex-wrap gap-1.5" data-testid="capability-tools-chosen">
          {apiIds.map((id) => (
            <Badge key={`api-${id}`} variant="secondary" className="text-xs gap-1 pr-1">
              {apiName(id)}, all tools
              <button type="button" aria-label={`Remove ${apiName(id)}`} onClick={() => toggleApi(id, false)} className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {toolIds.map((id) => (
            <Badge key={`tool-${id}`} variant="secondary" className="text-xs gap-1 pr-1">
              {toolName(id)}
              <button type="button" aria-label={`Remove ${toolName(id)}`} onClick={() => toggleTool(id, false)} className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      {tools.length === 0 && apis.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No tools yet"
          description="Import an API or create a tool, and it can be picked here."
          action={<Link to="/apis/new" className="text-sm text-primary hover:underline">Import an API</Link>}
          secondaryAction={<Link to="/tools/new" className="text-sm text-primary hover:underline">Create a tool</Link>}
        />
      ) : (
        <>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input placeholder="Search tools" aria-label="Search tools" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
          </div>
          <div className="max-h-[400px] overflow-y-auto space-y-1">
            {groups.map((g) => {
              const shown = g.tools.filter(matches)
              if (q && shown.length === 0 && !g.name.toLowerCase().includes(q)) return null
              const whole = !!g.id && apiIds.includes(g.id)
              const expanded = open.has(g.id) || !!q
              const picked = g.tools.filter((t) => toolIds.includes(t.id)).length
              return (
                <div key={g.id || 'other'} className="rounded-md border" data-testid={`tool-group-${g.id || 'other'}`}>
                  <div className="flex items-center gap-2 p-2">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-expanded={expanded}
                      onClick={() => {
                        const next = new Set(open)
                        if (next.has(g.id)) next.delete(g.id)
                        else next.add(g.id)
                        setOpen(next)
                      }}
                    >
                      {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />}
                      <span className="text-sm font-medium truncate">{g.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {whole ? 'all tools' : `${pluralized(g.tools.length, 'tool')}${picked ? `, ${picked} picked` : ''}`}
                      </span>
                    </button>
                    {g.id && (
                      <label className="flex items-center gap-2 text-xs cursor-pointer shrink-0">
                        <Checkbox
                          checked={whole}
                          onCheckedChange={(on) => toggleApi(g.id, on === true)}
                          aria-label={`All tools of ${g.name}, including ones added later`}
                        />
                        All tools
                      </label>
                    )}
                  </div>
                  {expanded && (
                    <div className="border-t px-2 py-1 space-y-0.5">
                      {shown.map((t) => (
                        <label key={t.id} className="flex items-center gap-3 rounded-md p-1.5 hover:bg-muted/50 cursor-pointer">
                          <Checkbox
                            checked={whole || toolIds.includes(t.id)}
                            disabled={whole}
                            onCheckedChange={(on) => toggleTool(t.id, on === true)}
                            aria-label={t.name}
                          />
                          <div className="min-w-0">
                            <p className="text-sm truncate">{t.name}</p>
                            {t.description && <p className="text-xs text-muted-foreground truncate">{t.description}</p>}
                          </div>
                        </label>
                      ))}
                      {shown.length === 0 && <p className="p-1.5 text-xs text-muted-foreground">No tools in this API yet. New ones are included when they are added.</p>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}

/* ── Other agents ───────────────────────────────────────────────────── */

function OtherAgents({
  agentId,
  agents,
  value,
  everyAgent,
  onChange,
}: {
  agentId?: string
  agents: Array<{ id: string; name: string; description?: string; isTemporary?: boolean }>
  value: string[]
  /** Set through the API before agents were picked one by one: it may call every agent. */
  everyAgent: boolean
  onChange: (ids: string[]) => void
}) {
  const [search, setSearch] = useState('')
  const others = agents.filter((a) => a.id !== agentId && !a.isTemporary)
  const q = search.trim().toLowerCase()
  const shown = others.filter((a) => !q || a.name.toLowerCase().includes(q))
  return (
    <section className="space-y-3" data-testid="capability-agents">
      <SectionHeading title="Other agents it can call" hint="It can hand work to these agents and use their answers. No other agent is reachable." />
      {others.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No other agents yet"
          description="Create another agent, and it can be picked here."
          action={<Link to="/agents/new" className="text-sm text-primary hover:underline">Create agent</Link>}
        />
      ) : (
        <>
          {others.length > 6 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input placeholder="Search agents" aria-label="Search agents" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
            </div>
          )}
          <div className="max-h-[260px] overflow-y-auto rounded-md border divide-y">
            {shown.map((a) => (
              <label key={a.id} className="flex items-center gap-3 p-2 hover:bg-muted/50 cursor-pointer">
                <Checkbox
                  checked={value.includes(a.id)}
                  onCheckedChange={(on) => onChange(on === true ? [...value, a.id] : value.filter((id) => id !== a.id))}
                  aria-label={a.name}
                />
                <div className="min-w-0">
                  <p className="text-sm truncate">{a.name}</p>
                  {a.description && <p className="text-xs text-muted-foreground truncate">{a.description}</p>}
                </div>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="capability-agents-count">
            {everyAgent
              ? 'It can call every agent this run could start. Pick agents to allow only those.'
              : value.length === 0
                ? 'It calls no other agent.'
                : `It can call ${pluralized(value.length, 'agent')}.`}
          </p>
        </>
      )}
    </section>
  )
}

/* ── Machine ────────────────────────────────────────────────────────── */

interface RunnerRow {
  id: string
  name: string
  state: string
  labels: Record<string, string>
}

function Machine({ value, onChange }: { value: Record<string, string> | string | undefined; onChange: (text: string) => void }) {
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)
  const runnersQ = useQuery<RunnerRow[]>({ queryKey: ['runners', orgId], queryFn: () => runnersApi.getAll(), enabled: !!orgId })
  const wanted = parseRunnerLabels(value)
  const keys = Object.keys(wanted)
  const runners = Array.isArray(runnersQ.data) ? runnersQ.data : []
  const matching = keys.length ? runners.filter((r) => keys.every((k) => r.labels?.[k] === wanted[k])) : []
  const online = matching.filter((r) => r.state === 'online' || r.state === 'busy')
  return (
    <section className="space-y-3" data-testid="capability-machine">
      <SectionHeading title="Machine" hint="Where its tools that run on your machines run." />
      <RunnerLabelsField
        id="agent-runner-labels"
        value={value}
        onChange={onChange}
        hint="Work goes to an online machine with all of these labels, and nowhere else. Leave empty to use each tool's own machine."
      />
      {keys.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="capability-machine-matches">
          {matching.length === 0
            ? 'No machine has these labels yet, so work for a machine is refused until one does.'
            : `${pluralized(matching.length, 'machine')} with these labels: ${matching.map((r) => `${r.name}${online.includes(r) ? ' (online)' : ''}`).join(', ')}.`}
        </p>
      )}
    </section>
  )
}

/* ── Temporary agents ───────────────────────────────────────────────── */

function TemporaryAgents({ agentConfig, onChange }: { agentConfig: AgentConfig; onChange: (patch: Partial<AgentConfig>) => void }) {
  const on = !!agentConfig.canCreateAgents
  const number = (v: string) => (v === '' ? undefined : Number(v))
  return (
    <section className="space-y-3" data-testid="capability-temporary">
      <div className="flex items-start justify-between gap-4">
        <SectionHeading title="Temporary agents" hint="It may create a helper agent for part of a task. A helper is removed when the run ends and only gets tools this agent has." />
        <Switch
          id="agent-can-create"
          aria-label="Can create temporary agents"
          checked={on}
          onCheckedChange={(checked) =>
            onChange(
              checked
                ? {
                    canCreateAgents: true,
                    maxTemporaryAgents: agentConfig.maxTemporaryAgents ?? TEMPORARY_AGENTS_PER_RUN_DEFAULT,
                    maxTemporaryAgentsAlive: agentConfig.maxTemporaryAgentsAlive ?? TEMPORARY_AGENTS_ALIVE_DEFAULT,
                  }
                : { canCreateAgents: false },
            )
          }
        />
      </div>
      {on && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="temporary-per-run">At most per run</Label>
            <Input
              id="temporary-per-run"
              type="number"
              min={1}
              max={TEMPORARY_AGENTS_MAX}
              value={agentConfig.maxTemporaryAgents ?? ''}
              onChange={(e) => onChange({ maxTemporaryAgents: number(e.target.value) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="temporary-alive">At most at once</Label>
            <Input
              id="temporary-alive"
              type="number"
              min={1}
              max={TEMPORARY_AGENTS_MAX}
              value={agentConfig.maxTemporaryAgentsAlive ?? ''}
              onChange={(e) => onChange({ maxTemporaryAgentsAlive: number(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">Across all its runs at the same time.</p>
          </div>
        </div>
      )}
    </section>
  )
}

/* ── Acts as ────────────────────────────────────────────────────────── */

export const ACTS_AS_ENTITLEMENT = 'agent_identity'

/**
 * Who the agent's runs that nobody starts by hand (a schedule) act as:
 * its owner, or the agent itself (backend agents/agent-identity.ts). As
 * itself it uses only the connections given to it, and the audit log names
 * the agent. Business plan; the server refuses turning it on without it.
 */
export function ActsAs({ agentConfig, onChange }: { agentConfig: AgentConfig; onChange: (patch: Partial<AgentConfig>) => void }) {
  const { enabled, isLoading } = useEntitlement(ACTS_AS_ENTITLEMENT)
  const value = agentConfig.runAs === 'agent' ? 'agent' : 'owner'
  const locked = !isLoading && !enabled
  return (
    <section className="space-y-3" data-testid="capability-acts-as">
      <SectionHeading
        title="Acts as"
        hint="Who the agent is when it works on its own, for example on a schedule."
      />
      <div className="space-y-1.5">
        <Label htmlFor="agent-acts-as" className="sr-only">Acts as</Label>
        <Select value={value} onValueChange={(v) => onChange({ runAs: v as 'owner' | 'agent' })}>
          <SelectTrigger id="agent-acts-as" className="h-9 sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="owner">You, its owner</SelectItem>
            <SelectItem value="agent" disabled={locked && value !== 'agent'}>Itself, with its own access</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground" data-testid="acts-as-hint">
          {value === 'agent'
            ? 'It uses only the connections given to it, never yours, and the audit log names the agent as the one who acted.'
            : 'It uses what you can use, and the audit log names you.'}
        </p>
        {locked && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-testid="acts-as-locked">
            <Badge variant="outline" className="border-primary/40 text-primary text-[10px] px-1.5 py-0">Business</Badge>
            {value === 'agent'
              ? 'Your plan does not include this any more, so its runs act as you until it does.'
              : 'An agent that acts as itself is part of the Business plan.'}
            <Link to="/settings/billing" className="text-primary hover:underline">See plans</Link>
          </div>
        )}
      </div>
    </section>
  )
}

/** Everything that would stop a save of this section, one sentence each. */
export function capabilityProblems(agentConfig: AgentConfig): string[] {
  const problems: string[] = [...toolModeProblems(agentConfig)]
  if (!agentConfig.canCreateAgents) return problems
  const bad = (n: unknown) => n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > TEMPORARY_AGENTS_MAX)
  if (bad(agentConfig.maxTemporaryAgents)) problems.push(`Temporary agents per run: a whole number from 1 to ${TEMPORARY_AGENTS_MAX}`)
  if (bad(agentConfig.maxTemporaryAgentsAlive)) problems.push(`Temporary agents at once: a whole number from 1 to ${TEMPORARY_AGENTS_MAX}`)
  return problems
}

/* ── How the model sees its tools ───────────────────────────────────── */

export const TOOL_MODE_LABEL: Record<ToolMode, string> = {
  auto: 'Automatic',
  direct: 'Show every tool',
  discover: 'Search for tools',
  code: 'Search, and write scripts',
}

const TOOL_MODE_HINT: Record<ToolMode, string> = {
  auto: 'Every tool is shown to the model while the list is small. Once it would take a large share of the model\'s context, the model searches for the tools it needs instead.',
  direct: 'The model sees every tool, in full, on every step. Best for a handful of tools.',
  discover: 'The model gets three small tools to search for, read and run its tools, and finds the right one when it needs it. Best for many tools.',
  code: 'As with searching, and the model can also write a short script that calls the tools many times, for example to go through a list. The script runs in a locked box with no network access; every call it makes is checked like any other.',
}

type ToolMode = 'auto' | 'direct' | 'discover' | 'code'

export function ToolModeSection({
  agentConfig,
  usableTools,
  onChange,
}: {
  agentConfig: AgentConfig
  /** The tools this agent may use (picked singly or through an API): the ones that can be pinned. */
  usableTools: Array<{ id: string; name: string }>
  onChange: (patch: Partial<AgentConfig>) => void
}) {
  const mode: ToolMode = agentConfig.toolMode ?? 'auto'
  const pinned = agentConfig.pinnedToolIds ?? []
  const togglePin = (id: string, on: boolean) => {
    const next = on ? [...pinned, id] : pinned.filter((p) => p !== id)
    onChange({ pinnedToolIds: next.length ? next : undefined })
  }
  return (
    <section className="space-y-3" data-testid="capability-tool-mode">
      <SectionHeading
        title="How the model sees its tools"
        hint="Many tools take up room the model needs for the task itself. Searching keeps that small; every tool stays just as usable."
      />
      <div className="space-y-1.5">
        <Label htmlFor="agent-tool-mode">Tool list</Label>
        <Select value={mode} onValueChange={(v) => onChange({ toolMode: v as ToolMode })}>
          <SelectTrigger id="agent-tool-mode" className="h-9 sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['auto', 'direct', 'discover', 'code'] as const).map((m) => (
              <SelectItem key={m} value={m}>{TOOL_MODE_LABEL[m]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{TOOL_MODE_HINT[mode]}</p>
      </div>
      {mode === 'auto' && (
        <div className="space-y-1.5">
          <Label htmlFor="agent-tool-mode-threshold">Switch to searching above (tokens)</Label>
          <Input
            id="agent-tool-mode-threshold"
            type="number"
            min={1}
            className="sm:w-64"
            placeholder="Default"
            value={agentConfig.toolModeThresholdTokens ?? ''}
            onChange={(e) => onChange({ toolModeThresholdTokens: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
          <p className="text-xs text-muted-foreground">Leave empty for the default: a share of the model's context window (3% unless the server sets another).</p>
        </div>
      )}
      {mode === 'code' && <ScriptChanges agentConfig={agentConfig} onChange={onChange} />}
      {mode !== 'direct' && usableTools.length > 0 && (
        <div className="space-y-1.5">
          <Label>Always show in full</Label>
          <p className="text-xs text-muted-foreground">Tools the model needs on almost every task, so it never has to search for them.</p>
          {pinned.length > 0 && (
            <p className="text-xs" data-testid="pin-summary">
              Always shown: {usableTools.filter((t) => pinned.includes(t.id)).map((t) => t.name).sort().join(', ') || 'none of the tools above'}
            </p>
          )}
          {/* By name; a long list scrolls in place. */}
          <div className="grid max-h-56 grid-cols-1 gap-1.5 overflow-y-auto rounded-md border p-2 sm:grid-cols-2" data-testid="pin-list">
            {[...usableTools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={pinned.includes(t.id)} onCheckedChange={(on) => togglePin(t.id, on === true)} aria-label={`Always show ${t.name}`} />
                <span className="truncate font-mono text-xs">{t.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/** Problems with the tool-mode settings, one sentence each (the server checks the same: agent-tool-mode.ts). */
export function toolModeProblems(agentConfig: AgentConfig): string[] {
  const n = agentConfig.toolModeThresholdTokens
  if (n === undefined) return []
  return Number.isInteger(n) && n > 0 && n <= 10_000_000 ? [] : ['Switch to searching above: a whole number of tokens from 1 to 10,000,000']
}

/* ── What a script may change (code mode) ───────────────────────────── */

const WRITE_ACTION_LABEL: Record<CodeWriteAction, string> = {
  allow: 'Make them',
  stage: 'Ask a person first',
  deny: 'Never',
}

/**
 * What happens to a change or a deletion a script makes (backend
 * code-mode/code-write-policy.ts). Reads always run. Changes run unless
 * a person asks to approve them; deletions wait for a person unless someone
 * says otherwise. Every call still goes through the same permissions,
 * approval rules and audit as a call the model makes directly.
 */
export function ScriptChanges({ agentConfig, onChange }: { agentConfig: AgentConfig; onChange: (patch: Partial<AgentConfig>) => void }) {
  const writes = agentConfig.codeMode?.writes ?? {}
  const set = (key: 'write' | 'destructive', value: CodeWriteAction) =>
    onChange({ codeMode: { ...(agentConfig.codeMode ?? {}), writes: { ...writes, [key]: value } } })
  const rows: Array<{ key: 'write' | 'destructive'; label: string; fallback: CodeWriteAction }> = [
    { key: 'write', label: 'Changes to data', fallback: 'allow' },
    { key: 'destructive', label: 'Deletions', fallback: 'stage' },
  ]
  return (
    <div className="space-y-2" data-testid="script-changes">
      <Label>When a script changes data</Label>
      <p className="text-xs text-muted-foreground">
        Reading always runs. Changes the script asks a person about are collected into one list, approved or rejected as a whole once the script is done.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.key} className="space-y-1.5">
            <Label htmlFor={`script-${row.key}`} className="text-xs font-normal text-muted-foreground">{row.label}</Label>
            <Select value={writes[row.key] ?? row.fallback} onValueChange={(v) => set(row.key, v as CodeWriteAction)}>
              <SelectTrigger id={`script-${row.key}`} aria-label={row.label} className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['allow', 'stage', 'deny'] as const).map((a) => (
                  <SelectItem key={a} value={a}>{WRITE_ACTION_LABEL[a]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
    </div>
  )
}
