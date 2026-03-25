import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Repeat } from 'lucide-react'

export function LoopNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-rose-500 !border-rose-600" />
      <div className="px-3 py-2 bg-gradient-to-r from-rose-50 to-rose-100 dark:from-rose-950 dark:to-rose-900 rounded-t-[10px] border-b flex items-center gap-2">
        <Repeat className="h-3.5 w-3.5 text-rose-700 dark:text-rose-300" />
        <span className="text-xs font-semibold text-rose-700 dark:text-rose-300">Loop</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">
          {data.iterableExpression ? String(data.iterableExpression).substring(0, 30) : 'No iterable set'}
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          Max: {String(data.maxIterations || 100)} iterations
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-rose-500 !border-rose-600" />
    </div>
  )
}
