/**
 * The API a tool came from.
 *
 * The tools list read only `metadata.sourceApi.name` -- a copy some creation
 * paths write and others do not -- and the backend joined the API only
 * through the tool's operation. A tool with an `apiId` but neither (every
 * tool the sample workspace seeded, for one) read "Unknown API" beside an
 * API that exists. The real relation wins; the metadata copy is the fallback.
 */
export interface ToolSourceApi {
  id?: string
  name?: string
}

export function toolSourceApi(tool: any): ToolSourceApi {
  const api = tool?.api ?? tool?.operation?.api
  if (api?.name) return { id: api.id ?? tool?.apiId, name: api.name }
  const copy = tool?.metadata?.sourceApi
  if (copy?.name) return { id: copy.id ?? tool?.apiId, name: copy.name }
  return { id: tool?.apiId }
}

/**
 * What to show for an API tool whose API cannot be found: it was deleted,
 * since the list loads the relation. "Unknown API" said nothing useful.
 */
export const DELETED_API_LABEL = 'Deleted API'
