/**
 * The one way the app shows money spent and time taken.
 *
 * Cost: two decimals from one cent up ($2.47, $1,234.50), "<$0.01" for
 * anything under a cent, "--" for zero or no data. Full precision belongs in
 * a `title` tooltip (costTitle) and in exports, never in the visible text.
 *
 * Duration: "0.4s" under a second, whole seconds under a minute ("55s"),
 * then "1m 18s" and "2h 5m". Never a decimal minute or hour.
 */

export interface FormatOptions {
  /** What zero or missing data reads as. Default "--". */
  empty?: string
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** A dollar amount: "$2.47", "<$0.01", "--". Negative amounts keep their sign. */
export function formatCost(dollars: number | null | undefined, options: FormatOptions = {}): string {
  const empty = options.empty ?? '--'
  if (dollars === null || dollars === undefined || !Number.isFinite(dollars) || dollars === 0) return empty
  const sign = dollars < 0 ? '-' : ''
  const abs = Math.abs(dollars)
  if (abs < 0.005) return `${sign}<$0.01`
  return `${sign}${USD.format(abs)}`
}

/** An amount in cents (fractions allowed), shown as formatCost shows dollars. */
export function formatCostCents(cents: number | null | undefined, options: FormatOptions = {}): string {
  return formatCost(cents === null || cents === undefined ? cents : cents / 100, options)
}

/** The exact amount for a tooltip ("$2.4665"), or undefined when there is none. */
export function costTitle(dollars: number | null | undefined): string | undefined {
  if (dollars === null || dollars === undefined || !Number.isFinite(dollars) || dollars === 0) return undefined
  const sign = dollars < 0 ? '-' : ''
  return `${sign}$${parseFloat(Math.abs(dollars).toFixed(8))}`
}

/** costTitle for an amount in cents. */
export function costTitleCents(cents: number | null | undefined): string | undefined {
  return costTitle(cents === null || cents === undefined ? cents : cents / 100)
}

/** A duration in milliseconds: "0.4s", "55s", "1m 18s", "2h 5m", "--". */
export function formatDuration(ms: number | null | undefined, options: FormatOptions = {}): string {
  const empty = options.empty ?? '--'
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return empty
  if (ms < 50) return '<0.1s'
  if (ms < 950) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return s ? `${m}m ${s}s` : `${m}m`
  }
  const minutes = Math.round(seconds / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}h ${m}m` : `${h}h`
}
