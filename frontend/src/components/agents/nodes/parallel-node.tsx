import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { GitFork } from 'lucide-react'

export function ParallelNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] ${selected ? 'border-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-orange-500 !border-orange-600" />
      <div className="px-3 py-1.5 bg-orange-50 dark:bg-orange-950 rounded-t-[10px] border-b flex items-center gap-1.5">
        <GitFork className="h-3 w-3 text-orange-700 dark:text-orange-300" />
        <span className="text-xs font-medium text-orange-700 dark:text-orange-300">Parallel</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">Fan Out</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          Execute branches in parallel
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="branch-1"
        className="!w-3 !h-3 !bg-orange-500 !border-orange-600"
        style={{ top: '35%' }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="branch-2"
        className="!w-3 !h-3 !bg-orange-500 !border-orange-600"
        style={{ top: '65%' }}
      />
    </div>
  )
}
