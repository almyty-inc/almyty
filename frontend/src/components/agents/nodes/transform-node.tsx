import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Shuffle } from 'lucide-react'

export function TransformNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-gray-500 !border-gray-600" />
      <div className="px-3 py-2 bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 rounded-t-[10px] border-b flex items-center gap-2">
        <Shuffle className="h-3.5 w-3.5 text-gray-700 dark:text-gray-300" />
        <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">Transform</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">Data Transform</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {data.expression ? String(data.expression).substring(0, 40) + '...' : 'No expression'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-gray-500 !border-gray-600" />
    </div>
  )
}
