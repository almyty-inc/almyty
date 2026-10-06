/**
 * The legacy HTTP+SSE transport is deprecated (MCP 2026-07-28, SEP-2596),
 * served until the request log shows nobody uses it, then removed
 * (docs/design/mcp-2026-07-28.md, "Deprecations"). Until then every response
 * on its routes tells the client, in the standard way (RFC 9745):
 *
 *   Deprecation: @1785196800
 *   Link: <https://docs.almyty.com/gateways/mcp#legacy-sse-transport>; rel="deprecation"; type="text/html"
 *
 * so a client author sees it in their tooling without reading our docs.
 * MCP_LEGACY_SSE_* in mcp-settings.ts configures or turns it off.
 */
import { legacySseSettings } from './mcp-settings';

interface HeaderSink {
  setHeader(name: string, value: string): unknown;
}

export function setLegacySseDeprecationHeaders(res: HeaderSink, env: Record<string, string | undefined> = process.env): void {
  const settings = legacySseSettings(env);
  if (!settings.deprecationHeaders) return;
  res.setHeader('Deprecation', `@${settings.deprecatedAt}`);
  res.setHeader('Link', `<${settings.docsUrl}>; rel="deprecation"; type="text/html"`);
}
