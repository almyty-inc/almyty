/* Shared constants for the analytics tabs. */

export const protocolColors: Record<string, string> = {
  mcp: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
  utcp: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  a2a: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  skills: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
}

export const statusColors: Record<string, string> = {
  '2': 'text-green-600',
  '3': 'text-blue-600',
  '4': 'text-yellow-600',
  '5': 'text-red-600',
}

export type AnalyticsTab =
  | 'overview'
  | 'requests'
  | 'tools'
  | 'gateways'
  | 'llm'
  | 'agents'
  | 'cost'
  | 'audit'

export const ANALYTICS_TABS: AnalyticsTab[] = [
  'overview',
  'requests',
  'tools',
  'gateways',
  'llm',
  'agents',
  'cost',
  'audit',
]

export function getAnalyticsTab(pathname: string): AnalyticsTab {
  for (const t of ANALYTICS_TABS) {
    if (t !== 'overview' && pathname.includes(`/${t}`)) return t
  }
  return 'overview'
}
