import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Combine } from 'lucide-react'

export function MergeNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] ${selected ? 'border-primary' : 'border-border'}`}>
      <Handle
        type="target"
        position={Position.Left}
        id="input-1"
        className="!w-3 !h-3 !bg-teal-500 !border-teal-600"
        style={{ top: '35%' }}
      />
      <Handle
        type="target"
        position={Position.Left}
        id="input-2"
        className="!w-3 !h-3 !bg-teal-500 !border-teal-600"
        style={{ top: '65%' }}
      />
      <div className="px-3 py-1.5 bg-teal-50 dark:bg-teal-950 rounded-t-[10px] border-b flex items-center gap-1.5">
        <Combine className="h-3 w-3 text-teal-700 dark:text-teal-300" />
        <span className="text-xs font-medium text-teal-700 dark:text-teal-300">Merge</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">Merge Results</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          Strategy: {(data.strategy as string) || 'first_response'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-teal-500 !border-teal-600" />
    </div>
  )
}
