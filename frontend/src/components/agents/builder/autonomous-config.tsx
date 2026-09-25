/**
 * AutonomousConfig — form cards for autonomous-mode agent configuration.
 *
 * Renders: Personality, Instructions, Models (the roles), How they work
 * together (the strategy), Tools (grouped + searchable), Memory, Agent
 * capabilities, Run limits and Heartbeat. All state is owned by the parent
 * (AgentBuilderPage) and threaded via props.
 */
import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Link } from 'react-router-dom'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { VerifierPanelList } from '@/components/agents/verifier-panel'
import { RunLimitsSection, type RunLimitsConfig } from '@/components/agents/builder/run-limits-section'
import { ModelsSection } from '@/components/agents/builder/models-section'
import { StrategyChoice } from '@/components/agents/builder/strategy-choice'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import type { AgentModels } from '@/types/agent-models'
import type { Agent } from '@/types'
import { useOrganizationStore } from '@/store/organization'

export interface AutonomousConfigProps {
  agentId?: string
  personality: string
  onPersonalityChange: (v: string) => void
  instructions: string
  onInstructionsChange: (v: string) => void
  models: AgentModels
  onModelsChange: (v: AgentModels) => void
  toolIds: string[]
  onToolIdsChange: (v: string[]) => void
  tools: any[]
  memoryConfig: { enabled?: boolean; autoSave?: boolean }
  onMemoryConfigChange: (v: AutonomousConfigProps['memoryConfig']) => void
  agentConfig: {
    canCallAgents?: boolean
    canCreateAgents?: boolean
    runLimits?: RunLimitsConfig
    /** Shown read-only here and saved back as it is; edited on the overview. */
    verify?: NonNullable<Agent['agentConfig']>['verify']
    constraints?: NonNullable<Agent['agentConfig']>['constraints']
  }
  onAgentConfigChange: (v: AutonomousConfigProps['agentConfig']) => void
  /** The organization's agents; a panelist or teammate role can be one of them. */
  availableAgents: any[]
  heartbeat: { enabled: boolean; intervalMinutes: number; prompt: string }
  onHeartbeatChange: (v: AutonomousConfigProps['heartbeat']) => void
}

export function AutonomousConfig({
  agentId,
  personality, onPersonalityChange,
  instructions, onInstructionsChange,
  models, onModelsChange,
  toolIds, onToolIdsChange, tools,
  memoryConfig, onMemoryConfigChange,
  agentConfig, onAgentConfigChange,
  availableAgents,
  heartbeat, onHeartbeatChange,
}: AutonomousConfigProps) {
  // The organization's defaults sit above this agent's limits; the run
  // limits line counts them in, so it says what a run will really get.
  const orgDefaults = useOrganizationStore((s) => s.currentOrganization?.agentDefaults)
  const orgRunLimits = {
    maxSteps: orgDefaults?.maxStepsPerRun || undefined,
    maxCostCents: orgDefaults?.maxCostPerRun ? Math.floor(orgDefaults.maxCostPerRun * 100) : undefined,
  }
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

      {/* Models: the roles, then how they work together */}
      <ModelsSection models={models} onChange={onModelsChange} agentId={agentId} availableAgents={availableAgents} />
      <StrategyChoice models={models} onChange={onModelsChange} />

      {/* The verifier panel is saved with the agent as it is; it is changed on the overview. */}
      {agentConfig.verify?.enabled && (
        <Card data-testid="verifier-card">
          <CardHeader>
            <CardTitle className="text-base">Verifier panel</CardTitle>
            <CardDescription className="text-xs">These models check every final answer before it goes out.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <VerifierPanelList verify={agentConfig.verify} />
            {agentId && (
              <Link to={`/agents/${agentId}`} className="inline-block text-xs text-primary hover:underline">
                Change it on the agent's overview
              </Link>
            )}
          </CardContent>
        </Card>
      )}

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
            <div><p className="text-sm font-medium">Remember between runs</p><p className="text-xs text-muted-foreground">The agent looks up what it saved earlier before it answers</p></div>
          </label>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={memoryConfig.autoSave || false}
              onChange={(e) => onMemoryConfigChange({ ...memoryConfig, autoSave: e.target.checked })} className="rounded" />
            <div><p className="text-sm font-medium">Save facts automatically</p><p className="text-xs text-muted-foreground">Keeps the key facts from each conversation for next time</p></div>
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
        inherited={orgRunLimits}
      />

      {/* Heartbeat */}
      <Card>
        <CardHeader><CardTitle className="text-base">Heartbeat</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={heartbeat.enabled}
              onChange={(e) => onHeartbeatChange({ ...heartbeat, enabled: e.target.checked })} className="rounded" />
            <div><p className="text-sm font-medium">Wake up on a schedule</p><p className="text-xs text-muted-foreground">Agent wakes up periodically to check conditions or process tasks</p></div>
          </label>
          {heartbeat.enabled && (
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="autonomous-interval" className="text-sm">Interval (minutes)</Label>
                <Input id="autonomous-interval" type="number" min={1} value={heartbeat.intervalMinutes}
                  onChange={(e) => onHeartbeatChange({ ...heartbeat, intervalMinutes: parseInt(e.target.value) || 60 })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="autonomous-heartbeat-prompt" className="text-sm">Heartbeat prompt</Label>
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
