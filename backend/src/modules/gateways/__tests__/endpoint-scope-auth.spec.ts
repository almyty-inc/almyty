import passport = require('passport');
import { GatewayAuthService } from '../gateway-auth.service';
import { GatewayAuthType } from '../../../entities/gateway-auth.entity';
describe('endpoint scope precedes stored external credentials', () => {
 let gateway: any, validator: any, service: GatewayAuthService;
 beforeEach(() => {
  gateway = { id: 'gateway', organizationId: 'org', accessScope: 'external_protected' };
  validator = { validateAuthConfig: jest.fn(async () => ({ isValid: true })) };
  service = new GatewayAuthService({ find: async () => [] } as any, { findOne: async () => gateway } as any, {} as any, validator);
 });
 it('open endpoints need no credentials', async () => {
  gateway.accessScope = 'external_open';
  expect((await service.authenticateRequest('gateway', {}, {})).isValid).toBe(true);
  expect(validator.validateAuthConfig).not.toHaveBeenCalled();
 });
 it('protected endpoints fail closed before any methods are configured', async () => {
  expect((await service.authenticateRequest('gateway', {}, {})).isValid).toBe(false);
 });
 it('none and inactive methods never admit protected requests', async () => {
  const rows: any[] = [{ id: 'none', isRequired: true, isActive: true, type: GatewayAuthType.NONE, gateway }, { id: 'key', isRequired: true, isActive: false, type: GatewayAuthType.API_KEY, gateway }];
  expect((await service.authenticateRequest('gateway', {}, {}, undefined, undefined, rows)).isValid).toBe(false);
  expect(validator.validateAuthConfig).not.toHaveBeenCalled();
 });
 it('switching internal ignores the old key even when it is valid', async () => {
  gateway.accessScope = 'private';
  jest.spyOn(passport, 'authenticate').mockImplementation((_name: any, _options: any, callback: any) => ((_req: any) => callback(null, false)) as any);
  expect((await service.authenticateRequest('gateway', { 'x-api-key': 'old-key' }, {}, undefined, undefined, [{ isRequired: true, isActive: true, type: GatewayAuthType.API_KEY, gateway } as any])).isValid).toBe(false);
  expect(validator.validateAuthConfig).not.toHaveBeenCalled();
  jest.restoreAllMocks();
 });
});
