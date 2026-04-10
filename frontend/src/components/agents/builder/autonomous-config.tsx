/**
 * AutonomousConfig — form cards for autonomous-mode agent configuration.
 *
 * Renders: Personality, Instructions, Model, Tools (grouped + searchable),
 * Memory, Agent Capabilities, Collaboration (multi-agent), and Heartbeat.
 * All state is owned by the parent (AgentBuilderPage) and threaded via props.
 */
import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

export interface AutonomousConfigProps {
  agentId?: string
  personality: string
  onPersonalityChange: (v: string) => void
  instructions: string
  onInstructionsChange: (v: string) => void
  modelConfig: { providerId?: string; model?: string; temperature?: number; maxTokens?: number }
  onModelConfigChange: (v: AutonomousConfigProps['modelConfig']) => void
  providers: any[]
  toolIds: string[]
  onToolIdsChange: (v: string[]) => void
  tools: any[]
  memoryConfig: { enabled?: boolean; autoSave?: boolean }
  onMemoryConfigChange: (v: AutonomousConfigProps['memoryConfig']) => void
  agentConfig: { canCallAgents?: boolean; canCreateAgents?: boolean }
  onAgentConfigChange: (v: AutonomousConfigProps['agentConfig']) => void
  collaboration: {
    enabled: boolean
    strategy: 'sequential' | 'parallel' | 'race' | 'debate'
    agents: { agentId: string; role?: string }[]
    sharedBrief?: string
    rules?: {
      maxTotalCost?: number
      maxChainDepth?: number
      outputFormat?: 'text' | 'json'
      escalation?: 'never' | 'on_failure' | 'on_low_confidence'
      conflictResolution?: 'judge' | 'majority' | 'first_wins' | 'merge'
      sharedMemoryScope?: boolean
      allowRevision?: boolean
    }
    judgeAgentId?: string
    maxRounds?: number
  }
  onCollaborationChange: (v: AutonomousConfigProps['collaboration']) => void
  availableAgents: any[]
  heartbeat: { enabled: boolean; intervalMinutes: number; prompt: string }
  onHeartbeatChange: (v: AutonomousConfigProps['heartbeat']) => void
}

