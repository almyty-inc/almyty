import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Wrench } from 'lucide-react'

export function ToolCallNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-purple-500 !border-purple-600" />
      <div className="px-3 py-2 bg-gradient-to-r from-purple-50 to-purple-100 dark:from-purple-950 dark:to-purple-900 rounded-t-[10px] border-b flex items-center gap-2">
        <Wrench className="h-3.5 w-3.5 text-purple-700 dark:text-purple-300" />
        <span className="text-xs font-semibold text-purple-700 dark:text-purple-300">Tool Call</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">{(data.toolName as string) || (data.label as string) || 'Select tool'}</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {data.toolId ? 'Configured' : 'Not configured'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-purple-500 !border-purple-600" />
    </div>
  )
}
