import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { FileSearch } from 'lucide-react'

/**
 * One call that compresses what the incoming steps learned into a small
 * structured brief, which later steps read instead of every transcript.
 *
 * Registered here for the same reason as Verify: `explore_extract_patch`
 * compiles to one, and an ejected graph containing an unregistered type
 * shows the user an empty canvas slot.
 */
export function ExtractContextNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-sky-500 !border-sky-600" />
      <div className="px-3 py-2 bg-gradient-to-r from-sky-50 to-sky-100 dark:from-sky-950 dark:to-sky-900 rounded-t-[10px] border-b flex items-center gap-2">
        <FileSearch className="h-3.5 w-3.5 text-sky-700 dark:text-sky-300" />
        <span className="text-xs font-semibold text-sky-700 dark:text-sky-300">Extract Context</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">
          {(data.roleKey as string)
            ? `Role: ${data.roleKey as string}`
            : data.routing && typeof data.routing === 'object'
              ? `Routed: ${((data.routing as { objective?: string }).objective) || 'cheapest'}`
              : (data.model as string) || 'Select model'}
        </div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {(data.task as string) || 'Brief from the incoming steps'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-sky-500 !border-sky-600" />
    </div>
  )
}
