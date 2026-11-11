/**
 * A tool's name for people. A tool made from an API is named for machines
 * (acme_shop_openapi_3_0_place_order): the API's name, then the
 * operation, in snake case. People read the operation's own summary when the
 * spec has one ("Place an order for a pet"), else the operation part of the
 * machine name, in words ("Place order").
 */

export interface NamedTool {
  name: string
  description?: string | null
  api?: { name?: string | null } | null
  operation?: { name?: string | null; description?: string | null; api?: { name?: string | null } | null } | null
  /** `displayName`: the name tool generation chose for people (backend tools/tool-display-name.ts). */
  metadata?: {
    displayName?: string | null
    /** The operation a generated tool calls: its method and path tell two same-named operations apart. */
    sourceOperation?: { method?: string | null; endpoint?: string | null } | null
    [key: string]: unknown
  } | null
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

/** A name with no spaces and an underscore, a dash, a case change or dots (gmail.users.messages.send) in it reads as a machine name. */
function looksLikeMachineName(value: string): boolean {
  return !/\s/.test(value) && (/[_-]|[a-z][A-Z]/.test(value) || /^[\w$]+(?:\.[\w$]+)+$/.test(value))
}

/**
 * "GET /crm/v3/owners operation": what tool generation writes as the
 * description of an operation the spec does not describe. It is a method
 * and a path, not a name.
 */
export function isGeneratedDescription(text: string): boolean {
  return /^[A-Z]+ \/\S* operation\.?$/.test(text.trim())
}

/** The first sentence of a description, when it is short enough to be a name. */
function shortSentence(description: string | null | undefined): string | null {
  // Descriptions are often markdown (Google's: "in the `To`, `Cc` ... headers"); a name has none.
  const text = (description ?? '').replace(/`|\*\*/g, '').replace(/\s+/g, ' ').trim()
  if (!text || isGeneratedDescription(text)) return null
  const end = text.search(/[.!?](\s|$)/)
  const sentence = (end >= 0 ? text.slice(0, end) : text).trim()
  return sentence && sentence.length <= 90 ? sentence : null
}

export function readableToolName(tool: NamedTool): string {
  const chosen = typeof tool.metadata?.displayName === 'string' ? tool.metadata.displayName.trim() : ''
  if (chosen) return chosen
  // A summary is a name here, so a sentence's closing full stop goes.
  const summary = tool.operation?.name?.trim().replace(/\.+$/, '')
  // An operation's name is its summary when the spec has one. A bare
  // operationId, or the "GET /pets/{id}" a spec without either gets, is no
  // better than the tool's own name.
  if (summary && !looksLikeMachineName(summary) && !/^[A-Z]+ \//.test(summary)) return summary
  // A spec without summaries (Google's, HubSpot's) still describes each
  // operation: "Lists the messages in the user's mailbox."
  const described = shortSentence(tool.operation?.description) ?? shortSentence(tool.description)
  if (described) return described
  const apiName = tool.api?.name ?? tool.operation?.api?.name ?? ''
  const prefix = apiName ? machinePrefix(apiName) : ''
  let rest = tool.name
  if (prefix && rest.toLowerCase().startsWith(`${prefix}_`) && rest.length > prefix.length + 1) rest = rest.slice(prefix.length + 1)
  // A long generated name ends in a six-character hash that keeps it unique; it is not a word.
  rest = rest.replace(/_[0-9a-f]{6}$/, '')
  return looksLikeMachineName(rest) ? humanizeIdentifier(rest) : rest
}
/** "GET /{start_date}..": the method and path of the operation a generated tool calls, when known. */
function operationRoute(tool: NamedTool): string | null {
  const op = tool.metadata?.sourceOperation
  const endpoint = typeof op?.endpoint === 'string' ? op.endpoint.trim() : ''
  if (!endpoint) return null
  const method = typeof op?.method === 'string' ? op.method.trim().toUpperCase() : ''
  return method ? `${method} ${endpoint}` : endpoint
}

/**
 * Every tool's name for people, unique within the list. A spec may give two
 * operations one summary (Frankfurter's `/{start_date}..` and
 * `/{start_date}..{end_date}` are both "Get rates for a time period"), and a
 * picker that shows the same words twice cannot be chosen from. Names that
 * collide carry what tells them apart: the operation's method and path, else
 * the tool's machine name.
 */
export function distinctToolNames<T extends NamedTool & { id: string }>(tools: readonly T[]): Map<string, string> {
  const base = new Map<string, string>()
  const count = new Map<string, number>()
  for (const t of tools) {
    const name = readableToolName(t)
    base.set(t.id, name)
    count.set(name, (count.get(name) ?? 0) + 1)
  }
  const out = new Map<string, string>()
  for (const t of tools) {
    const name = base.get(t.id)!
    if ((count.get(name) ?? 0) < 2) {
      out.set(t.id, name)
      continue
    }
    const route = operationRoute(t)
    const sameRoute = route ? tools.filter((o) => base.get(o.id) === name && operationRoute(o) === route).length : 0
    const qualifier = route && sameRoute === 1 ? route : t.name !== name ? t.name : null
    out.set(t.id, qualifier ? `${name} (${qualifier})` : name)
  }
  return out
}
