/**
 * Top toolbar for the agent builder page: back button, agent name input,
 * status badge, workflow/autonomous mode toggle, undo/redo buttons,
 * export, test toggle, and save button.
 */
import React from 'react'
import { ArrowLeft, Save, Loader2, Download, Undo2, Redo2, Play } from 'lucide-react'

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
  canSave: boolean
  validationErrors: string[]
  isSaving: boolean
  onSave: () => void
  onExport: () => void
  onBack: () => void
}

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
  canSave,
  isSaving,
  onSave,
  onExport,
  onBack,
}: BuilderToolbarProps) {
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
          disabled={isSaving || !canSave}
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
