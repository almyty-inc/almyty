import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { ShieldCheck } from 'lucide-react'

/**
 * A refute-only checker panel.
 *
 * Every built-in strategy that checks its own work compiles to one of
 * these, so an ejected `cascade` or `explore_extract_patch` graph put an
 * unregistered node type into the canvas: React Flow rendered nothing and
 * the step could not be read, let alone edited.
 */
export function VerifyNode({ data, selected }: NodeProps) {
  const checkers = Array.isArray(data.checkers) ? (data.checkers as Array<Record<string, unknown>>) : []
  const named = checkers
    .map((c) => (c?.name as string) || (c?.roleKey as string) || '')
    .filter(Boolean)
    .join(', ')

  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] hover:shadow-md transition-shadow ${selected ? 'border-primary ring-2 ring-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-emerald-500 !border-emerald-600" />
      <div className="px-3 py-2 bg-gradient-to-r from-emerald-50 to-emerald-100 dark:from-emerald-950 dark:to-emerald-900 rounded-t-[10px] border-b flex items-center gap-2">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" />
        <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Verify</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">
          {checkers.length === 0
            ? 'No checkers'
            : `${checkers.length} checker${checkers.length === 1 ? '' : 's'}${named ? `: ${named}` : ''}`}
        </div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          Policy: {(data.policy as string) || 'any_fail_blocks'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-emerald-500 !border-emerald-600" />
    </div>
  )
}
