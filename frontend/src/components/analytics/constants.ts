/* Shared constants for the analytics tabs. */

/*
 * Protocol colours used to live here as a dark-only map
 * (`text-violet-300` with no light half), so in light mode an MCP badge
 * was unreadable. There is exactly one canonical map, in
 * `components/ui/protocol-badge.tsx`, and it carries both halves — so the
 * analytics tabs render <ProtocolBadge /> directly rather than keeping a
 * second copy of the palette that can drift from it again.
 */

export const statusColors: Record<string, string> = {
  // Both halves, for the same reason: -600 alone disappears against a
  // dark table row.
  '2': 'text-green-600 dark:text-green-400',
  '3': 'text-blue-600 dark:text-blue-400',
  '4': 'text-yellow-600 dark:text-yellow-400',
  '5': 'text-red-600 dark:text-red-400',
}

/*
 * The analytics tabs hand-roll their <table>s rather than going through
 * DataTable, and had drifted into three densities (px-4 py-3 headers,
 * px-4 py-2.5 cells, px-3 py-2 in the log tabs). All eight now use one
 * density: this header class — the same one TableHead applies in
 * components/ui/table.tsx — over `px-4 py-3` cells.
 */
export const TABLE_HEAD_CLASS =
  'h-12 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wider'

export type AnalyticsTab =
  | 'overview'
  | 'requests'
  | 'tools'
  | 'gateways'
  | 'llm'
  | 'routing'
  | 'agents'
  | 'cost'
  | 'chargeback'
  | 'audit'

export const ANALYTICS_TABS: AnalyticsTab[] = [
  'overview',
  'requests',
  'tools',
  'gateways',
  'llm',
  'routing',
  'agents',
  'cost',
  'chargeback',
  'audit',
]

export function getAnalyticsTab(pathname: string): AnalyticsTab {
  for (const t of ANALYTICS_TABS) {
    if (t !== 'overview' && pathname.includes(`/${t}`)) return t
  }
  return 'overview'
}
