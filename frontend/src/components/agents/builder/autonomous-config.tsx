/**
 * AutonomousConfig — form cards for autonomous-mode agent configuration.
 *
 * Renders: Personality, Instructions, Model, Tools (grouped + searchable),
 * Memory, Agent Capabilities, Collaboration (agents and models), and
 * Heartbeat. All state is owned by the parent (AgentBuilderPage) and
 * threaded via props.
 */
import React, { useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Cpu, Search, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RunLimitsSection, type RunLimitsConfig } from '@/components/agents/builder/run-limits-section'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ModelPicker } from '@/components/model-picker'
import type {
  CollaborationParticipant,
  CollaborationState,
  ModelParticipant,
} from '@/components/agents/builder/collaboration'

export interface AutonomousConfigProps {
  agentId?: string
  personality: string
  onPersonalityChange: (v: string) => void
  instructions: string
  onInstructionsChange: (v: string) => void
  modelConfig: { providerId?: string; model?: string; temperature?: number; maxTokens?: number }
  onModelConfigChange: (v: AutonomousConfigProps['modelConfig']) => void
  toolIds: string[]
  onToolIdsChange: (v: string[]) => void
  tools: any[]
  memoryConfig: { enabled?: boolean; autoSave?: boolean }
  onMemoryConfigChange: (v: AutonomousConfigProps['memoryConfig']) => void
  agentConfig: {
    canCallAgents?: boolean
    canCreateAgents?: boolean
    runLimits?: RunLimitsConfig
  }
  onAgentConfigChange: (v: AutonomousConfigProps['agentConfig']) => void
  collaboration: CollaborationState
  onCollaborationChange: (v: CollaborationState) => void
  availableAgents: any[]
  heartbeat: { enabled: boolean; intervalMinutes: number; prompt: string }
  onHeartbeatChange: (v: AutonomousConfigProps['heartbeat']) => void
}

