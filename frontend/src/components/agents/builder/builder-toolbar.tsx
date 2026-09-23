/**
 * Top toolbar for the agent builder page: back button, agent name input,
 * status badge, workflow/autonomous mode toggle, undo/redo buttons,
 * export, test toggle, and save button.
 */
import React from 'react'
import { ArrowLeft, Save, Loader2, Download, Undo2, Redo2, Play, Lock, Users, Globe } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface BuilderToolbarProps {
  agentName: string
  onAgentNameChange: (name: string) => void
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
}

const VISIBILITY_LABEL = {
  private: { label: 'Private', Icon: Lock },
  team: { label: 'Team', Icon: Users },
  org: { label: 'Org-wide', Icon: Globe },
} as const

export function BuilderToolbar({
  agentName,
  onAgentNameChange,
  agentStatus,
  agentMode,
  onAgentModeChange,
  canUndo,
  canRedo,
  undo,
  redo,
  isEditing,
  agentVersion,
  showTestPanel,
  onToggleTestPanel,
  saveDisabled,
  isSaving,
  onSave,
  onExport,
  onBack,
  visibility,
  visibilityOpen,
  onVisibilityClick,
}: BuilderToolbarProps) {
  const scope = visibility ? VISIBILITY_LABEL[visibility] : null
  return (
    <div className="flex items-center justify-between px-2 sm:px-4 py-2 border-b bg-background shrink-0 sticky top-0 z-30">
      <div className="flex items-center gap-1 sm:gap-3 min-w-0">
        <Button variant="ghost" size="icon" className="shrink-0" aria-label="Back to agents" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Input
          className="text-base sm:text-lg font-semibold border-none shadow-none focus-visible:ring-0 w-[140px] sm:w-[260px] px-1"
          value={agentName}
          onChange={(e) => onAgentNameChange(e.target.value)}
          placeholder="Agent name"
        />
        <Badge variant={agentStatus === 'active' ? 'success' : agentStatus === 'error' ? 'destructive' : 'outline'} className="hidden sm:inline-flex">
          {agentStatus}
        </Badge>
        <div className="hidden sm:flex items-center gap-1 ml-2 bg-muted rounded-md p-0.5">
          <button
            className={cn('px-2 py-1 text-xs rounded font-medium transition-colors', agentMode === 'workflow' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground')}
            onClick={() => onAgentModeChange('workflow')}
          >
            Workflow
          </button>
          <button
            className={cn('px-2 py-1 text-xs rounded font-medium transition-colors', agentMode === 'autonomous' ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground')}
            onClick={() => onAgentModeChange('autonomous')}
          >
            Autonomous
          </button>
        </div>
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
      <div className="flex items-center gap-1 sm:gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
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
          className="h-8 w-8"
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
        {isEditing && (
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleTestPanel}
          >
            <Play className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Test</span>
          </Button>
        )}
        <Button
          size="sm"
          onClick={onSave}
          disabled={isSaving || saveDisabled}
          title={saveDisabled ? 'Finish the steps listed above to save' : undefined}
        >
          {isSaving ? (
            <Loader2 className="h-4 w-4 sm:mr-2 animate-spin" />
          ) : (
            <Save className="h-4 w-4 sm:mr-2" />
          )}
          <span className="hidden sm:inline">Save</span>
        </Button>
      </div>
    </div>
  )
}
