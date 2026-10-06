import { missingOAuthScope } from '../../mcp/services/mcp-oauth-scope';
import { createHash } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { fakeRepository } from '../../../test/fake-repository';
import { GatewayAuthValidators } from '../gateway-auth-validators.helper';
import { McpOAuthTokensHelper } from '../../mcp/services/mcp-oauth-tokens.helper';
import passport = require('passport');
import { GatewayAuthService } from '../gateway-auth.service';
describe('internal MCP opaque OAuth admission', () => {
 afterEach(() => jest.restoreAllMocks());
 async function authenticate(identity: any, allowed = true) {
  jest.spyOn(passport, 'authenticate').mockImplementation((_name: any, _options: any, callback: any) => ((_req: any) => callback(null, false)) as any);
  const gateway = { id: 'gateway', organizationId: 'org', accessScope: 'team', accessTeamId: 'team' };
  const policy = { canAccess: jest.fn(async () => ({ allowed })) };
  const validator = { validateOAuth2: jest.fn(async () => identity) };
  const service = new GatewayAuthService({ find: async () => [] } as any, { findOne: async () => gateway } as any, {} as any, validator as any, policy as any);
  const result = await service.authenticateRequest('gateway', { authorization: 'Bearer opaque' }, {});
  return { result, validator, policy };
 }
 it('exchanges a real PKCE-bound code then admits its opaque token without any auth method row', async () => {
  jest.spyOn(passport, 'authenticate').mockImplementation((_name: any, _options: any, callback: any) => ((_req: any) => callback(null, false)) as any);
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const gateway = { id: 'gateway', organizationId: 'org', accessScope: 'org' };
  const users = fakeRepository<any>([{ id: 'member', isActive: true, organizationMemberships: [{ organizationId: 'org', isActive: true }] }]);
  const clients = fakeRepository<any>([{ id: 'client-row', clientId: 'client', gatewayId: 'gateway', organizationId: 'org', isActive: true, tokenEndpointAuthMethod: 'none' }]);
  const codes = fakeRepository<any>([{ id: 'code', codeHash: sha('approved-code'), clientId: 'client', userId: 'member', gatewayId: 'gateway', organizationId: 'org', redirectUri: 'https://client.example/callback', resource: 'https://api.example/gateway', scope: 'mcp:tools', codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256', expiresAt: new Date(Date.now() + 60000), isUsed: false }]);
  const tokens = fakeRepository<any>({ idPrefix: 'token' });
  const helper = new McpOAuthTokensHelper(clients as any, codes as any, tokens as any, users as any);
  const pair = await helper.exchangeCode('approved-code', 'client', verifier, 'https://client.example/callback', 'gateway', undefined, 'https://api.example/gateway');
  const gateways = fakeRepository<any>([gateway]);
  const validator = new GatewayAuthValidators(gateways as any, users as any, fakeRepository<any>() as any, tokens as any, new JwtService());
  const service = new GatewayAuthService({ find: async () => [] } as any, gateways as any, {} as any, validator, { canAccess: async () => ({ allowed: true }) } as any);
  const result = await service.authenticateRequest('gateway', { authorization: 'Bearer ' + pair.access_token }, {});
  expect(result.isValid).toBe(true); expect(result.scopes).toEqual(['mcp:tools']);
  expect(missingOAuthScope('mcp', result, { method: 'tools/list' })).toBeNull();
  expect(missingOAuthScope('mcp', result, { method: 'resources/list' })).toBe('mcp:resources');
  expect(tokens.rows().find(row => row.tokenType === 'access').resource).toBe('https://api.example/gateway');
  await expect(helper.exchangeCode('approved-code', 'client', verifier, 'https://client.example/callback', 'gateway')).rejects.toThrow('already been used');
  expect((await service.authenticateRequest('gateway', { authorization: 'Bearer ' + pair.access_token }, {})).isValid).toBe(false);
 });
 it('accepts a validated opaque consent token without an auth row and preserves scopes', async () => {
  const identity = { isValid: true, userId: 'member', organizationId: 'org', metadata: { authMethod: 'oauth2', scopes: ['mcp:tools:read'] } };
  const { result, policy } = await authenticate(identity);
  expect(result).toEqual(identity);
  expect(policy.canAccess).toHaveBeenCalledWith({ id: 'member' }, expect.objectContaining({ visibility: 'team', teamId: 'team' }), 'use');
 });
 it('refuses revoked or expired opaque tokens', async () => { expect((await authenticate({ isValid: false })).result.isValid).toBe(false); });
 it('refuses an otherwise valid OAuth holder outside the endpoint team', async () => { expect((await authenticate({ isValid: true, userId: 'member', metadata: { authMethod: 'oauth2' } }, false)).result.isValid).toBe(false); });
 it('does not accept the OAuth validator legacy API-key fallback internally', async () => { expect((await authenticate({ isValid: true, userId: 'member', metadata: { authMethod: 'api_key' } })).result.isValid).toBe(false); });
});
