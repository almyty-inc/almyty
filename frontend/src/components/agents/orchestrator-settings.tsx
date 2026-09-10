import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

/**
 * Orchestrator settings.
 *
 * It is off by default and the product works without it, so this surface
 * leads with the switch and says plainly what happens when the
 * orchestrator does not answer. A setting whose failure mode is invisible
 * is a setting people turn on and then cannot debug.
 *
 * See docs/design/layers.md, L6.
 */
export interface OrchestratorConfigView {
  enabled: boolean
  roleKey: string
  timeoutMs: number
  fallbackStrategyKey: string
  allowedStrategyKeys?: string[]
}

export interface OrchestratorSettingsProps {
  config: OrchestratorConfigView
  strategyKeys: string[]
  roleKeys: string[]
  onChange: (next: OrchestratorConfigView) => void
  disabled?: boolean
}

export function OrchestratorSettings({ config, strategyKeys, roleKeys, onChange, disabled }: OrchestratorSettingsProps) {
  const set = <K extends keyof OrchestratorConfigView>(key: K, value: OrchestratorConfigView[K]) =>
    onChange({ ...config, [key]: value })

  return (
    <div data-testid="orchestrator-settings" className="space-y-4">
      <div className="flex items-start justify-between gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
        <div>
          <Label htmlFor="orchestrator-enabled" className="text-sm font-medium">
            Let a model choose the strategy
          </Label>
          <p className="mt-1 text-xs text-muted-foreground">
            Off by default. With it off, every run uses the strategy you picked, and nothing else changes.
          </p>
        </div>
        <Switch
          id="orchestrator-enabled"
          checked={config.enabled}
          disabled={disabled}
          onCheckedChange={(v) => set('enabled', Boolean(v))}
        />
      </div>

      {config.enabled && (
        <div data-testid="orchestrator-detail" className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <div>
            <Label htmlFor="orchestrator-role">Role that decides</Label>
            <select
              id="orchestrator-role"
              className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm"
              value={config.roleKey}
              disabled={disabled}
              onChange={(e) => set('roleKey', e.target.value)}
            >
              {roleKeys.length === 0 && <option value={config.roleKey}>{config.roleKey}</option>}
              {roleKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              A small, cheap model is the right thing here. The decision costs a call and is counted against the budget.
            </p>
          </div>

          <div>
            <Label htmlFor="orchestrator-timeout">Give up after (ms)</Label>
            <Input
              id="orchestrator-timeout"
              type="number"
              min={100}
              value={config.timeoutMs}
              disabled={disabled}
              onChange={(e) => set('timeoutMs', Number(e.target.value))}
            />
          </div>

          <div>
            <Label htmlFor="orchestrator-fallback">Use this strategy if it does not answer</Label>
            <select
              id="orchestrator-fallback"
              className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-sm"
              value={config.fallbackStrategyKey}
              disabled={disabled}
              onChange={(e) => set('fallbackStrategyKey', e.target.value)}
            >
              {strategyKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            {/* Every failure ends here, so it is worth naming them rather
                than leaving the fallback looking like an edge case. */}
            <p className="mt-1 text-xs text-muted-foreground">
              Used whenever it times out, answers something unusable, or picks a strategy that is not allowed. A run is
              never left without a strategy.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
