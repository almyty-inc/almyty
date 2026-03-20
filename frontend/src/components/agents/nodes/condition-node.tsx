import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { GitBranch } from 'lucide-react'

export function ConditionNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-amber-500 !border-amber-600" />
      <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950 rounded-t-[10px] border-b flex items-center gap-2">
        <GitBranch className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300" />
        <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">Condition</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">
          {data.expression ? String(data.expression).substring(0, 30) : 'No expression'}
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-xs text-muted-foreground">True</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-xs text-muted-foreground">False</span>
          </div>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="true"
        className="!w-3 !h-3 !bg-green-500 !border-green-600"
        style={{ top: '40%' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="false"
        className="!w-3 !h-3 !bg-red-500 !border-red-600"
        style={{ top: '70%' }}
      />
    </div>
  )
}
