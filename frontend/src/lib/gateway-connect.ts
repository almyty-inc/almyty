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
  if (type === 'mcp' || type === 'tools') return claudeCodeCommand(gateway, orgSlug, backendUrl)
  if (type === 'skills') return skillsInstallCommand(gateway, orgSlug)
  return null
}

/** Same slug the gateway detail page derives for the org. */
export function orgSlugOf(org: { slug?: string | null; name?: string | null } | null | undefined): string {
  return org?.slug || org?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
}

/** The header a shared-tools gateway reads its access key from. */
export const ACCESS_KEY_HEADER = 'x-api-key'

/** Stands in for the key once it has been shown and can't be again. */
export const ACCESS_KEY_PLACEHOLDER = '<your-access-key>'

export interface ClientSnippet {
  /** Stable id, for tabs and tests. */
  id: 'claude-code' | 'cursor' | 'claude-desktop' | 'mcp' | 'utcp' | 'skills'
  label: string
  /** One line: where the snippet goes. */
  hint: string
  value: string
  language: 'bash' | 'json' | 'text'
}

/** The address slug of a gateway: its endpoint without the leading slash. */
export function gatewaySlugOf(gateway: ConnectableGateway): string {
  return gateway.endpoint?.replace(/^\/+/, '') || gatewayClientName(gateway)
}

/**
 * Everything a person pastes to use a shared-tools gateway, one entry per
 * client. One address serves every entry: MCP clients POST to it, UTCP
 * reads `/manual`, Skills come from `/skills`. With no key in hand (it is
 * shown once, at creation) the snippets carry a placeholder instead.
 */
export function sharedToolsSnippets(
  gateway: ConnectableGateway,
  orgSlug: string,
  key?: string | null,
  backendUrl = gatewayBackendUrl(),
): ClientSnippet[] {
  const url = mcpEndpointFor(gateway, orgSlug, backendUrl)
  const name = gatewayClientName(gateway)
  const secret = key || ACCESS_KEY_PLACEHOLDER
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      hint: 'Run in your terminal.',
      value: `claude mcp add ${name} --transport http ${url} --header "${ACCESS_KEY_HEADER}: ${secret}"`,
      language: 'bash',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      hint: 'Add to .cursor/mcp.json in your project, or ~/.cursor/mcp.json for all of them.',
      value: json({ mcpServers: { [name]: { url, headers: { [ACCESS_KEY_HEADER]: secret } } } }),
      language: 'json',
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      hint: 'Add to claude_desktop_config.json (Settings, Developer, Edit config), then restart Claude Desktop.',
      value: json({
        mcpServers: {
          [name]: {
            command: 'npx',
            args: ['-y', 'mcp-remote', url, '--header', `${ACCESS_KEY_HEADER}:\${ALMYTY_KEY}`],
            env: { ALMYTY_KEY: secret },
          },
        },
      }),
      language: 'json',
    },
    {
      id: 'mcp',
      label: 'Other MCP clients',
      hint: 'Any client that speaks MCP over HTTP.',
      value: `URL:    ${url}\nHeader: ${ACCESS_KEY_HEADER}: ${secret}`,
      language: 'text',
    },
    {
      id: 'utcp',
      label: 'UTCP',
      hint: `The manual lists every tool; POST to ${url}/execute to run one.`,
      value: `curl -H "${ACCESS_KEY_HEADER}: ${secret}" ${url}/manual`,
      language: 'bash',
    },
    {
      id: 'skills',
      label: 'Skills',
      hint: `Installs one SKILL.md per tool into your coding agent. With the key instead: GET ${url}/skills.`,
      value: `npx @almyty/skills install @${orgSlug}/${gatewaySlugOf(gateway)}`,
      language: 'bash',
    },
  ]
}
