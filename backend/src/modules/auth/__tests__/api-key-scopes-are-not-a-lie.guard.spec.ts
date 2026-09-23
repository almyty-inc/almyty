import { readFileSync } from 'fs';
import { join } from 'path';
import { UnauthorizedException } from '@nestjs/common';

import { ApiKeyStrategy } from '../strategies/api-key.strategy';

/**
 * An API key never claims an attenuation nothing enforces.
 *
 * `api_keys` holds two populations. Gateway keys (`gw_...`, gatewayId
 * set) are minted per gateway and their scopes ARE checked, against
 * `gateway_tools.permissions.requiredScopes` before dispatch. Platform
 * keys (`almyty_...`, gatewayId null) authenticate through
 * ApiKeyStrategy, which is one half of JwtAuthGuard, and act as their
 * user on the whole dashboard API. Nothing on that path read
 * `ApiKey.scopes` or `ApiKey.rateLimits`.
 *
 * Two consequences, both live:
 *   1. A platform key created with scopes ['read'] answered DELETE.
 *   2. ApiKeyStrategy resolved a key by hash alone, and extractApiKey
 *      only enforces the `almyty_` prefix on the Bearer form -- X-API-Key
 *      and ?api_key= take anything. So a gateway key, handed to a
 *      third-party MCP client to call ONE gateway, also authenticated as
 *      its minting user across the entire organization.
 *
 * Part of this guard is textual. The defect is an ABSENT check: a unit
 * test of a strategy that ignores a field passes exactly as well as a
 * unit test of one that honours it, which is how this survived. Reading
 * the source pins the refusal at the mint site too, where there is no
 * cheap way to instantiate the service.
 */
describe('api key scopes and rate limits are not a lie', () => {
  const src = (rel: string) =>
    readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8');

  const buildStrategy = (key: any) =>
    new ApiKeyStrategy({ validateApiKey: async () => key } as any);

  const request = (apiKey: string) =>
    ({ headers: { 'x-api-key': apiKey }, query: {} }) as any;

  const platformUser = {
    id: 'user-1',
    organizationMemberships: [
      { organizationId: 'org-1', isActive: true, role: 'owner', organization: { id: 'org-1', name: 'Org' } },
    ],
  };

  describe('ApiKeyStrategy refuses what it cannot honour', () => {
    it('refuses a gateway key on the platform API', async () => {
      const strategy = buildStrategy({
        id: 'k1',
        organizationId: 'org-1',
        gatewayId: 'gw-1',
        scopes: ['gateway:use'],
        user: platformUser,
      });

      await expect(strategy.validate(request('gw_abc'))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses a platform key that carries scopes', async () => {
      const strategy = buildStrategy({
        id: 'k2',
        organizationId: 'org-1',
        gatewayId: null,
        scopes: ['read'],
        user: platformUser,
      });

      await expect(strategy.validate(request('almyty_abc'))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('still admits an ordinary platform key', async () => {
      const strategy = buildStrategy({
        id: 'k3',
        organizationId: 'org-1',
        gatewayId: null,
        scopes: null,
        user: platformUser,
      });

      const user: any = await strategy.validate(request('almyty_abc'));
      expect(user.currentOrganizationId).toBe('org-1');
    });
  });

  describe('the source still carries the refusals', () => {
    it('ApiKeyStrategy rejects on gatewayId and on scopes', () => {
      const source = src('modules/auth/strategies/api-key.strategy.ts');
      expect(source).toMatch(/if\s*\(\s*validApiKey\.gatewayId\s*\)/);
      expect(source).toMatch(/if\s*\(\s*validApiKey\.scopes\?\.length\s*\)/);
    });

    it('createApiKey refuses to mint scopes or rate limits, and stores neither', () => {
      const source = src('modules/auth/auth.service.ts');
      const at = source.indexOf('async createApiKey(');
      expect(at).toBeGreaterThan(-1); // update this guard if it moved

      const body = source.slice(at, source.indexOf('async revokeApiKey(', at));
      expect(body).toMatch(/if\s*\(\s*createApiKeyDto\.scopes\?\.length\s*\)/);
      expect(body).toMatch(/if\s*\(\s*createApiKeyDto\.rateLimits\s*\)/);
      expect(body).toContain('BadRequestException');
      // And the persisted row carries neither, so a future edit to the
      // guards above cannot quietly start storing them again.
      expect(body).not.toMatch(/scopes:\s*createApiKeyDto\.scopes/);
      expect(body).not.toMatch(/rateLimits:\s*createApiKeyDto\.rateLimits/);
    });

    it('the gateway side, which does enforce scopes, is untouched', () => {
      // The counter-example that makes the platform side an omission
      // rather than a policy: gateway keys carry scopes THROUGH to a
      // check. If this ever stops holding, the entity comment is wrong.
      expect(src('modules/gateways/gateway-protocol.service.ts')).toContain(
        'scopes: request.scopes ?? []',
      );
      expect(src('common/security/gateway-tool-permissions.ts')).toContain('requiredScopes');
    });
  });
});