export function AutonomousConfig({
  agentId,
  personality, onPersonalityChange,
  instructions, onInstructionsChange,
  modelConfig, onModelConfigChange, providers,
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
        <CardHeader><CardTitle className="text-base">Personality & Style</CardTitle></CardHeader>
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
        <CardHeader><CardTitle className="text-base">Model Configuration</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">Provider</Label>
              <Select value={modelConfig.providerId || ''} onValueChange={(v) => onModelConfigChange({ ...modelConfig, providerId: v })}>
                <SelectTrigger><SelectValue placeholder="Select provider" /></SelectTrigger>
                <SelectContent>
                  {providers.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name} ({p.type})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Model</Label>
              <Input value={modelConfig.model || ''} onChange={(e) => onModelConfigChange({ ...modelConfig, model: e.target.value })}
                placeholder="e.g. gpt-4o, claude-sonnet-4-20250514" />
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Temperature</Label>
              <Input type="number" min={0} max={2} step={0.1} value={modelConfig.temperature ?? 0.7}
                onChange={(e) => onModelConfigChange({ ...modelConfig, temperature: parseFloat(e.target.value) })} />
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Max Tokens</Label>
              <Input type="number" min={1} max={200000} value={modelConfig.maxTokens ?? 4096}
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
            <div><p className="text-sm font-medium">Enable Memory</p><p className="text-xs text-muted-foreground">Agent will recall relevant memories before each LLM call</p></div>
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
        <CardHeader><CardTitle className="text-base">Agent Capabilities</CardTitle></CardHeader>
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

      {/* Collaboration */}
      <Card>
        <CardHeader><CardTitle className="text-base">Collaboration</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={collaboration.enabled}
              onChange={(e) => onCollaborationChange({ ...collaboration, enabled: e.target.checked })} className="rounded" />
            <div><p className="text-sm font-medium">Enable Multi-Agent Collaboration</p><p className="text-xs text-muted-foreground">Multiple agents work together on each request</p></div>
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
                <Label className="text-sm">Interval (minutes)</Label>
                <Input type="number" min={1} value={heartbeat.intervalMinutes}
                  onChange={(e) => onHeartbeatChange({ ...heartbeat, intervalMinutes: parseInt(e.target.value) || 60 })} />
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Heartbeat Prompt</Label>
                <Textarea value={heartbeat.prompt} onChange={(e) => onHeartbeatChange({ ...heartbeat, prompt: e.target.value })}
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
            <div className="flex items-center gap-2 p-2 cursor-pointer hover:bg-muted/50 select-none" onClick={toggleGroup}>
              {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              <span className="text-sm font-medium flex-1">{groupName}</span>
              <span className="text-xs text-muted-foreground">{groupTools.length} tool{groupTools.length !== 1 ? 's' : ''}{selectedInGroup > 0 ? `, ${selectedInGroup} selected` : ''}</span>
              <Button type="button" variant="ghost" size="sm" className="h-6 text-xs px-2"
                onClick={(e) => { e.stopPropagation(); allSelectedInGroup ? deselectAll() : selectAll() }}>
                {allSelectedInGroup ? 'Deselect All' : 'Select All'}
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

function CollaborationConfig({ agentId, collaboration, onChange, availableAgents }: {
  agentId?: string
  collaboration: AutonomousConfigProps['collaboration']
  onChange: (v: AutonomousConfigProps['collaboration']) => void
  availableAgents: any[]
}) {
  return (
    <div className="space-y-4 pt-2">
      <div className="space-y-2">
        <Label className="text-sm">Strategy</Label>
        <Select value={collaboration.strategy} onValueChange={(v: any) => onChange({ ...collaboration, strategy: v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="sequential">Sequential — agents run one after another, piping output to input</SelectItem>
            <SelectItem value="parallel">Parallel — all agents run simultaneously, results merged</SelectItem>
            <SelectItem value="race">Race — all agents run, first to finish wins</SelectItem>
            <SelectItem value="debate">Debate — agents discuss in rounds, judge synthesizes</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-sm">Participating Agents</Label>
        <div className="space-y-2 max-h-[200px] overflow-y-auto">
          {availableAgents.filter((a: any) => a.id !== agentId).map((agent: any) => {
            const isSelected = collaboration.agents.some(a => a.agentId === agent.id)
            const agentEntry = collaboration.agents.find(a => a.agentId === agent.id)
            return (
              <div key={agent.id} className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50">
                <label className="flex items-center gap-3 cursor-pointer flex-1 min-w-0">
                  <input type="checkbox" checked={isSelected}
                    onChange={(e) => {
                      if (e.target.checked) onChange({ ...collaboration, agents: [...collaboration.agents, { agentId: agent.id }] })
                      else onChange({ ...collaboration, agents: collaboration.agents.filter(a => a.agentId !== agent.id) })
                    }} className="rounded" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{agent.name}</p>
                    {agent.description && <p className="text-xs text-muted-foreground truncate">{agent.description}</p>}
                  </div>
                </label>
                {isSelected && (
                  <Input placeholder="Role..." value={agentEntry?.role || ''}
                    onChange={(e) => onChange({ ...collaboration, agents: collaboration.agents.map(a => a.agentId === agent.id ? { ...a, role: e.target.value } : a) })}
                    className="w-32 h-7 text-xs flex-shrink-0" />
                )}
              </div>
            )
          })}
          {availableAgents.filter((a: any) => a.id !== agentId).length === 0 && (
            <p className="text-sm text-muted-foreground py-2 text-center">No other agents available.</p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-sm">Shared Brief</Label>
        <Textarea placeholder="Context shared with all participating agents..." value={collaboration.sharedBrief || ''}
          onChange={(e) => onChange({ ...collaboration, sharedBrief: e.target.value })} rows={2} />
      </div>

      <div className="space-y-3 border-t pt-3">
        <Label className="text-sm font-medium">Rules of Engagement</Label>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Max Total Cost ($)</Label>
            <Input type="number" min={0} step={0.01} placeholder="No limit" value={collaboration.rules?.maxTotalCost ?? ''}
              onChange={(e) => onChange({ ...collaboration, rules: { ...collaboration.rules, maxTotalCost: e.target.value ? parseFloat(e.target.value) : undefined } })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Max Chain Depth</Label>
            <Input type="number" min={1} max={10} placeholder="No limit" value={collaboration.rules?.maxChainDepth ?? ''}
              onChange={(e) => onChange({ ...collaboration, rules: { ...collaboration.rules, maxChainDepth: e.target.value ? parseInt(e.target.value) : undefined } })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Output Format</Label>
            <Select value={collaboration.rules?.outputFormat || ''} onValueChange={(v: any) => onChange({ ...collaboration, rules: { ...collaboration.rules, outputFormat: v || undefined } })}>
              <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent><SelectItem value="text">Text</SelectItem><SelectItem value="json">JSON</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Escalation</Label>
            <Select value={collaboration.rules?.escalation || ''} onValueChange={(v: any) => onChange({ ...collaboration, rules: { ...collaboration.rules, escalation: v || undefined } })}>
              <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent><SelectItem value="never">Never</SelectItem><SelectItem value="on_failure">On Failure</SelectItem><SelectItem value="on_low_confidence">On Low Confidence</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
        {collaboration.strategy === 'parallel' && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Conflict Resolution</Label>
            <Select value={collaboration.rules?.conflictResolution || ''} onValueChange={(v: any) => onChange({ ...collaboration, rules: { ...collaboration.rules, conflictResolution: v || undefined } })}>
              <SelectTrigger><SelectValue placeholder="Default" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="judge">Judge decides</SelectItem><SelectItem value="majority">Majority wins</SelectItem>
                <SelectItem value="first_wins">First wins</SelectItem><SelectItem value="merge">Merge all</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={collaboration.rules?.sharedMemoryScope ?? false}
              onChange={(e) => onChange({ ...collaboration, rules: { ...collaboration.rules, sharedMemoryScope: e.target.checked } })} className="rounded" />
            <span className="text-xs">Shared Memory</span>
          </label>
          {collaboration.strategy === 'sequential' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={collaboration.rules?.allowRevision ?? false}
                onChange={(e) => onChange({ ...collaboration, rules: { ...collaboration.rules, allowRevision: e.target.checked } })} className="rounded" />
              <span className="text-xs">Allow Revision</span>
            </label>
          )}
        </div>
      </div>

      {(collaboration.strategy === 'debate' || collaboration.strategy === 'parallel') && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-sm">Judge Agent</Label>
            <Select value={collaboration.judgeAgentId || ''} onValueChange={(v) => onChange({ ...collaboration, judgeAgentId: v })}>
              <SelectTrigger><SelectValue placeholder="Select judge" /></SelectTrigger>
              <SelectContent>{availableAgents.map((a: any) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {collaboration.strategy === 'debate' && (
            <div className="space-y-2">
              <Label className="text-sm">Max Rounds</Label>
              <Input type="number" min={1} max={10} value={collaboration.maxRounds ?? 3}
                onChange={(e) => onChange({ ...collaboration, maxRounds: parseInt(e.target.value) })} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
