/* Shared formatting helpers for the analytics tabs. */

export function formatMs(ms: number): string {
  if (!ms || ms === 0) return '--'
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function formatDate(date: string | null): string {
  if (!date) return 'Never'
  const d = new Date(date)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60000) return 'Just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString()
}

export function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return n.toString()
}

/**
 * Data-driven y-axis ceiling for the analytics charts: the smallest
 * "nice" number (1, 2 or 5 times a power of ten) at or above the max
 * data value, with a small floor so a near-empty chart still gets a
 * readable scale instead of a collapsed axis. No fixed maximum — a
 * week of low volume must not render against a 200-high axis.
 */
export function computeYAxisMax(values: number[], minCeiling = 10): number {
  const max = Math.max(0, ...values.filter((v) => Number.isFinite(v)))
  if (max <= minCeiling) return minCeiling
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)))
  for (const step of [1, 2, 5]) {
    if (max <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}
