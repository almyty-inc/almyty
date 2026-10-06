import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { CompanySigninService } from '../company-signin.service';
import { GatewayAuthType } from '../../../entities/gateway-auth.entity';
let mockFetch: jest.Mock;
jest.mock('../../../common/security/safe-fetch', () => ({ ...jest.requireActual('../../../common/security/safe-fetch'), safeFetch: (...args: any[]) => mockFetch(...args) }));
describe('company OIDC browser flow', () => {
 let service: CompanySigninService, gateway: any, auth: any, req: any, res: any, values: Map<string, string>, pending: any;
 let wrongNonce = false, wrongSignature = false;
 beforeEach(async () => {
  values = new Map(); wrongNonce = false; wrongSignature = false;
  const keys = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(keys.publicKey);
  Object.assign(publicJwk, { alg: 'RS256', kid: 'one', use: 'sig' });
  auth = { id: 'auth', gatewayId: 'gateway', isActive: true, type: GatewayAuthType.COMPANY_SIGNIN, configuration: { issuer: 'https://id.example', clientId: 'client', credentialId: 'secret-id', scopes: ['openid', 'email'], configVersion: 'v1', authorizationEndpoint: 'https://id.example/authorize', tokenEndpoint: 'https://id.example/token', jwksUri: 'https://id.example/keys', allowedEmailDomains: ['example.com'], allowedGroups: ['staff'], groupsClaim: 'groups' } };
  gateway = { id: 'gateway', organizationId: 'org', status: 'active', accessScope: 'external_protected', name: 'Example', authConfigs: [auth] }; auth.gateway = gateway;
  const redis = { set: jest.fn(async (key: string, value: string) => { values.set(key, value); if (key.startsWith('company:state:')) pending = JSON.parse(value); return 'OK'; }), get: jest.fn(async (key: string) => values.get(key)), getdel: jest.fn(async (key: string) => { const value = values.get(key); values.delete(key); return value; }) };
  service = new CompanySigninService({ findOne: async () => gateway } as any, { findOne: async () => auth.isActive ? auth : null } as any, { findOne: async () => null } as any, redis, { resolve: async () => ({ config: { client_secret: 'secret' } }) } as any);
  req = { cookies: {}, query: {} }; res = { cookie: jest.fn((name: string, value: string) => { req.cookies[name] = value; }) };
  mockFetch = jest.fn(async (url: string) => {
   if (url.endsWith('/keys')) return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
   if (url.endsWith('/token')) {
    const idToken = await new SignJWT({ nonce: wrongNonce ? 'incorrect' : pending.nonce, email: 'person@example.com', email_verified: true, groups: ['staff'] }).setProtectedHeader({ alg: 'RS256', kid: 'one' }).setIssuer('https://id.example').setAudience('client').setSubject('employee').setIssuedAt().setExpirationTime('5m').sign(wrongSignature ? (await generateKeyPair('RS256')).privateKey : keys.privateKey);
    return new Response(JSON.stringify({ access_token: 'provider-token', token_type: 'Bearer', expires_in: 300, id_token: idToken }), { headers: { 'content-type': 'application/json' } });
   }
   throw new Error('Unexpected outbound request');
  });
 });
 it('uses S256, nonce, browser binding, verified signature and single-use state', async () => {
  const destination = new URL(await service.begin('gateway', req, res));
  expect(destination.searchParams.get('code_challenge_method')).toBe('S256');
  expect(destination.searchParams.get('nonce')).toBeTruthy();
  req.query = { state: destination.searchParams.get('state'), code: 'code' };
  const result = await service.finish('gateway', req);
  expect(result.grant.subject).toBe('employee');
  const token = await service.issue('gateway', result.grant);
  expect(await service.validateToken('gateway', 'Bearer ' + token)).toEqual(result.grant);
  auth.isActive = false;
  expect(await service.validateToken('gateway', 'Bearer ' + token)).toBeNull();
  await expect(service.finish('gateway', req)).rejects.toThrow('Sign-in expired');
 });
 it('rejects callback from another browser before exchanging a code', async () => {
  const url = new URL(await service.begin('gateway', req, res));
  await expect(service.finish('gateway', { cookies: {}, query: { state: url.searchParams.get('state'), code: 'code' } })).rejects.toThrow('Sign-in expired');
  expect(mockFetch).not.toHaveBeenCalled();
 });
 it.each(['nonce', 'signature'])('rejects a wrong %s from the provider', async (failure) => {
  const url = new URL(await service.begin('gateway', req, res));
  wrongNonce = failure === 'nonce'; wrongSignature = failure === 'signature';
  req.query = { state: url.searchParams.get('state'), code: 'code' };
  await expect(service.finish('gateway', req)).rejects.toThrow();
 });
 it('binds consent to the browser, original client and resource and consumes it once', async () => {
  const oauth = { clientId: 'mcp-client', redirectUri: 'https://client.example/callback', codeChallenge: 'challenge', codeChallengeMethod: 'S256', resource: 'https://api.example/resource', state: 'client-state' };
  const url = new URL(await service.begin('gateway', req, res, oauth));
  req.query = { state: url.searchParams.get('state'), code: 'code' };
  const result = await service.finish('gateway', req);
  const ticket = await service.consent('gateway', result);
  const saved = await service.takeConsent('gateway', ticket, req);
  expect(saved.oauth).toEqual(oauth);
  await expect(service.takeConsent('gateway', ticket, req)).rejects.toThrow('Consent expired');
 });
 it('invalidates grants on provider changes and wrong gateway', async () => {
  const grant = { authConfigId: 'auth', configVersion: 'v1', subject: 'employee', expiresAt: Date.now() + 1000 };
  auth.configuration.configVersion = 'v2';
  expect(await service.validGrant('gateway', grant)).toBe(false);
  const token = await service.issue('gateway', grant);
  expect(await service.validateToken('other', 'Bearer ' + token)).toBeNull();
 });
});
