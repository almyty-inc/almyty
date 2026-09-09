import {
  approvedConnectors,
  evaluateConnect,
  evaluateUse,
  expiryActions,
  PolicyLike,
  principalKindsOf,
  rotationDue,
  secretSetAt,
} from '../policy-evaluator';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-08T03:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

const allow = (keys: string[], extra: Partial<{ owners: Array<'org' | 'user'>; enabled: boolean; id: string }> = {}): PolicyLike => ({
  id: extra.id ?? 'allow-1',
  kind: 'connector_allowlist',
  rule: extra.owners ? { connectorKeys: keys, owners: extra.owners } : { connectorKeys: keys },
  enabled: extra.enabled ?? true,
});
const denyList = (keys: string[], owners?: Array<'org' | 'user'>): PolicyLike => ({
  id: 'deny-1',
  kind: 'connector_denylist',
  rule: owners ? { connectorKeys: keys, owners } : { connectorKeys: keys },
  enabled: true,
});

describe('evaluateConnect', () => {
  it('allows everything when no list applies', () => {
    expect(evaluateConnect([], 'openai', 'org').allowed).toBe(true);
    expect(evaluateConnect([allow(['openai'], { enabled: false })], 'anthropic', 'org').allowed).toBe(true);
  });

  it('refuses a connector missing from the allow list and names the policy', () => {
    const decision = evaluateConnect([allow(['openai', 'anthropic'])], 'groq', 'org');
    expect(decision.allowed).toBe(false);
    expect(decision.policyId).toBe('allow-1');
    expect(decision.reason).toContain('groq');
    expect(evaluateConnect([allow(['openai'])], 'openai', 'user').allowed).toBe(true);
  });

  it('unions several allow lists', () => {
    const policies = [allow(['openai'], { id: 'a' }), allow(['anthropic'], { id: 'b' })];
    expect(evaluateConnect(policies, 'anthropic', 'org').allowed).toBe(true);
    expect(evaluateConnect(policies, 'groq', 'org').allowed).toBe(false);
  });

  it('scopes a list to the owners it names', () => {
    const policies = [allow(['openai'], { owners: ['user'] })];
    expect(evaluateConnect(policies, 'groq', 'org').allowed).toBe(true);
    expect(evaluateConnect(policies, 'groq', 'user').allowed).toBe(false);
  });

  it('lets a deny list win over an allow list', () => {
    const decision = evaluateConnect([allow(['openai']), denyList(['openai'])], 'openai', 'org');
    expect(decision.allowed).toBe(false);
    expect(decision.policyId).toBe('deny-1');
    expect(evaluateConnect([denyList(['openai'], ['user'])], 'openai', 'org').allowed).toBe(true);
  });
});

describe('principalKindsOf', () => {
  it('derives kinds from the run context and the grant that allowed it', () => {
    expect(principalKindsOf({ userId: 'u' })).toEqual(['user']);
    expect(principalKindsOf({ userId: 'u', agentId: 'a' })).toEqual(['agent']);
    expect(principalKindsOf({ userId: 'u' }, { agentId: 'a', workspaceId: 'w' })).toEqual(['agent', 'workspace']);
    expect(principalKindsOf({ userId: 'u' }, { via: { principalType: 'team' } })).toEqual(['team']);
    expect(principalKindsOf({ userId: 'u' }, { principalKinds: ['role', 'role'] })).toEqual(['role']);
  });
});

describe('evaluateUse (scope rules)', () => {
  const productionAgents: PolicyLike = {
    id: 'scope-1',
    kind: 'scope_rule',
    rule: { principalKinds: ['agent'], environments: ['production'], requireOwner: 'org', approvedConnectorsOnly: true },
    enabled: true,
  };
  const userConnection = { id: 'c1', connectorKey: 'openai', ownerUserId: 'u1' };
  const orgConnection = { id: 'c2', connectorKey: 'openai', ownerUserId: null };

  it('allows when no scope rule applies', () => {
    expect(evaluateUse([], userConnection, { userId: 'u1' }).allowed).toBe(true);
    expect(evaluateUse([productionAgents], userConnection, { userId: 'u1' }, { agentId: 'a', environment: 'staging' }).allowed).toBe(true);
    expect(evaluateUse([productionAgents], userConnection, { userId: 'u1' }, { agentId: 'a', environment: null }).allowed).toBe(true);
    expect(evaluateUse([productionAgents], userConnection, { userId: 'u1' }, { environment: 'production' }).allowed).toBe(true);
  });

  it('refuses a user-scoped connection for a production agent', () => {
    const decision = evaluateUse([productionAgents], userConnection, { userId: 'u1' }, { agentId: 'a', environment: 'Production' });
    expect(decision.allowed).toBe(false);
    expect(decision.policyId).toBe('scope-1');
    expect(decision.reason).toContain('organization-scoped');
  });

  it('requires an allow list when approvedConnectorsOnly is set', () => {
    const noList = evaluateUse([productionAgents], orgConnection, { userId: 'u1' }, { agentId: 'a', environment: 'production' });
    expect(noList.allowed).toBe(false);
    expect(noList.reason).toContain('no connector allow list');

    const listed = evaluateUse([productionAgents, allow(['openai'])], orgConnection, { userId: 'u1' }, { agentId: 'a', environment: 'production' });
    expect(listed.allowed).toBe(true);

    const unlisted = evaluateUse([productionAgents, allow(['anthropic'])], orgConnection, { userId: 'u1' }, { agentId: 'a', environment: 'production' });
    expect(unlisted.allowed).toBe(false);
    expect(unlisted.reason).toContain('openai');
  });

  it('applies a rule without environments to every environment, and to team grants', () => {
    const teams: PolicyLike = { id: 's2', kind: 'scope_rule', rule: { principalKinds: ['team', 'workspace'], requireOwner: 'org' }, enabled: true };
    expect(evaluateUse([teams], userConnection, { userId: 'u1' }, { via: { principalType: 'team' } }).allowed).toBe(false);
    expect(evaluateUse([teams], userConnection, { userId: 'u1' }, { workspaceId: 'w' }).allowed).toBe(false);
    expect(evaluateUse([teams], userConnection, { userId: 'u1' }, { agentId: 'a' }).allowed).toBe(true);
    expect(evaluateUse([{ ...teams, enabled: false }], userConnection, { userId: 'u1' }, { workspaceId: 'w' }).allowed).toBe(true);
  });

  it('approvedConnectors returns null without an allow list', () => {
    expect(approvedConnectors([])).toBeNull();
    expect([...approvedConnectors([allow(['a']), allow(['b'], { id: 'x' })])!].sort()).toEqual(['a', 'b']);
  });
});