export function AutonomousConfig({
  agentId,
  personality, onPersonalityChange,
  instructions, onInstructionsChange,
  modelConfig, onModelConfigChange,
  toolIds, onToolIdsChange, tools,
  memoryConfig, onMemoryConfigChange,
  agentConfig, onAgentConfigChange,
  collaboration, onCollaborationChange, availableAgents,
  heartbeat, onHeartbeatChange,
}: AutonomousConfigProps) {
  const [toolSearch, setToolSearch] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 max-w-4xl mx-auto w-full space-y-6">
      {/* Personality */}
      <Card>
        <CardHeader><CardTitle className="text-base">Personality & style</CardTitle></CardHeader>
        <CardContent>
          <Textarea value={personality} onChange={(e) => onPersonalityChange(e.target.value)}
            placeholder="You are a friendly, professional assistant. You never share personal opinions on politics or religion. You always cite your sources."
            className="min-h-[120px] font-mono text-sm" />
          <p className="text-xs text-muted-foreground mt-2">Personality, tone, and boundaries. Defines WHO the agent is.</p>
        </CardContent>
      </Card>

      {/* Instructions */}
      <Card>
        <CardHeader><CardTitle className="text-base">Instructions</CardTitle></CardHeader>
        <CardContent>
          <Textarea value={instructions} onChange={(e) => onInstructionsChange(e.target.value)}
            placeholder="You are a helpful assistant that..."
            className="min-h-[200px] font-mono text-sm" />
          <p className="text-xs text-muted-foreground mt-2">What the agent should do. Goals, tasks, and workflows.</p>
        </CardContent>
      </Card>

      {/* Model */}
      <Card>
        <CardHeader><CardTitle className="text-base">Model configuration</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <ModelPicker
            idPrefix="autonomous"
            value={{ providerId: modelConfig.providerId, model: modelConfig.model }}
            onChange={(next) => onModelConfigChange({ ...modelConfig, providerId: next.providerId, model: next.model })}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="autonomous-temperature" className="text-sm">Temperature</Label>
              <Input id="autonomous-temperature" type="number" min={0} max={2} step={0.1} value={modelConfig.temperature ?? 0.7}
                onChange={(e) => onModelConfigChange({ ...modelConfig, temperature: parseFloat(e.target.value) })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="autonomous-max-tokens" className="text-sm">Max Tokens</Label>
              <Input id="autonomous-max-tokens" type="number" min={1} max={200000} value={modelConfig.maxTokens ?? 4096}
                onChange={(e) => onModelConfigChange({ ...modelConfig, maxTokens: parseInt(e.target.value) })} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tools */}
      <Card>
        <CardHeader><CardTitle className="text-base">Tools</CardTitle></CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">Select which tools this agent can use during execution.</p>
          {toolIds.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-medium text-muted-foreground mb-1.5">{toolIds.length} tool{toolIds.length !== 1 ? 's' : ''} selected</p>
              <div className="flex flex-wrap gap-1.5">
                {toolIds.map((tid) => {
                  const tool = tools.find((t: any) => t.id === tid)
                  return (
                    <Badge key={tid} variant="secondary" className="text-xs gap-1 pr-1">
                      {tool?.name || tid}
                      <button type="button" onClick={() => onToolIdsChange(toolIds.filter((i) => i !== tid))}
                        className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5">
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  )
                })}
              </div>
            </div>
          )}
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input placeholder="Search tools..." value={toolSearch} onChange={(e) => setToolSearch(e.target.value)} className="pl-8 h-8 text-sm" />
          </div>
          <ToolGroupList tools={tools} toolSearch={toolSearch} selectedIds={toolIds} onSelectedIdsChange={onToolIdsChange}
            expandedGroups={expandedGroups} onExpandedGroupsChange={setExpandedGroups} />
        </CardContent>
      </Card>

      {/* Memory */}
      <Card>
        <CardHeader><CardTitle className="text-base">Memory</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={memoryConfig.enabled || false}
              onChange={(e) => onMemoryConfigChange({ ...memoryConfig, enabled: e.target.checked })} className="rounded" />
            <div><p className="text-sm font-medium">Enable Memory</p><p className="text-xs text-muted-foreground">Agent will recall relevant memories before each model call</p></div>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={memoryConfig.autoSave || false}
              onChange={(e) => onMemoryConfigChange({ ...memoryConfig, autoSave: e.target.checked })} className="rounded" />
            <div><p className="text-sm font-medium">Auto-save Memories</p><p className="text-xs text-muted-foreground">Automatically extract and save key facts from conversations</p></div>
          </label>
        </CardContent>
      </Card>

      {/* Capabilities */}
      <Card>
        <CardHeader><CardTitle className="text-base">Agent capabilities</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={agentConfig.canCallAgents || false}
              onChange={(e) => onAgentConfigChange({ ...agentConfig, canCallAgents: e.target.checked })} className="rounded" />
            <div><p className="text-sm font-medium">Can call other agents</p><p className="text-xs text-muted-foreground">Discover and invoke existing agents as sub-agents</p></div>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={agentConfig.canCreateAgents || false}
              onChange={(e) => onAgentConfigChange({ ...agentConfig, canCreateAgents: e.target.checked })} className="rounded" />
            <div><p className="text-sm font-medium">Can create agents</p><p className="text-xs text-muted-foreground">Spawn temporary specialist agents during runs</p></div>
          </label>
        </CardContent>
      </Card>

      {/* Run limits — the ceilings a run cannot exceed. Sits next to
          capabilities on purpose: what an agent may do and how far it
          may go are the same decision. */}
      <RunLimitsSection
        value={agentConfig.runLimits ?? {}}
        onChange={(runLimits) => onAgentConfigChange({ ...agentConfig, runLimits })}
      />

      {/* Collaboration */}
      <Card>
        <CardHeader><CardTitle className="text-base">Collaboration</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={collaboration.enabled}
              onChange={(e) => onCollaborationChange({ ...collaboration, enabled: e.target.checked })} className="rounded" />
            <div><p className="text-sm font-medium">Enable collaboration</p><p className="text-xs text-muted-foreground">Other agents and models work on each request with this one, in the order and shape you choose</p></div>
          </label>
          {collaboration.enabled && (
            <CollaborationConfig agentId={agentId} collaboration={collaboration} onChange={onCollaborationChange} availableAgents={availableAgents} />
          )}
        </CardContent>
      </Card>

      {/* Heartbeat */}
      <Card>
        <CardHeader><CardTitle className="text-base">Heartbeat</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={heartbeat.enabled}
              onChange={(e) => onHeartbeatChange({ ...heartbeat, enabled: e.target.checked })} className="rounded" />
            <div><p className="text-sm font-medium">Enable Heartbeat</p><p className="text-xs text-muted-foreground">Agent wakes up periodically to check conditions or process tasks</p></div>
          </label>
          {heartbeat.enabled && (
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="autonomous-interval" className="text-sm">Interval (minutes)</Label>
                <Input id="autonomous-interval" type="number" min={1} value={heartbeat.intervalMinutes}
                  onChange={(e) => onHeartbeatChange({ ...heartbeat, intervalMinutes: parseInt(e.target.value) || 60 })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="autonomous-heartbeat-prompt" className="text-sm">Heartbeat Prompt</Label>
                <Textarea id="autonomous-heartbeat-prompt" value={heartbeat.prompt} onChange={(e) => onHeartbeatChange({ ...heartbeat, prompt: e.target.value })}
                  placeholder="Check my inbox for new messages. If there are urgent items, summarize them."
                  className="min-h-[100px] font-mono text-sm" />
                <p className="text-xs text-muted-foreground">What the agent should do on each heartbeat wake-up.</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="h-8" />
    </div>
  )
}

/* ── Private sub-components ───────────────────────────────────────────── */

function ToolGroupList({ tools, toolSearch, selectedIds, onSelectedIdsChange, expandedGroups, onExpandedGroupsChange }: {
  tools: any[]; toolSearch: string; selectedIds: string[]; onSelectedIdsChange: (v: string[]) => void
  expandedGroups: Set<string>; onExpandedGroupsChange: (v: Set<string>) => void
}) {
  const searchLower = toolSearch.toLowerCase()
  const filtered = tools.filter((t: any) => !toolSearch || t.name?.toLowerCase().includes(searchLower) || t.description?.toLowerCase().includes(searchLower))

  if (tools.length === 0) return <p className="text-sm text-muted-foreground py-4 text-center">No tools available. Create tools first.</p>
  if (filtered.length === 0) return <p className="text-sm text-muted-foreground py-4 text-center">No tools matching &ldquo;{toolSearch}&rdquo;</p>

  const prefixBuckets: Record<string, any[]> = {}
  for (const tool of filtered) {
    const prefix = (tool.name || '').split('_')[0]
    if (!prefixBuckets[prefix]) prefixBuckets[prefix] = []
    prefixBuckets[prefix].push(tool)
  }
  const groups: Record<string, any[]> = {}
  const otherTools: any[] = []
  for (const [prefix, items] of Object.entries(prefixBuckets)) {
    if (items.length >= 3) groups[prefix] = items
    else otherTools.push(...items)
  }
  if (otherTools.length > 0) groups['Other'] = otherTools

  const groupEntries = Object.entries(groups).sort(([a], [b]) => { if (a === 'Other') return 1; if (b === 'Other') return -1; return a.localeCompare(b) })

  return (
    <div className="max-h-[400px] overflow-y-auto space-y-1">
      {groupEntries.map(([groupName, groupTools]) => {
        const isExpanded = expandedGroups.has(groupName)
        const selectedInGroup = groupTools.filter((t: any) => selectedIds.includes(t.id)).length
        const allSelectedInGroup = selectedInGroup === groupTools.length

        const toggleGroup = () => { const next = new Set(expandedGroups); if (next.has(groupName)) next.delete(groupName); else next.add(groupName); onExpandedGroupsChange(next) }
        const selectAll = () => { const idsToAdd = groupTools.map((t: any) => t.id).filter((tid: string) => !selectedIds.includes(tid)); onSelectedIdsChange([...selectedIds, ...idsToAdd]) }
        const deselectAll = () => { const idsToRemove = new Set(groupTools.map((t: any) => t.id)); onSelectedIdsChange(selectedIds.filter((tid) => !idsToRemove.has(tid))) }

        return (
          <div key={groupName} className="border rounded-md">
            <div
              className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted/50 select-none"
              role="button"
              tabIndex={0}
              aria-expanded={isExpanded}
              onClick={toggleGroup}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleGroup()
                }
              }}
            >
              {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              <span className="text-sm font-medium flex-1">{groupName}</span>
              <span className="text-xs text-muted-foreground">{groupTools.length} tool{groupTools.length !== 1 ? 's' : ''}{selectedInGroup > 0 ? `, ${selectedInGroup} selected` : ''}</span>
              <Button type="button" variant="ghost" size="sm" className="h-6 text-xs px-2"
                onClick={(e) => { e.stopPropagation(); allSelectedInGroup ? deselectAll() : selectAll() }}>
                {allSelectedInGroup ? 'Deselect all' : 'Select all'}
              </Button>
            </div>
            {isExpanded && (
              <div className="border-t px-2 pb-2 space-y-0.5">
                {groupTools.map((tool: any) => (
                  <label key={tool.id} className="flex items-center gap-3 p-1.5 rounded-md hover:bg-muted/50 cursor-pointer">
                    <input type="checkbox" checked={selectedIds.includes(tool.id)}
                      onChange={(e) => { if (e.target.checked) onSelectedIdsChange([...selectedIds, tool.id]); else onSelectedIdsChange(selectedIds.filter((i) => i !== tool.id)) }}
                      className="rounded" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{tool.name}</p>
                      {tool.description && <p className="text-xs text-muted-foreground truncate">{tool.description}</p>}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const STRATEGY_HINTS: Record<CollaborationState['strategy'], string> = {
  sequential: 'This agent answers first, then each participant in order, each reading the previous output.',
  parallel: 'Every participant answers at once; a judge merges the answers, or they are listed together.',
  race: 'Every participant answers at once; the first to finish wins and the rest are stopped.',
  debate: 'Participants answer in rounds, each round reading the last; a judge writes the verdict.',
}

function CollaborationConfig({ agentId, collaboration, onChange, availableAgents }: {
  agentId?: string
  collaboration: CollaborationState
  onChange: (v: CollaborationState) => void
  availableAgents: any[]
}) {
  const otherAgents = availableAgents.filter((a: any) => a.id !== agentId)
  const participants = collaboration.participants
  const setParticipants = (next: CollaborationParticipant[]) => onChange({ ...collaboration, participants: next })
  const patch = (i: number, next: CollaborationParticipant) => setParticipants(participants.map((p, idx) => (idx === i ? next : p)))
  const move = (i: number, by: -1 | 1) => {
    const j = i + by
    if (j < 0 || j >= participants.length) return
    const next = [...participants]
    ;[next[i], next[j]] = [next[j], next[i]]
    setParticipants(next)
  }
  const ordered = collaboration.strategy === 'sequential'

  return (
    <div className="space-y-4 pt-2">
      <div className="space-y-2">
        <Label htmlFor="autonomous-strategy" className="text-sm">Strategy</Label>
        <Select value={collaboration.strategy} onValueChange={(v: any) => onChange({ ...collaboration, strategy: v })}>
          <SelectTrigger id="autonomous-strategy"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="sequential">Sequential</SelectItem>
            <SelectItem value="parallel">Parallel</SelectItem>
            <SelectItem value="race">Race</SelectItem>
            <SelectItem value="debate">Debate</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{STRATEGY_HINTS[collaboration.strategy]}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm">Participants</Label>
        <p className="text-xs text-muted-foreground">
          A participant is another agent, or a model called directly. Mix them freely{ordered ? '; they run top to bottom' : ''}.
        </p>
        {participants.length === 0 && (
          <p data-testid="no-participants" className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            No participants yet. Add a model to run it alongside this agent
            {otherAgents.length > 0 ? ', or add one of your other agents.' : '. Other agents can join too once you have more than one.'}
          </p>
        )}
        <ol className="space-y-2">
          {participants.map((p, i) => (
            <li key={i} className="rounded-md border p-3 space-y-3" data-testid={`participant-${i}`}>
              <div className="flex items-center gap-2">
                {p.kind === 'agent' ? <Bot className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden /> : <Cpu className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />}
                <span className="text-sm font-medium flex-1 shrink-0 whitespace-nowrap">
                  {ordered ? `${i + 1}. ` : ''}{p.kind === 'agent' ? 'Agent' : 'Model'}
                </span>
                <Input
                  aria-label={`Participant ${i + 1} role`}
                  placeholder="Role"
                  value={p.role || ''}
                  onChange={(e) => patch(i, { ...p, role: e.target.value || undefined })}
                  className="w-24 min-w-0 sm:w-40 h-7 text-xs"
                />
                {ordered && (
                  <>
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move participant ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ChevronDown className="h-3.5 w-3.5 rotate-180" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move participant ${i + 1} down`} disabled={i === participants.length - 1} onClick={() => move(i, 1)}>
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={`Remove participant ${i + 1}`} onClick={() => setParticipants(participants.filter((_, idx) => idx !== i))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {p.kind === 'agent' ? (
                <AgentChoice idPrefix={`participant-${i}`} value={p.agentId} agents={otherAgents} onChange={(id) => patch(i, { ...p, agentId: id })} />
              ) : (
                <ModelParticipantFields idPrefix={`participant-${i}`} value={p} onChange={(next) => patch(i, next)} />
              )}
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setParticipants([...participants, { kind: 'model' }])}>
            <Cpu className="h-3.5 w-3.5 mr-1.5" /> Add model
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={otherAgents.length === 0}
            onClick={() => setParticipants([...participants, { kind: 'agent', agentId: '' }])}
          >
            <Bot className="h-3.5 w-3.5 mr-1.5" /> Add agent
          </Button>
          {otherAgents.length === 0 && (
            <span className="text-xs text-muted-foreground" data-testid="no-other-agents">No other agents yet; models work without one.</span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="autonomous-shared-brief" className="text-sm">Shared Brief</Label>
        <Textarea id="autonomous-shared-brief" placeholder="Context shared with every participant..." value={collaboration.sharedBrief || ''}
          onChange={(e) => onChange({ ...collaboration, sharedBrief: e.target.value })} rows={2} />
      </div>

      <div className="space-y-3 border-t pt-3">
        <Label className="text-sm font-medium">Rules of Engagement</Label>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="autonomous-max-total-cost" className="text-xs text-muted-foreground">Max Total Cost ($)</Label>
            <Input id="autonomous-max-total-cost" type="number" min={0} step={0.01} placeholder="No limit" value={collaboration.rules?.maxTotalCost ?? ''}
              onChange={(e) => onChange({ ...collaboration, rules: { ...collaboration.rules, maxTotalCost: e.target.value ? parseFloat(e.target.value) : undefined } })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="autonomous-max-chain-depth" className="text-xs text-muted-foreground">Max Chain Depth</Label>
            <Input id="autonomous-max-chain-depth" type="number" min={1} max={10} placeholder="No limit" value={collaboration.rules?.maxChainDepth ?? ''}
              onChange={(e) => onChange({ ...collaboration, rules: { ...collaboration.rules, maxChainDepth: e.target.value ? parseInt(e.target.value) : undefined } })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="autonomous-output-format" className="text-xs text-muted-foreground">Output Format</Label>
            <Select value={collaboration.rules?.outputFormat || ''} onValueChange={(v: any) => onChange({ ...collaboration, rules: { ...collaboration.rules, outputFormat: v || undefined } })}>
              <SelectTrigger id="autonomous-output-format"><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent><SelectItem value="text">Text</SelectItem><SelectItem value="json">JSON</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="autonomous-escalation" className="text-xs text-muted-foreground">Escalation</Label>
            <Select value={collaboration.rules?.escalation || ''} onValueChange={(v: any) => onChange({ ...collaboration, rules: { ...collaboration.rules, escalation: v || undefined } })}>
              <SelectTrigger id="autonomous-escalation"><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent><SelectItem value="never">Never</SelectItem><SelectItem value="on_failure">On Failure</SelectItem><SelectItem value="on_low_confidence">On Low Confidence</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
        {collaboration.strategy === 'parallel' && (
          <div className="space-y-1">
            <Label htmlFor="autonomous-conflict-resolution" className="text-xs text-muted-foreground">Conflict Resolution</Label>
            <Select value={collaboration.rules?.conflictResolution || ''} onValueChange={(v: any) => onChange({ ...collaboration, rules: { ...collaboration.rules, conflictResolution: v || undefined } })}>
              <SelectTrigger id="autonomous-conflict-resolution"><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="judge">Judge decides</SelectItem><SelectItem value="majority">Majority wins</SelectItem>
                <SelectItem value="first_wins">First wins</SelectItem><SelectItem value="merge">Merge all</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {(collaboration.strategy === 'debate' || collaboration.strategy === 'parallel') && (
        <div className="space-y-3 border-t pt-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="autonomous-judge-kind" className="text-sm">Judge</Label>
              <Select
                value={collaboration.judge?.kind ?? 'none'}
                onValueChange={(v) => {
                  if (v === 'none') onChange({ ...collaboration, judge: undefined })
                  else if (v === 'model') onChange({ ...collaboration, judge: { kind: 'model' } })
                  else onChange({ ...collaboration, judge: { kind: 'agent', agentId: '' } })
                }}
              >
                <SelectTrigger id="autonomous-judge-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No judge: list every answer</SelectItem>
                  <SelectItem value="model">A model</SelectItem>
                  {/*
                    Your first agent has no siblings, so an agent judge is
                    not on offer until there is one; a model judge is.
                  */}
                  <SelectItem value="agent" disabled={otherAgents.length === 0}>
                    {otherAgents.length === 0 ? 'An agent (no other agents yet)' : 'An agent'}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {collaboration.strategy === 'debate' && (
              <div className="space-y-2">
                <Label htmlFor="autonomous-max-rounds" className="text-sm">Max Rounds</Label>
                <Input id="autonomous-max-rounds" type="number" min={1} max={10} value={collaboration.maxRounds ?? 3}
                  onChange={(e) => onChange({ ...collaboration, maxRounds: parseInt(e.target.value) })} />
              </div>
            )}
          </div>
          {collaboration.judge?.kind === 'agent' && (
            <AgentChoice
              idPrefix="autonomous-judge"
              value={collaboration.judge.agentId}
              agents={otherAgents}
              onChange={(id) => onChange({ ...collaboration, judge: { kind: 'agent', agentId: id } })}
            />
          )}
          {collaboration.judge?.kind === 'model' && (
            <ModelParticipantFields
              idPrefix="autonomous-judge"
              value={collaboration.judge}
              onChange={(next) => onChange({ ...collaboration, judge: next })}
            />
          )}
        </div>
      )}
    </div>
  )
}

function AgentChoice({ idPrefix, value, agents, onChange }: {
  idPrefix: string
  value: string
  agents: any[]
  onChange: (agentId: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${idPrefix}-agent`} className="text-xs">Agent</Label>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger id={`${idPrefix}-agent`} className="h-8 text-xs"><SelectValue placeholder="Select agent" /></SelectTrigger>
        <SelectContent>
          {agents.map((a: any) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

function ModelParticipantFields({ idPrefix, value, onChange }: {
  idPrefix: string
  value: ModelParticipant
  onChange: (next: ModelParticipant) => void
}) {
  return (
    <div className="space-y-3">
      <ModelPicker
        idPrefix={idPrefix}
        compact
        allowRouting
        value={{ providerId: value.providerId, model: value.model, routing: value.routing }}
        onChange={(next) => onChange({ ...value, providerId: next.providerId, model: next.model, routing: next.routing })}
      />
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-instructions`} className="text-xs">Instructions (optional)</Label>
        <Textarea
          id={`${idPrefix}-instructions`}
          rows={2}
          className="text-xs"
          placeholder="What this model should do with what it is given, e.g. find the flaws in the draft"
          value={value.instructions || ''}
          onChange={(e) => onChange({ ...value, instructions: e.target.value || undefined })}
        />
      </div>
    </div>
  )
}