/**
 * What a gateway is: an MCP server, a UTCP manual or an Agent Skills bundle
 * serving tools. A web chat, widget, messaging platform or A2A endpoint is a
 * channel on an agent; its gateway is reached from the agent's Channels
 * tab and is never listed or counted as a gateway.
 */
export const GATEWAY_PROTOCOLS = ['mcp', 'utcp', 'skills'] as const

export const isProtocolGateway = (gateway: { type?: string | null } | null | undefined): boolean =>
  !!gateway?.type && (GATEWAY_PROTOCOLS as readonly string[]).includes(gateway.type)

/**
 * Protocol surfaces a caller reaches with an almyty identity (an access
 * key, an OAuth token). Only these can be private: a chat channel is reached
 * by people who never sign in to almyty, so the server refuses a private
 * one. Mirrors PRIVATE_CAPABLE_GATEWAY_TYPES on the backend.
 */
export const PRIVATE_CAPABLE_GATEWAY_TYPES = new Set(['tools', 'mcp', 'utcp', 'skills', 'a2a'])