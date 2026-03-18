import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Wrench } from 'lucide-react'

export function ToolCallNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] ${selected ? 'border-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-purple-500 !border-purple-600" />
      <div className="px-3 py-1.5 bg-purple-50 dark:bg-purple-950 rounded-t-[10px] border-b flex items-center gap-1.5">
        <Wrench className="h-3 w-3 text-purple-700 dark:text-purple-300" />
        <span className="text-xs font-medium text-purple-700 dark:text-purple-300">Tool Call</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">{(data.toolName as string) || 'Select tool'}</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {data.toolId ? 'Configured' : 'Not configured'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-purple-500 !border-purple-600" />
    </div>
  )
}
