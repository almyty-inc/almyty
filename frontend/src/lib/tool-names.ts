/**
 * A tool's name for people. A tool made from an API is named for machines
 * (acme_shop_openapi_3_0_place_order): the API's name, then the
 * operation, in snake case. People read the operation's own summary when the
 * spec has one ("Place an order for a pet"), else the operation part of the
 * machine name, in words ("Place order").
 */

export interface NamedTool {
  name: string
  api?: { name?: string | null } | null
  operation?: { name?: string | null; api?: { name?: string | null } | null } | null
}

/** The API name the way tool generation prefixes it: lowercase, words joined by underscores. */
function machinePrefix(apiName: string): string {
  return apiName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** snake_case, kebab-case or camelCase as a sentence: "place_order" and "placeOrder" become "Place order". */
export function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.\s]+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value
}

/** A name with no spaces and an underscore, a dash or a case change in it reads as a machine name. */
function looksLikeMachineName(value: string): boolean {
  return !/\s/.test(value) && /[_-]|[a-z][A-Z]/.test(value)
}

export function readableToolName(tool: NamedTool): string {
  // A summary is a name here, so a sentence's closing full stop goes.
  const summary = tool.operation?.name?.trim().replace(/\.+$/, '')
  // An operation's name is its summary when the spec has one. A bare
  // operationId, or the "GET /pets/{id}" a spec without either gets, is no
  // better than the tool's own name.
  if (summary && !looksLikeMachineName(summary) && !/^[A-Z]+ \//.test(summary)) return summary
  const apiName = tool.api?.name ?? tool.operation?.api?.name ?? ''
  const prefix = apiName ? machinePrefix(apiName) : ''
  let rest = tool.name
  if (prefix && rest.toLowerCase().startsWith(`${prefix}_`) && rest.length > prefix.length + 1) rest = rest.slice(prefix.length + 1)
  return looksLikeMachineName(rest) ? humanizeIdentifier(rest) : rest
}
