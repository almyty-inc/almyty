import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';

import { OAuthClient } from '../../../entities/oauth-client.entity';

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
 * OAuth 2.1: redirect_uri must be https, or http on a loopback host, and
 * must not contain a fragment identifier.
 *
 * The scheme is checked first and on its own. This used to read "https,
 * or any scheme at all when the host is localhost", and a URL such as
 * `javascript://localhost/%0aalert(1)//` has host localhost: the consent
 * page hands the redirect to `window.location.href`, so a client could
 * register one and run script in the dashboard's origin the moment the
 * user clicked Approve or Deny.
 */
export function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new BadRequestException(`Invalid redirect_uri: ${uri}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('redirect_uri must use HTTPS (or HTTP on a loopback host)');
  }

  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new BadRequestException(
      'redirect_uri must use HTTPS (except for localhost)',
    );
  }

  if (parsed.hash) {
    throw new BadRequestException(
      'redirect_uri must not contain a fragment identifier',
    );
  }
}