describe('secretSetAt', () => {
  it('prefers the last rotation over creation', () => {
    expect(secretSetAt({ id: 'c', createdAt: daysAgo(100), metadata: { secretRotatedAt: daysAgo(3).toISOString() } })).toEqual(daysAgo(3));
    expect(secretSetAt({ id: 'c', createdAt: daysAgo(100), metadata: { rotatedAt: daysAgo(5) } })).toEqual(daysAgo(5));
    expect(secretSetAt({ id: 'c', createdAt: daysAgo(100) })).toEqual(daysAgo(100));
    expect(secretSetAt({ id: 'c', createdAt: 'nonsense' })).toBeNull();
  });
});

describe('expiryActions', () => {
  const expiry = (maxAgeDays: number, warnDays: number, enforce: boolean, id = 'exp'): PolicyLike => ({
    id, kind: 'expiry_rule', rule: { maxAgeDays, warnDays, enforce }, enabled: true,
  });
  const connections = [
    { id: 'fresh', connectorKey: 'openai', createdAt: daysAgo(10) },
    { id: 'warn', connectorKey: 'openai', createdAt: daysAgo(85) },
    { id: 'old', connectorKey: 'openai', ownerUserId: 'u1', createdAt: daysAgo(120) },
    { id: 'already', connectorKey: 'openai', createdAt: daysAgo(200), healthStatus: 'expired' },
    { id: 'rotated', connectorKey: 'openai', createdAt: daysAgo(200), metadata: { secretRotatedAt: daysAgo(1).toISOString() } },
  ];

  it('returns nothing without an expiry rule', () => {
    expect(expiryActions([], connections, now)).toEqual({ warn: [], expire: [], enforce: false });
  });

  it('splits connections into warn and expire by secret age', () => {
    const actions = expiryActions([expiry(90, 7, true)], connections, now);
    expect(actions.enforce).toBe(true);
    expect(actions.warn.map((a) => a.connectionId)).toEqual(['warn']);
    expect(actions.expire.map((a) => a.connectionId)).toEqual(['old']);
    const old = actions.expire[0];
    expect(old).toMatchObject({ ageDays: 120, maxAgeDays: 90, ownerUserId: 'u1', policyId: 'exp' });
    expect(old.expiresOn).toEqual(new Date(daysAgo(120).getTime() + 90 * DAY));
  });

  it('uses the strictest rule and its enforce flag', () => {
    const actions = expiryActions([expiry(90, 7, true, 'loose'), expiry(30, 5, false, 'strict')], connections, now);
    expect(actions.enforce).toBe(false);
    expect(actions.expire.map((a) => a.connectionId).sort()).toEqual(['old', 'warn']);
    expect(actions.expire.every((a) => a.policyId === 'strict')).toBe(true);
  });
});

describe('rotationDue', () => {
  const rotation = (everyDays: number, connectorKeys?: string[], id = 'rot'): PolicyLike => ({
    id, kind: 'rotation_rule', rule: connectorKeys ? { everyDays, requireProviderApi: true, connectorKeys } : { everyDays, requireProviderApi: true }, enabled: true,
  });
  const connections = [
    { id: 'fresh', connectorKey: 'openai', createdAt: daysAgo(3) },
    { id: 'due-api', connectorKey: 'openai', createdAt: daysAgo(40) },
    { id: 'due-manual', connectorKey: 'anthropic', ownerUserId: 'u1', createdAt: daysAgo(40) },
    { id: 'plain', connectorKey: null, createdAt: daysAgo(400) },
  ];

  it('returns nothing without a rotation rule', () => {
    expect(rotationDue([], connections, { openai: true }, now)).toEqual({ due: [], manual: [] });
  });

  it('splits due connections by provider API capability', () => {
    const result = rotationDue([rotation(30)], connections, { openai: true }, now);
    expect(result.due.map((c) => c.connectionId)).toEqual(['due-api']);
    expect(result.manual.map((c) => c.connectionId)).toEqual(['due-manual']);
    expect(result.due[0]).toMatchObject({ ageDays: 40, everyDays: 30, policyId: 'rot', connectorKey: 'openai' });
  });

  it('honours connectorKeys on the rule and picks the strictest match', () => {
    const policies = [rotation(60, undefined, 'all'), rotation(30, ['anthropic'], 'anthropic-only')];
    const result = rotationDue(policies, connections, (key) => key === 'anthropic', now);
    expect(result.due.map((c) => c.connectionId)).toEqual(['due-manual']);
    expect(result.due[0].policyId).toBe('anthropic-only');
    expect(result.manual).toEqual([]);
  });
});
