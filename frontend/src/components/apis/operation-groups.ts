import type { OperationOutline } from '@/types'

export interface OperationGroup {
  /** The tag, or the path prefix when the operation has no tag. */
  key: string
  operations: OperationOutline[]
}

/** A path segment that says nothing about what the operation is for: `v1`, `v2.0`, `api`, `{id}`. */
function isNoise(segment: string): boolean {
  return !segment || /^\{.*\}$/.test(segment) || /^v\d+(\.\d+)*$/i.test(segment) || /^(api|rest)$/i.test(segment)
}

/** The first meaningful segment of a path: `/v1.0/drives/{id}/items` is "drives". */
export function pathPrefix(endpoint: string | null | undefined): string {
  const segment = (endpoint ?? '').split('?')[0].split('/').find((s) => !isNoise(s))
  return segment ? `/${segment}` : '/'
}

/** Where an operation is filed: its first tag, else the first meaningful segment of its path. */
export function groupKey(operation: OperationOutline): string {
  const tag = operation.tags?.find((t) => typeof t === 'string' && t.trim())
  return tag ? tag.trim() : pathPrefix(operation.endpoint)
}

/** Does the operation match a search: its tag, path, method or name. */
export function matchesSearch(operation: OperationOutline, search: string): boolean {
  const q = search.trim().toLowerCase()
  if (!q) return true
  return [groupKey(operation), operation.endpoint, operation.method, operation.name, operation.operationId, operation.displayName]
    .some((field) => typeof field === 'string' && field.toLowerCase().includes(q))
}

/** The operations that match a search, filed by tag or path prefix, groups in name order. */
export function groupOperations(operations: OperationOutline[], search = ''): OperationGroup[] {
  const groups = new Map<string, OperationOutline[]>()
  for (const operation of operations) {
    if (!matchesSearch(operation, search)) continue
    const key = groupKey(operation)
    const list = groups.get(key)
    if (list) list.push(operation)
    else groups.set(key, [operation])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({ key, operations: list }))
}

/** "driveItem" -> "Drive item", "crm_owners" -> "Crm owners". */
function words(part: string): string {
  const text = part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : part
}

/**
 * A group's name for people. A dotted tag (Microsoft Graph's `me.drive`,
 * `drives.driveItem`) reads as "Me › Drive", "Drives › Drive item"; a path
 * prefix stays as it is. The raw tag is still what the search matches.
 */
export function groupLabel(key: string): string {
  if (key.startsWith('/')) return key
  const parts = key.split('.').filter(Boolean)
  return parts.length > 1 ? parts.map(words).join(' › ') : words(key)
}
