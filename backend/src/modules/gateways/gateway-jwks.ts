import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { assertOutboundUrlAllowed, safeFetch } from '../../common/security/safe-fetch';
export function validateGatewayJwtConfiguration(config: any): void {
  if (!config || typeof config.issuer !== 'string' || !config.issuer || typeof config.audience !== 'string' || !config.audience) throw new Error('Tokens from your system need an issuer and audience');
  const uri = config.jwksUrl ?? config.jwksUri;
  if (typeof uri !== 'string' || new URL(assertOutboundUrlAllowed(uri)).protocol !== 'https:') throw new Error('Enter an HTTPS URL for your public signing keys');
  if (config.issuer.length > 2048 || config.audience.length > 512) throw new Error('Issuer or audience is too long');
}
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyGatewayJwt(token: string, config: any, fetcher: typeof safeFetch = safeFetch) {
  validateGatewayJwtConfiguration(config);
  if (!token || token.length > 32768) throw new Error('Invalid token');
  const uri = config.jwksUrl ?? config.jwksUri;
  let keys = fetcher === safeFetch ? keySets.get(uri) : undefined;
  if (!keys) {
    keys = createRemoteJWKSet(new URL(uri), { [customFetch]: (url, options) => fetcher(String(url), { ...options, maxBytes: 262144, timeoutMs: 10000 }), timeoutDuration: 10000, cacheMaxAge: 60000 });
    if (fetcher === safeFetch) { if (keySets.size >= 128) keySets.delete(keySets.keys().next().value); keySets.set(uri, keys); }
  }
  const { payload } = await jwtVerify(token, keys, { issuer: config.issuer, audience: config.audience, algorithms: ['RS256', 'PS256', 'ES256'], requiredClaims: ['sub', 'exp'], clockTolerance: 5 });
  return payload;
}
