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


import { updateRequestContext } from '../request-context';

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
  // Mirror into the correlation scope. This is the one place in the
  // codebase that learns which gateway is answering, so anything that
  // wants to stamp a gateway on a row it writes (a tool execution, a log
  // line) can read it here instead of having it threaded through every
  // signature in between.
  updateRequestContext({
    gatewayId: ctx.gatewayId ?? undefined,
    organizationId: ctx.organizationId ?? undefined,
  });
}

export function getProtocolContext(req: unknown): ProtocolContext | undefined {
  if (!req || typeof req !== 'object') return undefined;
  return (req as Record<string, any>)[CONTEXT_KEY];
}
