import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot } from 'lucide-react'

export function SubAgentNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-violet-500 !border-violet-600" />
      <div className="px-3 py-2 bg-gradient-to-r from-violet-50 to-violet-100 dark:from-violet-950 dark:to-violet-900 rounded-t-[10px] border-b flex items-center gap-2">
        <Bot className="h-3.5 w-3.5 text-violet-700 dark:text-violet-300" />
        <span className="text-xs font-semibold text-violet-700 dark:text-violet-300">Sub-Agent</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">{(data.agentName as string) || 'Select agent'}</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {data.agentId ? 'Configured' : 'Not configured'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-violet-500 !border-violet-600" />
    </div>
  )
}
