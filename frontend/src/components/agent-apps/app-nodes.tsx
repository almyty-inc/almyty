import React from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { AlertTriangle, Bot, Check, HardDrive, Lock, Package, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { AUTH_MODE_LABELS, grantsLocalAccess, type AppAuthMode } from '@/lib/agent-apps'
import { interfaceTypeIcons } from '@/components/agents/detail/constants'

/** The agents that make up the product. */
export function AppAgentsNode({ data }: NodeProps) {
  const empty = data.empty === true
  const names = (data.names as string[]) ?? []

  return (
    <div
      className={cn(
        'w-[240px] rounded-xl border-2 bg-card shadow-sm',
        empty ? 'border-dashed border-amber-400' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2 rounded-t-[10px] border-b bg-gradient-to-r from-violet-50 to-violet-100 px-3 py-2 dark:from-violet-950 dark:to-violet-900">
        <Bot className="h-3.5 w-3.5 text-violet-700 dark:text-violet-300" />
        <span className="text-xs font-semibold text-violet-700 dark:text-violet-300">
          {empty ? 'No agents yet' : `${data.count} agent${data.count === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="space-y-1 p-3">
        {empty ? (
          <p className="text-xs leading-snug text-muted-foreground">
            Add at least one, or there is nothing for a user to talk to.
          </p>
        ) : (
          names.slice(0, 4).map((name) => (
            <div key={name} className="truncate text-sm">
              {name}
            </div>
          ))
        )}
        {names.length > 4 && (
          <div className="text-xs text-muted-foreground">and {names.length - 4} more</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-violet-600 !bg-violet-500" />
    </div>
  )
}

/**
 * The product itself.
 *
 * Carries the two things an operator most needs to see at a glance:
 * who can use it, and whether it can ship. A blocker here is not a
 * warning to read later, it is the reason nothing downstream works.
 */
export function AppProductNode({ data }: NodeProps) {
  const blockers = (data.blockers as Array<{ code: string; message: string }>) ?? []
  const accent = (data.primaryColor as string) || '#8b5cf6'
  const local = grantsLocalAccess(data.capabilities as any)
  const authMode = data.authMode as AppAuthMode

  return (
    <div className="w-[280px] rounded-2xl border-2 border-primary bg-card shadow-lg">
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-violet-600 !bg-violet-500" />
      <div
        className="flex items-center gap-2 rounded-t-[14px] px-4 py-2.5"
        style={{ background: `linear-gradient(90deg, ${accent}, #22d3ee)` }}
      >
        <Package className="h-4 w-4 text-white" />
        <span className="truncate text-xs font-semibold text-white">{data.name as string}</span>
      </div>

      <div className="space-y-2 p-4">
        <code className="block truncate text-xs text-muted-foreground">{data.slug as string}</code>

        <div className="flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
            <Users className="h-3 w-3" />
            {AUTH_MODE_LABELS[authMode] ?? authMode}
          </span>
          {local && (
            // Worth its own badge: this is the setting that decides
            // whether the artifact can touch the machine it runs on.
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
              <HardDrive className="h-3 w-3" />
              Local access
            </span>
          )}
        </div>

        {blockers.length > 0 ? (
          <ul className="space-y-1.5 pt-1">
            {blockers.slice(0, 2).map((blocker) => (
              <li key={blocker.code} className="flex gap-1.5 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                <span>{blocker.message}</span>
              </li>
            ))}
            {blockers.length > 2 && (
              <li className="text-[11px] text-muted-foreground">
                and {blockers.length - 2} more to fix
              </li>
            )}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 pt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            <Check className="h-3 w-3" />
            Ready to ship
          </p>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-cyan-600 !bg-cyan-500" />
    </div>
  )
}

const STATUS_STYLE: Record<string, string> = {
  live: 'text-emerald-600 dark:text-emerald-400',
  built: 'text-cyan-600 dark:text-cyan-400',
  building: 'text-muted-foreground',
  draft: 'text-muted-foreground',
  failed: 'text-destructive',
}

const STATUS_LABEL: Record<string, string> = {
  live: 'Live',
  built: 'Built',
  building: 'Building',
  draft: 'Not shipped yet',
  failed: 'Build failed',
}

/** One place the product ships to. */
export function AppDistributionNode({ data, selected }: NodeProps) {
  const status = (data.status as string) ?? 'draft'
  const lastBuild = data.lastBuild as { version?: string; signed?: boolean } | null

  return (
    <div
      className={cn(
        'w-[240px] rounded-xl border-2 bg-card shadow-sm transition-shadow hover:shadow-md',
        selected ? 'border-primary ring-2 ring-primary' : 'border-border',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-cyan-600 !bg-cyan-500" />
      <div className="flex items-center gap-2 rounded-t-[10px] border-b bg-gradient-to-r from-cyan-50 to-cyan-100 px-3 py-2 dark:from-cyan-950 dark:to-cyan-900">
        <span aria-hidden className="text-sm leading-none">
          {interfaceTypeIcons[data.target as string] ?? '📦'}
        </span>
        <span className="truncate text-xs font-semibold text-cyan-700 dark:text-cyan-300">
          {data.label as string}
        </span>
      </div>
      <div className="space-y-1 p-3">
        <p className="text-xs leading-snug text-muted-foreground">{data.blurb as string}</p>
        <p className={cn('text-[11px] font-medium', STATUS_STYLE[status])}>
          {STATUS_LABEL[status] ?? status}
        </p>
        {lastBuild?.version && (
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            v{lastBuild.version}
            {lastBuild.signed ? (
              <>
                <Lock className="h-3 w-3" /> signed
              </>
            ) : (
              // An unsigned artifact will be refused by the OS on most
              // machines, so it is worth saying before someone ships it.
              <span className="text-amber-600 dark:text-amber-400">unsigned</span>
            )}
          </p>
        )}
      </div>
    </div>
  )
}

export const appNodeTypes = {
  appAgents: AppAgentsNode,
  appProduct: AppProductNode,
  appDistribution: AppDistributionNode,
}
