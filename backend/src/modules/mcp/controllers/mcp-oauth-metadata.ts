import { MCP_OAUTH_SCOPES } from '../services/mcp-oauth-scopes';
import { cimdSettings } from '../core/mcp-settings';

/**
 * Whether a gateway accepts clients by Client ID Metadata Document.
 *
 * On unless the server turns the feature off (MCP_CIMD_ENABLED=false) or the
 * gateway's owner restricts it to registered clients with
 * `configuration.oauth.clientMetadataDocuments: false` (design doc,
 * decision 8: off by default, i.e. documents accepted).
 */
export function gatewayAcceptsMetadataDocuments(gateway: { configuration?: Record<string, any> | null } | null | undefined): boolean {
  if (!cimdSettings().enabled) return false;
  return gateway?.configuration?.oauth?.clientMetadataDocuments !== false;
}

/**
 * RFC 8414 authorization server metadata for one gateway.
 *
 * Served twice: at the RFC 8414 path-inserted location
 * (`/.well-known/oauth-authorization-server/{org}/{gateway}`,
 * McpOAuthDiscoveryController) and at the path-suffixed one older clients
 * try (`/{org}/{gateway}/.well-known/oauth-authorization-server`,
 * McpOAuthController). One builder, so the two cannot disagree;
 * `as-metadata-documents-agree.spec.ts` holds both controllers to it.
 *
 *  - `client_id_metadata_document_supported`: MCP 2025-11-25 (SEP-991).
 *  - `authorization_response_iss_parameter_supported`: RFC 9207, MCP
 *    2026-07-28 (SEP-2468); every authorization response carries `iss`.
 *  - `registration_endpoint`: Dynamic Client Registration stays, deprecated
 *    in 2026-07-28 and kept for clients without CIMD support.
 */
export function authorizationServerMetadata(
  base: string,
  orgSlug: string,
  gatewaySlug: string,
  gateway: { configuration?: Record<string, any> | null } | null | undefined,
): Record<string, unknown> {
  const prefix = `${base}/${orgSlug}/${gatewaySlug}`;
  return {
    issuer: prefix,
    authorization_endpoint: `${prefix}/authorize`,
    token_endpoint: `${prefix}/token`,
    registration_endpoint: `${prefix}/register`,
    revocation_endpoint: `${prefix}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: MCP_OAUTH_SCOPES,
    client_id_metadata_document_supported: gatewayAcceptsMetadataDocuments(gateway),
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/docs`,
  };
}

/** The issuer identifier a gateway's authorization responses carry as `iss`. */
export function gatewayIssuer(base: string, orgSlug: string, gatewaySlug: string): string {
  return `${base}/${orgSlug}/${gatewaySlug}`;
}
