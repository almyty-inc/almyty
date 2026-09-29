/**
 * Shared constants, variant maps, and helper functions used across
 * agent detail sub-components.
 */

export const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success'> = {
  active: 'success',
  draft: 'outline',
  inactive: 'secondary',
  error: 'destructive',
}

export const execStatusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  running: 'secondary',
  pending: 'outline',
  failed: 'destructive',
  cancelled: 'secondary',
  timeout: 'destructive',
}

export const runStatusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success'> = {
  pending: 'secondary',
  running: 'default',
  waiting_input: 'outline',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
  timeout: 'destructive',
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export function diffObjects(prev: Record<string, any>, curr: Record<string, any>): { field: string; from: any; to: any }[] {
  const changes: { field: string; from: any; to: any }[] = []
  const allKeys = new Set([...Object.keys(prev || {}), ...Object.keys(curr || {})])
  for (const key of allKeys) {
    if (JSON.stringify(prev?.[key]) !== JSON.stringify(curr?.[key])) {
      changes.push({ field: key, from: prev?.[key], to: curr?.[key] })
    }
  }
  return changes
}

export function formatDiffValue(value: any): string {
  if (value === undefined || value === null) return '(none)'
  if (typeof value === 'object') {
    const str = JSON.stringify(value)
    return str.length > 60 ? str.slice(0, 60) + '...' : str
  }
  const str = String(value)
  return str.length > 60 ? str.slice(0, 60) + '...' : str
}
