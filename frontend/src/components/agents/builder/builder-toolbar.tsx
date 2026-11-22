/**
 * Top toolbar for the agent builder page: back button, agent name input,
 * status badge, workflow/autonomous mode toggle, undo/redo buttons,
 * export, test toggle, and save button.
 */
import React from 'react'
import { ArrowLeft, Save, Loader2, Download, Undo2, Redo2, Play, Lock, Users, Globe, Settings2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** What the empty name field shows until the agent is named. */
export const AGENT_NAME_PLACEHOLDER = 'Name your agent'

export interface BuilderToolbarProps {
  agentName: string
  onAgentNameChange: (name: string) => void
  /** Why the name was refused (another agent here has it), shown beside it. */
  nameError?: string | null
  agentStatus: string
  agentMode: 'workflow' | 'autonomous'
  onAgentModeChange: (mode: 'workflow' | 'autonomous') => void
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
  isEditing: boolean
  id?: string
  /** Display version string, e.g. "1.0.0". Shown only when editing. */
  agentVersion?: string
  showTestPanel: boolean
  onToggleTestPanel: () => void
  /**
   * Whether Save is greyed out. Not the same as "the agent is invalid": an
   * untouched new draft is invalid and Save is still live, because pressing
   * it is how the user asks what is left. The page only greys the button
   * once the answer is already on screen.
   */
  saveDisabled: boolean
  isSaving: boolean
  onSave: () => void
  onExport: () => void
  onBack: () => void
  /**
   * Who can see and use the agent. When given, the toolbar shows the
   * current scope as a button that opens the visibility picker inline
   * under the toolbar (the page owns that panel).
   */
  visibility?: 'private' | 'team' | 'org'
  visibilityOpen?: boolean
  onVisibilityClick?: () => void
  /**
   * The agent's own settings (run limits), opened inline under the
   * toolbar. Given only for a workflow agent: the autonomous page shows
   * the same cards in its body.
   */
  settingsOpen?: boolean
  onSettingsClick?: () => void
}

const VISIBILITY_LABEL = {
  private: { label: 'Only you', Icon: Lock },
  team: { label: 'One team', Icon: Users },
  org: { label: 'Everyone', Icon: Globe },
} as const

/** One segment of the Workflow/Autonomous control, as the shared segmented tabs draw it. */
const MODE_SEGMENT = 'flex-1 sm:flex-none h-8 rounded-md px-3 text-sm font-semibold transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const MODE_SEGMENT_ON = 'bg-card text-foreground shadow-sm'
const MODE_SEGMENT_OFF = 'text-muted-foreground hover:text-foreground'

export function BuilderToolbar({
  agentName,
  onAgentNameChange,
  nameError,
  agentStatus,
  agentMode,
  onAgentModeChange,
  canUndo,
  canRedo,
  undo,
  redo,
  isEditing,
  agentVersion,
  onToggleTestPanel,
  saveDisabled,
  isSaving,
  onSave,
  onExport,
  onBack,
  visibility,
  visibilityOpen,
  onVisibilityClick,
  settingsOpen,
  onSettingsClick,
}: BuilderToolbarProps) {
  const scope = visibility ? VISIBILITY_LABEL[visibility] : null
  return (
    <div className="flex flex-wrap items-center gap-y-2 px-2 sm:px-4 py-2 border-b bg-background shrink-0 sticky top-0 z-30">
      <div className="flex items-center gap-1 sm:gap-2 min-w-0 mr-auto">
        <Button variant="ghost" size="icon" className="shrink-0" aria-label="Back to agents" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Input
          // Sized to the name (within bounds) so the status and visibility
          // sit next to it instead of after a fixed 260px gap. It reads as
          // the page title, and still shows a field outline on hover and a
          // focus ring, so it is visibly editable.
          className={cn(
            'h-10 min-w-[8ch] max-w-[160px] border-transparent bg-transparent px-2 font-heading text-lg font-bold tracking-[-0.02em] shadow-none hover:border-input hover:bg-transparent sm:max-w-[360px] sm:text-xl',
            nameError && 'text-destructive',
          )}
          style={{ width: `${Math.max(8, (agentName || AGENT_NAME_PLACEHOLDER).length + 2)}ch` }}
          value={agentName}
          onChange={(e) => onAgentNameChange(e.target.value)}
          // A new agent starts with an empty name. It used to start as the
          // value "New agent", and typing in as the page opened added to it
          // ("Morning weather briefNew agent" was saved). A placeholder is
          // never part of what is typed.
          placeholder={AGENT_NAME_PLACEHOLDER}
          aria-label="Agent name"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? 'agent-name-error' : undefined}
        />
        {nameError && (
          <span id="agent-name-error" role="alert" className="text-xs text-destructive max-w-[220px] sm:max-w-[320px]">
            {nameError}
          </span>
        )}
        <Badge variant={agentStatus === 'active' ? 'success' : agentStatus === 'error' ? 'destructive' : 'outline'} className="hidden sm:inline-flex">
          {agentStatus ? agentStatus.charAt(0).toUpperCase() + agentStatus.slice(1) : agentStatus}
        </Badge>
        {scope && onVisibilityClick && (
          <Button
            variant="outline"
            size="sm"
            className="ml-1 sm:ml-2 shrink-0"
            onClick={onVisibilityClick}
            aria-expanded={!!visibilityOpen}
            aria-controls="agent-visibility-panel"
            title="Who can see and use this agent"
            aria-label={`Visibility: ${scope.label}`}
          >
            <scope.Icon className="h-4 w-4 sm:mr-2" aria-hidden="true" />
            <span className="hidden sm:inline">{scope.label}</span>
          </Button>
        )}
      </div>
      {/*
        The mode toggle is the only way to make an autonomous agent, so it
        is never hidden. It sits beside the name from sm up; on a phone the
        row wraps and it goes last, growing to fill the space beside the
        undo/redo/save buttons (or a row of its own when they fit above).
      */}
      <div
        role="group"
        aria-label="Agent mode"
        data-testid="agent-mode-toggle"
        // min-w-fit, not a fixed 10rem: the two words need more than 10rem,
        // so at 390px the toggle stayed beside the buttons and "Autonomous"
        // ran off the screen. At its real width it wraps to a row of its own.
        className="order-last flex min-w-fit flex-1 items-center gap-1 rounded-lg bg-muted p-1 sm:order-none sm:mr-2 sm:min-w-0 sm:flex-none"
      >
        {/* The segmented control's look: the picked mode sits on the card surface. */}
        <button
          type="button"
          aria-pressed={agentMode === 'workflow'}
          className={cn(MODE_SEGMENT, agentMode === 'workflow' ? MODE_SEGMENT_ON : MODE_SEGMENT_OFF)}
          onClick={() => onAgentModeChange('workflow')}
        >
          Workflow
        </button>
        <button
          type="button"
          aria-pressed={agentMode === 'autonomous'}
          className={cn(MODE_SEGMENT, agentMode === 'autonomous' ? MODE_SEGMENT_ON : MODE_SEGMENT_OFF)}
          onClick={() => onAgentModeChange('autonomous')}
        >
          Autonomous
        </button>
      </div>
      <div className="flex items-center gap-1 sm:gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 className="h-4 w-4" />
        </Button>
        {isEditing && (
          <Button
            variant="outline"
            size="sm"
            className="hidden sm:flex"
            onClick={onExport}
          >
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        )}
        {isEditing && agentVersion && (
          <Badge variant="outline" className="text-xs hidden sm:inline-flex">
            v{agentVersion}
          </Badge>
        )}
        {onSettingsClick && (
          <Button
            variant="outline"
            size="sm"
            onClick={onSettingsClick}
            aria-expanded={!!settingsOpen}
            aria-controls="agent-settings-panel"
            aria-label="Agent settings"
            title="Settings for the whole agent, such as its run limits"
          >
            <Settings2 className="h-4 w-4 sm:mr-2" aria-hidden="true" />
            <span className="hidden sm:inline">Settings</span>
          </Button>
        )}
        {/* On a phone these two show their icon only: the name stays on the
            button through aria-label, or it would be read as nothing. */}
        {isEditing && (
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleTestPanel}
            aria-label="Test"
          >
            <Play className="h-4 w-4 sm:mr-2" aria-hidden="true" />
            <span className="hidden sm:inline">Test</span>
          </Button>
        )}
        <Button
          size="sm"
          onClick={onSave}
          disabled={isSaving || saveDisabled}
          aria-label="Save"
          title={saveDisabled ? 'Finish the steps listed above to save' : undefined}
        >
          {isSaving ? (
            <Loader2 className="h-4 w-4 sm:mr-2 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="h-4 w-4 sm:mr-2" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">Save</span>
        </Button>
      </div>
    </div>
  )
}
