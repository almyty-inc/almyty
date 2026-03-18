import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Brain } from 'lucide-react'

export function LlmCallNode({ data, selected }: NodeProps) {
  return (
    <div className={`rounded-xl border-2 bg-card shadow-sm w-[220px] ${selected ? 'border-primary' : 'border-border'}`}>
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-blue-500 !border-blue-600" />
      <div className="px-3 py-1.5 bg-blue-50 dark:bg-blue-950 rounded-t-[10px] border-b flex items-center gap-1.5">
        <Brain className="h-3 w-3 text-blue-700 dark:text-blue-300" />
        <span className="text-xs font-medium text-blue-700 dark:text-blue-300">LLM Call</span>
      </div>
      <div className="p-3">
        <div className="text-sm font-medium truncate">{(data.model as string) || 'Select model'}</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">
          {data.systemPrompt ? String(data.systemPrompt).substring(0, 40) + '...' : 'No system prompt'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-blue-500 !border-blue-600" />
    </div>
  )
}
