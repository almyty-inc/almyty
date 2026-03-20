import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot } from 'lucide-react'

export function SubAgentNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-indigo-500 !border-indigo-600" />
      <div className="px-3 py-2 bg-gradient-to-r from-indigo-50 to-indigo-100 dark:from-indigo-950 dark:to-indigo-900 rounded-t-[10px] border-b flex items-center gap-2">
        <Bot className="h-3.5 w-3.5 text-indigo-700 dark:text-indigo-300" />
        <span className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">Sub-Agent</span>
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
