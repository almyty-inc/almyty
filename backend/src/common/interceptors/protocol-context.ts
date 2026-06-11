/**
 * Protocol request context — set by the code that actually resolves a
 * gateway (unified endpoint delegation, root JSON-RPC handlers) so the
 * request-logging interceptor can attribute the request to a gateway,
 * organization, and protocol without guessing from the URL.
 *
 * Path sniffing cannot work for the multi-tenant routes: a request to
 * `/:orgSlug/:resourceSlug` carries the gateway's endpoint slug (e.g.
 * `/acme/petstore-mcp`), which says nothing reliable about protocol or
 * gateway identity. The handler knows both — it should say so.
 */

export interface ProtocolContext {
  gatewayId?: string | null;
  organizationId?: string | null;
  /** Protocol identifier: 'mcp' | 'utcp' | 'a2a' | 'acp' | 'skills' | ... */
  protocol?: string | null;
}

const CONTEXT_KEY = 'protocolContext';

export function setProtocolContext(req: unknown, ctx: ProtocolContext): void {
  if (!req || typeof req !== 'object') return;
  const r = req as Record<string, any>;
  r[CONTEXT_KEY] = { ...r[CONTEXT_KEY], ...ctx };
}

export function getProtocolContext(req: unknown): ProtocolContext | undefined {
  if (!req || typeof req !== 'object') return undefined;
  return (req as Record<string, any>)[CONTEXT_KEY];
}
