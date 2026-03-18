import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot } from 'lucide-react'

export function SubAgentNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] ${selected ? 'border-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-indigo-500 !border-indigo-600" />
      <div className="px-3 py-1.5 bg-indigo-50 dark:bg-indigo-950 rounded-t-[10px] border-b flex items-center gap-1.5">
        <Bot className="h-3 w-3 text-indigo-700 dark:text-indigo-300" />
        <span className="text-xs font-medium text-indigo-700 dark:text-indigo-300">Sub-Agent</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">{(data.agentName as string) || 'Select agent'}</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {data.agentId ? 'Configured' : 'Not configured'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-indigo-500 !border-indigo-600" />
    </div>
  )
}
