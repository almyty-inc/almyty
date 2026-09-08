import { describe, expect, it } from 'vitest';
import { chooseMethod, connectBody, formatConnection, grantBody, parseArgs, parseInput } from '../index';

describe('@almyty/connections', () => {
  it('parses commands, positionals and flags', () => {
    expect(parseArgs(['revoke', 'c1', 'g1', '--json'])).toEqual({ command: 'revoke', positional: ['c1', 'g1'], flags: { json: true } });
  });

  it('builds a connect body with owner, method and input, and refuses a bad owner', () => {
    expect(connectBody({ owner: 'user', method: 'api_key' }, { apiKey: 'k' })).toEqual({ owner: 'user', method: 'api_key', input: { apiKey: 'k' } });
    expect(connectBody({})).toEqual({ owner: 'org' });
    expect(() => connectBody({ owner: 'team' })).toThrow('--owner must be org or user');
  });

  it('parses --input as a JSON object only', () => {
    expect(parseInput({ input: '{"token":"t"}' })).toEqual({ token: 't' });
    expect(() => parseInput({ input: '[1]' })).toThrow('--input must be a JSON object');
    expect(parseInput({})).toBeUndefined();
  });

  it('chooses the best method by default and a named one when supported', () => {
    const connector = { key: 'openrouter', connect: [{ type: 'oauth2_pkce' }, { type: 'api_key' }] };
    expect(chooseMethod(connector).type).toBe('oauth2_pkce');
    expect(chooseMethod(connector, 'api_key').type).toBe('api_key');
    expect(() => chooseMethod(connector, 'cloud_iam')).toThrow('does not support cloud_iam');
  });

  it('builds a grant body and validates principal and permission', () => {
    expect(grantBody({ principal: 'agent', to: 'a1' })).toEqual({ principalType: 'agent', principalId: 'a1', permission: 'use' });
    expect(grantBody({ principal: 'role', to: 'admin', permission: 'manage', expires: '2027-01-01T00:00:00Z' })).toMatchObject({ permission: 'manage', expiresAt: '2027-01-01T00:00:00Z' });
    expect(() => grantBody({ principal: 'bot', to: 'x' })).toThrow('--principal must be');
    expect(() => grantBody({ principal: 'user', to: 'x', permission: 'own' })).toThrow('--permission must be');
  });

  it('formats a connection with account label and health error', () => {
    const line = formatConnection({ id: 'c1', connectorKey: 'openrouter', owner: 'user', accountLabel: 'ava@northwind', health: { status: 'expired', error: 'key revoked' } });
    expect(line).toContain('openrouter  user  ava@northwind  expired');
    expect(line).toContain('key revoked');
  });
});
