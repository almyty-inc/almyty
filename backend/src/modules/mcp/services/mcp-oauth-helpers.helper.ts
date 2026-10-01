import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { Repository } from 'typeorm';

import { OAuthClient } from '../../../entities/oauth-client.entity';
import { inferApplicationType } from '../core/mcp-settings';

/**
 * Pure helpers extracted from McpOAuthService:
 * — hashing
 * — client-secret authentication
 * — redirect URI policy
 *
 * Kept as plain functions; no DI, no state, no Nest @Injectable.
 */

export function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Enforce the client's registered token-endpoint authentication method.
 * Previously the /token, /revoke, and refresh paths NEVER checked the
 * presented client_secret — even a client registered with
 * `client_secret_post` was effectively public. Any caller who knew the
 * clientId could exchange codes, refresh tokens, and revoke anything
 * on their behalf.
 *
 * Rules:
 * - Public client (`tokenEndpointAuthMethod === 'none'`): secret MUST
 *   NOT be presented. Presenting one is an error — prevents confusing
 *   "worked because we ignored it" behaviour during migration.
 * - Confidential client (`client_secret_post`): secret MUST be
 *   presented and MUST match the stored hash via a timing-safe
 *   comparison of the SHA-256 digests.
 */
export function verifyClientAuth(client: OAuthClient, presented?: string): void {
  const method = client.tokenEndpointAuthMethod || 'none';

  if (method === 'none') {
    if (presented !== undefined && presented !== '') {
      throw new UnauthorizedException(
        'Client is registered as public — client_secret must not be presented',
      );
    }
    return;
  }

  if (method === 'client_secret_post') {
    if (!client.clientSecretHash) {
      throw new UnauthorizedException('Client configuration is invalid');
    }
    if (!presented) {
      throw new UnauthorizedException('client_secret is required for this client');
    }

    const expected = Buffer.from(client.clientSecretHash, 'hex');
    const actual = Buffer.from(hashValue(presented), 'hex');
    if (
      expected.length !== actual.length ||
      !crypto.timingSafeEqual(expected, actual)
    ) {
      throw new UnauthorizedException('Invalid client_secret');
    }
    return;
  }

  throw new UnauthorizedException(`Unsupported token_endpoint_auth_method: ${method}`);
}

/** Loopback hosts a native client may listen on (RFC 8252 section 7.3). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Schemes that are never a redirect target, whatever the client says it
 * is: each runs or reads something in the browser that follows it. The
 * consent page assigns the redirect to `window.location.href`, from the
 * dashboard's own origin.
 */
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'about:',
  'blob:',
  'filesystem:',
  'view-source:',
  'chrome:',
  'ws:',
  'wss:',
  'ftp:',
]);

export type OAuthApplicationType = 'web' | 'native';

export function isApplicationType(value: unknown): value is OAuthApplicationType {
  return value === 'web' || value === 'native';
}

function isLoopbackHttp(parsed: URL): boolean {
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
}

/** Every redirect URI a loopback http one: what a native app or a CLI registers. */
export function allLoopbackRedirects(uris: string[]): boolean {
  return (
    uris.length > 0 &&
    uris.every((uri) => {
      try {
        return isLoopbackHttp(new URL(uri));
      } catch {
        return false;
      }
    })
  );
}

/**
 * Redirect URI policy (OAuth 2.1, RFC 8252, OIDC Dynamic Registration).
 *
 * The scheme is checked first and on its own. This used to read "https, or
 * any scheme at all when the host is localhost", and a URL such as
 * `javascript://localhost/%0aalert(1)//` has host localhost: the consent
 * page hands the redirect to `window.location.href`, so a client could
 * register one and run script in the dashboard's origin the moment the
 * user clicked Approve or Deny.
 *
 * With an `applicationType` (MCP 2026-07-28, SEP-837):
 *  - `web`: https only; loopback http only outside production, for local
 *    development against a dev server;
 *  - `native`: https, loopback http on any port, and a private-use scheme
 *    (`cursor://...`, `com.example.app:/cb`), never one of the schemes
 *    above.
 * Without one, the rule every client had before application_type existed:
 * https, or http on a loopback host.
 *
 * A fragment is never allowed (OAuth 2.1 section 2.3.1).
 */
export function validateRedirectUri(uri: string, applicationType?: OAuthApplicationType): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new BadRequestException(`Invalid redirect_uri: ${uri}`);
  }

  if (parsed.hash) {
    throw new BadRequestException('redirect_uri must not contain a fragment identifier');
  }

  if (FORBIDDEN_SCHEMES.has(parsed.protocol)) {
    throw new BadRequestException('redirect_uri must use HTTPS (or HTTP on a loopback host)');
  }

  if (parsed.protocol === 'https:') return;

  if (parsed.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new BadRequestException('redirect_uri must use HTTPS (except for localhost)');
    }
    if (applicationType === 'web' && process.env.NODE_ENV === 'production') {
      throw new BadRequestException(
        'A web client must use an https redirect_uri; register with application_type "native" for a loopback redirect',
      );
    }
    return;
  }

  // A private-use scheme: only a native app may claim one.
  if (applicationType !== 'native') {
    throw new BadRequestException('redirect_uri must use HTTPS (or HTTP on a loopback host)');
  }
  if (!/^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol)) {
    throw new BadRequestException(`Invalid redirect_uri scheme: ${parsed.protocol}`);
  }
}

/**
 * A client_id that is a Client ID Metadata Document URL: https, with a
 * path, no credentials and no fragment. Anything else is a registered
 * client's id.
 */
export function isMetadataDocumentClientId(clientId: unknown): clientId is string {
  if (typeof clientId !== 'string' || !clientId.startsWith('https://') || clientId.length > 2048) return false;
  try {
    const url = new URL(clientId);
    return (
      url.protocol === 'https:' &&
      url.pathname.length > 1 &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

type ClientFinder = Pick<Repository<OAuthClient>, 'findOne'>;

/**
 * The active client a request on this gateway names: one registered on the
 * gateway, or a Client ID Metadata Document client, which is the same
 * client on every gateway.
 */
export async function findGatewayClient(
  clients: ClientFinder,
  clientId: string,
  gatewayId: string,
): Promise<OAuthClient | null> {
  const registered = await clients.findOne({ where: { clientId, gatewayId, isActive: true } });
  if (registered) return registered;
  if (!isMetadataDocumentClientId(clientId)) return null;
  return clients.findOne({ where: { clientId, isMetadataDocument: true, isActive: true } });
}

/**
 * The application_type a Dynamic Client Registration request registers as.
 *
 * Sent: it must be `web` or `native`. Omitted: OIDC's default is `web`, but
 * nearly every MCP client that predates SEP-837 is a CLI or desktop app
 * that registers loopback redirect URIs and no type. Unless
 * MCP_OAUTH_INFER_APPLICATION_TYPE=false, an all-loopback registration
 * without a type is therefore taken as `native`, so those clients keep
 * signing in; anything else is `web`.
 */
export function registrationApplicationType(dto: { application_type?: unknown; redirect_uris?: unknown }): OAuthApplicationType {
  if (dto.application_type === undefined || dto.application_type === null) {
    const uris = Array.isArray(dto.redirect_uris) ? dto.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    return inferApplicationType() && allLoopbackRedirects(uris) ? 'native' : 'web';
  }
  if (isApplicationType(dto.application_type)) return dto.application_type;
  throw new BadRequestException('application_type must be "web" or "native"');
}
