import { BadRequestException } from '@nestjs/common';

import { validatePolicyRule } from '../connection-policy.rules';

function errorsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const body = (e as BadRequestException).getResponse() as any;
    expect(body.code).toBe('CONNECTION_POLICY_INVALID');
    return body.errors ?? [body.message];
  }
  throw new Error('expected a CONNECTION_POLICY_INVALID error');
}

describe('validatePolicyRule', () => {
  it('rejects unknown kinds and non-object rules', () => {
    expect(errorsOf(() => validatePolicyRule('nope' as any, {}))[0]).toContain('kind must be one of');
    expect(errorsOf(() => validatePolicyRule('connector_allowlist', null))[0]).toBe('rule must be an object');
    expect(errorsOf(() => validatePolicyRule('connector_allowlist', []))[0]).toBe('rule must be an object');
  });

  describe('connector_allowlist / connector_denylist', () => {
    it('normalises keys and owners', () => {
      expect(validatePolicyRule('connector_allowlist', { connectorKeys: [' openai ', 'openai', 'anthropic'] })).toEqual({ connectorKeys: ['openai', 'anthropic'] });
      expect(validatePolicyRule('connector_denylist', { connectorKeys: ['x'], owners: ['user', 'user'] })).toEqual({ connectorKeys: ['x'], owners: ['user'] });
    });

    it('requires at least one key and valid owners', () => {
      expect(errorsOf(() => validatePolicyRule('connector_allowlist', {}))).toContain('connectorKeys is required');
      expect(errorsOf(() => validatePolicyRule('connector_allowlist', { connectorKeys: [] }))).toContain('connectorKeys must name at least one connector');
      expect(errorsOf(() => validatePolicyRule('connector_allowlist', { connectorKeys: ['a', ''] }))).toContain('connectorKeys must contain non-empty unique strings');
      expect(errorsOf(() => validatePolicyRule('connector_denylist', { connectorKeys: ['a'], owners: ['team'] }))[0]).toContain('owners must be');
    });
  });

  describe('scope_rule', () => {
    it('normalises principal kinds and environments', () => {
      expect(validatePolicyRule('scope_rule', { principalKinds: ['agent', 'agent', 'workspace'], environments: ['Production ', 'staging'], requireOwner: 'org', approvedConnectorsOnly: true }))
        .toEqual({ principalKinds: ['agent', 'workspace'], environments: ['production', 'staging'], requireOwner: 'org', approvedConnectorsOnly: true });
      expect(validatePolicyRule('scope_rule', { principalKinds: ['team'], requireOwner: 'org', approvedConnectorsOnly: false }))
        .toEqual({ principalKinds: ['team'], requireOwner: 'org' });
    });

    it('rejects unknown kinds, empty environments and other owners', () => {
      expect(errorsOf(() => validatePolicyRule('scope_rule', { principalKinds: [], requireOwner: 'org' }))[0]).toContain('principalKinds must be');
      expect(errorsOf(() => validatePolicyRule('scope_rule', { principalKinds: ['robot'], requireOwner: 'org' }))[0]).toContain('unknown kinds: robot');
      expect(errorsOf(() => validatePolicyRule('scope_rule', { principalKinds: ['agent'], environments: [], requireOwner: 'org' }))).toContain('environments must name at least one environment when set');
      expect(errorsOf(() => validatePolicyRule('scope_rule', { principalKinds: ['agent'], requireOwner: 'user' }))).toContain("requireOwner must be 'org'");
      expect(errorsOf(() => validatePolicyRule('scope_rule', { principalKinds: ['agent'], requireOwner: 'org', approvedConnectorsOnly: 'yes' }))).toContain('approvedConnectorsOnly must be a boolean');
    });
  });

  describe('expiry_rule', () => {
    it('accepts a well formed rule', () => {
      expect(validatePolicyRule('expiry_rule', { maxAgeDays: 90, warnDays: 7, enforce: true })).toEqual({ maxAgeDays: 90, warnDays: 7, enforce: true });
      expect(validatePolicyRule('expiry_rule', { maxAgeDays: 1, warnDays: 0, enforce: false })).toEqual({ maxAgeDays: 1, warnDays: 0, enforce: false });
    });

    it('rejects bad numbers, a warn window at or past the max, and a missing enforce flag', () => {
      expect(errorsOf(() => validatePolicyRule('expiry_rule', { maxAgeDays: 0, warnDays: 0, enforce: true }))).toContain('maxAgeDays must be an integer >= 1');
      expect(errorsOf(() => validatePolicyRule('expiry_rule', { maxAgeDays: 30, warnDays: 30, enforce: true }))).toContain('warnDays must be smaller than maxAgeDays');
      expect(errorsOf(() => validatePolicyRule('expiry_rule', { maxAgeDays: 30, warnDays: 1.5, enforce: true }))).toContain('warnDays must be an integer >= 0');
      expect(errorsOf(() => validatePolicyRule('expiry_rule', { maxAgeDays: 30, warnDays: 3 }))).toContain('enforce must be a boolean');
    });
  });

  describe('rotation_rule', () => {
    it('accepts a well formed rule with optional connector keys', () => {
      expect(validatePolicyRule('rotation_rule', { everyDays: 30, requireProviderApi: true })).toEqual({ everyDays: 30, requireProviderApi: true });
      expect(validatePolicyRule('rotation_rule', { everyDays: 30, requireProviderApi: true, connectorKeys: ['openai'] })).toEqual({ everyDays: 30, requireProviderApi: true, connectorKeys: ['openai'] });
      expect(validatePolicyRule('rotation_rule', { everyDays: 30, requireProviderApi: true, connectorKeys: [] })).toEqual({ everyDays: 30, requireProviderApi: true });
    });

    it('insists on requireProviderApi: true and a positive cadence', () => {
      expect(errorsOf(() => validatePolicyRule('rotation_rule', { everyDays: 30, requireProviderApi: false }))).toContain('requireProviderApi must be true');
      expect(errorsOf(() => validatePolicyRule('rotation_rule', { everyDays: -1, requireProviderApi: true }))).toContain('everyDays must be an integer >= 1');
      expect(errorsOf(() => validatePolicyRule('rotation_rule', { everyDays: 30, requireProviderApi: true, connectorKeys: 'openai' }))).toContain('connectorKeys must be an array of connector keys');
    });
  });
});
