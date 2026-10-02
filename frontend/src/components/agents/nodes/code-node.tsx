import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Code2 } from 'lucide-react'

/** A Code step: a short script over the agent's tools (code mode). */
export function CodeNode({ data, selected }: NodeProps) {
  const firstLine = typeof data.code === 'string' ? data.code.split('\n').find((l: string) => l.trim()) ?? '' : ''
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-indigo-500 !border-indigo-600" />
      <div className="px-3 py-2 bg-gradient-to-r from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-800 rounded-t-[10px] border-b flex items-center gap-2">
        <Code2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-foreground">Code</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">{(data.label as string) || 'Run a script'}</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5 font-mono">{firstLine ? firstLine.trim() : 'No script yet'}</div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-indigo-500 !border-indigo-600" />
    </div>
  )
}
