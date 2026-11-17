/**
 * What an API's operations are, said the same way on the APIs list, its
 * header and the API page.
 *
 * Operations are read from an API's description. An API connected as a bare
 * address (Custom HTTP) has no description, so it has no operations: its
 * tools were made by hand, each calling a path under its address. Showing
 * "0" there put an API with nothing in it next to a tool that calls it.
 */
import { ApiType, type Api } from '@/types'
import { pluralized } from '@/lib/utils'

/** An API connected as a bare address (Custom HTTP), with no description to import. */
export function isManualHttp(api: Pick<Api, 'type' | 'schemas' | 'hasDescription' | 'operationCount' | 'operations'>): boolean {
  if (api.type !== ApiType.HTTP) return false
  if (api.hasDescription) return false
  if (api.schemas && api.schemas.length > 0) return false
  return operationCount(api) === 0
}

/** How many operations the API has, from the list's count or the loaded operations. */
export function operationCount(api: Pick<Api, 'operationCount' | 'operations'>): number {
  return api.operationCount ?? api.operations?.length ?? 0
}

/** Shown in place of an operation count for an API whose tools were made by hand. */
export const MANUAL_OPERATIONS_LABEL = 'Made by hand'

export const MANUAL_OPERATIONS_HINT =
  'This API has no description, so it has no operations: its tools were made by hand, each calling a path under its address.'

/** The tools, of those given, that come from this API: made from its operations or by hand. */
export function apiTools<T extends { metadata?: Record<string, any>; apiId?: string | null }>(api: Pick<Api, 'id'>, allTools: T[]): T[] {
  return allTools.filter((tool) => tool.metadata?.sourceApi?.id === api.id || tool.apiId === api.id)
}

/**
 * The APIs page header: "N APIs · N operations · N tools", counted the way
 * the list's columns count them, so the header and the rows add up. Tools
 * made by hand are named, since they have no operation behind them.
 */
export function apisSummary(
  apis: Array<Pick<Api, 'id' | 'operationCount' | 'operations'>>,
  allTools: Array<{ metadata?: Record<string, any>; apiId?: string | null; operationId?: string | null }>,
): string {
  const operations = apis.reduce((sum, api) => sum + operationCount(api), 0)
  const tools = apis.flatMap((api) => apiTools(api, allTools))
  const byHand = tools.filter((tool) => !tool.operationId).length
  const parts = [
    pluralized(apis.length, 'API', 'APIs'),
    pluralized(operations, 'operation'),
    `${pluralized(tools.length, 'tool')}${byHand > 0 ? ` (${byHand.toLocaleString('en-US')} made by hand)` : ''}`,
  ]
  return parts.join(' · ')
}
