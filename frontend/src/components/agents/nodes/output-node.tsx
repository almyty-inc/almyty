import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { LogOut } from 'lucide-react'

export function OutputNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-red-500 !border-red-600" />
      <div className="px-3 py-2 bg-red-50 dark:bg-red-950 rounded-t-[10px] border-b flex items-center gap-2">
        <LogOut className="h-3.5 w-3.5 text-red-700 dark:text-red-300" />
        <span className="text-xs font-semibold text-red-700 dark:text-red-300">Output</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">Pipeline Output</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {data.mapping ? String(data.mapping).substring(0, 40) + (String(data.mapping).length > 40 ? '...' : '') : 'No mapping'}
        </div>
      </div>
    </div>
  )
}
