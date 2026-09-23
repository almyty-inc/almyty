/**
 * How an outside client reaches a gateway. One place for the address and
 * the copy-paste commands, so the gateway's Integrations tab and the
 * guide never show two different commands for the same gateway.
 */

export interface ConnectableGateway {
  name?: string | null
  type?: string | null
  endpoint?: string | null
}

/** The name a client registers the gateway under: lowercase, dashes for spaces. */
export function gatewayClientName(gateway: ConnectableGateway): string {
  return (gateway.name || 'gateway').toLowerCase().replace(/\s+/g, '-')
}

/** The API origin the gateway is served from. */
export function gatewayBackendUrl(): string {
  return import.meta.env.ALMYTY_API_BASE_URL || window.location.origin
}

/** `<api origin>/<org slug>/<gateway endpoint>`, the MCP JSON-RPC address. */
export function mcpEndpointFor(gateway: ConnectableGateway, orgSlug: string, backendUrl = gatewayBackendUrl()): string {
  const gwSlug = gateway.endpoint?.replace(/^\//, '') || ''
  return `${backendUrl}/${orgSlug}/${gwSlug}`
}

/** The one-line Claude Code command for an MCP gateway. */
export function claudeCodeCommand(gateway: ConnectableGateway, orgSlug: string, backendUrl = gatewayBackendUrl()): string {
  return `claude mcp add ${gatewayClientName(gateway)} --transport http ${mcpEndpointFor(gateway, orgSlug, backendUrl)}`
}

/** The install command for a Skills gateway. */
export function skillsInstallCommand(gateway: ConnectableGateway, orgSlug: string): string {
  return `npx @almyty/skills install @${orgSlug}/${gatewayClientName(gateway)}`
}

/**
 * The single command a coding harness needs for this gateway, or null
 * when its protocol has no one-line install (A2A, UTCP: see the
 * gateway's Integrations tab).
 */
export function connectCommandFor(gateway: ConnectableGateway, orgSlug: string, backendUrl = gatewayBackendUrl()): string | null {
  const type = (gateway.type || 'mcp').toLowerCase()
  if (type === 'mcp') return claudeCodeCommand(gateway, orgSlug, backendUrl)
  if (type === 'skills') return skillsInstallCommand(gateway, orgSlug)
  return null
}

/** Same slug the gateway detail page derives for the org. */
export function orgSlugOf(org: { slug?: string | null; name?: string | null } | null | undefined): string {
  return org?.slug || org?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
}
