import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { LogIn } from 'lucide-react'

export function InputNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <div className="px-3 py-2 bg-green-50 dark:bg-green-950 rounded-t-[10px] border-b flex items-center gap-2">
        <LogIn className="h-3.5 w-3.5 text-green-700 dark:text-green-300" />
        <span className="text-xs font-semibold text-green-700 dark:text-green-300">Input</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">Pipeline Input</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {data.schema ? `${Object.keys((data.schema as any)?.properties || {}).length} fields` : 'No schema defined'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-green-500 !border-green-600" />
    </div>
  )
}
