import { HttpException, HttpStatus } from '@nestjs/common';

import { GatewayType } from '../../../entities/gateway.entity';

/**
 * What an MCP OAuth scope lets its token do at the gateway.
 *
 * The authorization server grants `mcp:tools`, `mcp:resources`,
 * `mcp:prompts` or `mcp:*`, and shows the user exactly that on the consent
 * screen, but nothing at the resource read the grant: a token the user
 * approved for reading resources could call every tool. The scope now
 * decides which JSON-RPC methods a token may call.
 *
 * Methods outside the three namespaces (initialize, ping, notifications,
 * logging, completion) are the session itself and need no scope. The
 * tool-calling protocols that are not MCP (UTCP, the TOOLS gateway) are
 * tool calls throughout, so they need `mcp:tools`.
 */
export const MCP_WILDCARD_SCOPE = 'mcp:*';

export function scopeForMcpMethod(method: string): string | null {
  if (method.startsWith('tools/')) return 'mcp:tools';
  if (method.startsWith('resources/')) return 'mcp:resources';
  if (method.startsWith('prompts/')) return 'mcp:prompts';
  return null;
}

interface ScopedAuth {
  scopes?: string[];
  metadata?: { authMethod?: string } | Record<string, any>;
}

/** The scope the request needs and the OAuth token lacks, or null. */
export function missingOAuthScope(gatewayType: GatewayType | string, auth: ScopedAuth | null | undefined, body: unknown): string | null {
  // Only tokens from the MCP authorization server carry these scopes. API
  // keys, JWTs and the rest are governed by their own rules.
  if (auth?.metadata?.authMethod !== 'oauth2') return null;
  const granted = new Set(auth.scopes ?? []);
  if (granted.has(MCP_WILDCARD_SCOPE)) return null;

  if (gatewayType === GatewayType.UTCP || gatewayType === GatewayType.TOOLS) {
    return granted.has('mcp:tools') ? null : 'mcp:tools';
  }
  if (gatewayType !== GatewayType.MCP) return null;

  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    const method = (message as { method?: unknown } | null)?.method;
    if (typeof method !== 'string') continue;
    const needed = scopeForMcpMethod(method);
    if (needed && !granted.has(needed)) return needed;
  }
  return null;
}

/** RFC 6750 §3.1: 403 insufficient_scope, naming the scope that would do. */
export function assertOAuthScope(gatewayType: GatewayType | string, auth: ScopedAuth | null | undefined, body: unknown): void {
  const missing = missingOAuthScope(gatewayType, auth, body);
  if (!missing) return;
  const exception = new HttpException(
    {
      message: `This token was not granted ${missing}`,
      error: 'insufficient_scope',
      errorCode: 'OAUTH2_INSUFFICIENT_SCOPE',
      scope: missing,
    },
    HttpStatus.FORBIDDEN,
  );
  (exception as any).wwwAuthenticate = `Bearer error="insufficient_scope", scope="${missing}"`;
  throw exception;
}
