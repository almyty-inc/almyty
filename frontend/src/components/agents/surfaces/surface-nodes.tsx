import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { AlertTriangle, Bot, Lock, ShieldCheck } from 'lucide-react'

import { interfaceTypeIcons } from '@/components/agents/detail/constants'
import { cn } from '@/lib/utils'
import type { SurfaceCategory } from './surface-types'

/**
 * The agent sits at the centre of the canvas and every surface connects
 * back to it. One agent, N surfaces, one publish action.
 */
export function AgentHubNode({ data }: NodeProps) {
  return (
    <div className="rounded-2xl border-2 border-primary bg-card shadow-lg w-[240px]">
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-violet-500 !border-violet-600" />
      <div className="px-4 py-2.5 bg-gradient-to-r from-violet-500 to-cyan-500 rounded-t-[14px] flex items-center gap-2">
        <Bot className="h-4 w-4 text-white" />
        <span className="text-xs font-semibold text-white">Agent</span>
      </div>
      <div className="p-4">
        <div className="text-sm font-medium truncate">{(data.name as string) || 'This agent'}</div>
        <div className="text-xs text-muted-foreground mt-1">
          {(data.surfaceCount as number) === 1
            ? 'Reachable on 1 surface'
            : `Reachable on ${(data.surfaceCount as number) ?? 0} surfaces`}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-cyan-500 !border-cyan-600" />
    </div>
  )
}

const CATEGORY_ACCENT: Record<SurfaceCategory, string> = {
  protocol: 'from-violet-50 to-violet-100 dark:from-violet-950 dark:to-violet-900 text-violet-700 dark:text-violet-300',
  messaging: 'from-cyan-50 to-cyan-100 dark:from-cyan-950 dark:to-cyan-900 text-cyan-700 dark:text-cyan-300',
  human: 'from-emerald-50 to-emerald-100 dark:from-emerald-950 dark:to-emerald-900 text-emerald-700 dark:text-emerald-300',
}

const CATEGORY_HANDLE: Record<SurfaceCategory, string> = {
  protocol: '!bg-violet-500 !border-violet-600',
  messaging: '!bg-cyan-500 !border-cyan-600',
  human: '!bg-emerald-500 !border-emerald-600',
}

/**
 * A published (or about-to-be-published) surface.
 *
 * Three states, and the distinction matters:
 *  - unavailable: greyed, with the catalog's one-line reason. Not a
 *    failure the operator can fix, so there is nothing to click.
 *  - unverified: live, but inbound authentication cannot run as
 *    configured, which means the platform's messages will be REFUSED.
 *    Shown as a warning because it is fixable, and fixable here.
 *  - verified: publishable.
 */
export function SurfaceNode({ data, selected }: NodeProps) {
  const category = (data.category as SurfaceCategory) ?? 'messaging'
  const available = data.available !== false
  const verified = data.verified !== false
  const unavailableReason = data.unavailableReason as string | null
  const warning = data.warning as string | null

  return (
    <div
      className={cn(
        'rounded-xl border-2 bg-card shadow-sm w-[230px] transition-shadow',
        available ? 'hover:shadow-md' : 'opacity-60',
        selected ? 'border-primary ring-2 ring-primary' : 'border-border',
        !available && 'border-dashed',
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={cn('!w-3 !h-3', CATEGORY_HANDLE[category])}
      />
      <div
        className={cn(
          'px-3 py-2 bg-gradient-to-r rounded-t-[10px] border-b flex items-center gap-2',
          CATEGORY_ACCENT[category],
        )}
      >
        <span aria-hidden className="text-sm leading-none">
          {interfaceTypeIcons[data.surfaceType as string] ?? '🔗'}
        </span>
        <span className="text-xs font-semibold truncate">{data.label as string}</span>
        {data.edition === 'ee' && (
          <span
            title="Requires a commercial licence"
            className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium"
          >
            <Lock className="h-3 w-3" />
            EE
          </span>
        )}
      </div>

      <div className="p-3 space-y-1.5">
        <div className="text-sm font-medium truncate">
          {(data.name as string) || 'Not published yet'}
        </div>

        {!available && unavailableReason && (
          <p className="text-xs text-muted-foreground leading-snug">{unavailableReason}</p>
        )}

        {available && !verified && warning && (
          <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400 leading-snug">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
            <span>{warning}</span>
          </p>
        )}

        {available && verified && Boolean(data.name) && (
          <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            <span>Inbound verified</span>
          </p>
        )}
      </div>
    </div>
  )
}

export const surfaceNodeTypes = {
  agentHub: AgentHubNode,
  surface: SurfaceNode,
}
