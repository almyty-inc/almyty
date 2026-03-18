import React from 'react'
import {
  LogIn,
  LogOut,
  Brain,
  Wrench,
  GitBranch,
  Shuffle,
  Combine,
  GitFork,
  Bot,
} from 'lucide-react'
import { NODE_TYPE_CONFIG, type PipelineNodeType } from './nodes'

const ICONS: Record<PipelineNodeType, React.ElementType> = {
  input: LogIn,
  output: LogOut,
  llm_call: Brain,
  tool_call: Wrench,
  condition: GitBranch,
  transform: Shuffle,
  merge: Combine,
  parallel: GitFork,
  sub_agent: Bot,
}

const NODE_ORDER: PipelineNodeType[] = [
  'input',
  'llm_call',
  'tool_call',
  'condition',
  'transform',
  'merge',
  'parallel',
  'sub_agent',
  'output',
]

export function NodePalette() {
  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className="w-[200px] border-r bg-muted/30 p-3 overflow-y-auto">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        Node Types
      </h3>
      <div className="space-y-1">
        {NODE_ORDER.map((type) => {
          const config = NODE_TYPE_CONFIG[type]
          const Icon = ICONS[type]
          return (
            <div
              key={type}
              draggable
              onDragStart={(e) => onDragStart(e, type)}
              className="flex items-center gap-2 p-2 rounded-lg border bg-card cursor-grab hover:bg-accent/50 active:cursor-grabbing transition-colors"
            >
              <div className={`w-2 h-2 rounded-full ${config.color} shrink-0`} />
              <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium leading-tight">{config.label}</div>
                <div className="text-[10px] text-muted-foreground leading-tight truncate">
                  {config.description}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
