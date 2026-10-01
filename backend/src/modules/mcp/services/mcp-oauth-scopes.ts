/**
 * The scopes an MCP OAuth client can register and be granted: exactly the
 * `scopes_supported` both metadata documents advertise. Registration
 * refuses anything else, and a grant is a subset of what the client
 * registered, so a token never carries a scope string its caller made up
 * (such as one a gateway tool's `requiredScopes` names -- those are for
 * admin-minted gateway keys).
 */
export const MCP_OAUTH_SCOPES = ['mcp:tools', 'mcp:resources', 'mcp:prompts', 'mcp:*'];