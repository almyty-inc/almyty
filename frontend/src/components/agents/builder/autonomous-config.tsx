/**
 * AutonomousConfig: the configuration sections of an autonomous agent.
 *
 * In order: Personality & style, Instructions, Work mode (the mode first,
 * then the model slots it needs), the verifier panel when there is one,
 * Memory, Capabilities, Run limits and Heartbeat. All state is owned by
 * the parent (AgentBuilderPage) and threaded via props.
 */
import { Link } from 'react-router-dom'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { VerifierPanelList } from '@/components/agents/verifier-panel'
import { RunLimitsSection, useOrgRunLimits, type RunLimitsConfig } from '@/components/agents/builder/run-limits-section'
import { WorkModeSection } from '@/components/agents/builder/work-mode-section'
import { MemorySection } from '@/components/agents/builder/memory-section'
import { CapabilitiesSection } from '@/components/agents/builder/capabilities-section'
import type { AgentMemoryConfig, AgentModels } from '@/types/agent-models'
import type { Agent } from '@/types'

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
  memoryConfig: AgentMemoryConfig
  onMemoryConfigChange: (v: AgentMemoryConfig) => void
  agentConfig: Omit<NonNullable<Agent['agentConfig']>, 'runnerLabels'> & {
    /** Machine label requirements: typed as `gpu=yes, os=mac`, stored by the server as an object. */
    runnerLabels?: Record<string, string> | string
    runLimits?: RunLimitsConfig
  }
  onAgentConfigChange: (v: AutonomousConfigProps['agentConfig']) => void
  /** The organization's agents: the ones it may call, and what a panelist can be. */
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
  const orgRunLimits = useOrgRunLimits()

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 max-w-4xl mx-auto w-full space-y-6">
      <Card>
        <CardHeader><CardTitle className="text-base">Personality & style</CardTitle></CardHeader>
        <CardContent>
          <Textarea value={personality} onChange={(e) => onPersonalityChange(e.target.value)}
            aria-label="Personality and style"
            placeholder="You are a friendly, professional assistant. You never share personal opinions on politics or religion. You always cite your sources."
            className="min-h-[120px] font-mono text-sm" />
          <p className="text-xs text-muted-foreground mt-2">Personality, tone, and boundaries. Defines WHO the agent is.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Instructions</CardTitle></CardHeader>
        <CardContent>
          <Textarea value={instructions} onChange={(e) => onInstructionsChange(e.target.value)}
            aria-label="Instructions"
            placeholder="You are a helpful assistant that..."
            className="min-h-[200px] font-mono text-sm" />
          <p className="text-xs text-muted-foreground mt-2">What the agent should do. Goals, tasks, and workflows.</p>
        </CardContent>
      </Card>

      <WorkModeSection models={models} onChange={onModelsChange} agentId={agentId} availableAgents={availableAgents} />

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

      <MemorySection value={memoryConfig} onChange={onMemoryConfigChange} />

      <CapabilitiesSection
        agentId={agentId}
        toolIds={toolIds}
        onToolIdsChange={onToolIdsChange}
        tools={tools}
        agentConfig={agentConfig}
        onAgentConfigChange={(next) => onAgentConfigChange({ ...agentConfig, ...next })}
        availableAgents={availableAgents}
      />

      {/* Run limits: the ceilings a run cannot exceed. Next to capabilities
          on purpose: what an agent may do and how far it may go are the
          same decision. */}
      <RunLimitsSection
        value={agentConfig.runLimits ?? {}}
        onChange={(runLimits) => onAgentConfigChange({ ...agentConfig, runLimits })}
        inherited={orgRunLimits}
      />

      <Card>
        <CardHeader><CardTitle className="text-base">Heartbeat</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="autonomous-heartbeat" className="text-sm font-medium">Wake up on a schedule</Label>
              <p className="text-xs text-muted-foreground">Agent wakes up periodically to check conditions or process tasks</p>
            </div>
            <Switch id="autonomous-heartbeat" checked={heartbeat.enabled} onCheckedChange={(enabled) => onHeartbeatChange({ ...heartbeat, enabled })} />
          </div>
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
