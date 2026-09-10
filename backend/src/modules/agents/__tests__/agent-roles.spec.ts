import { AgentRole } from '../../../entities/agent-role.entity';
import { AgentRolesService, RoleUnresolvedError, requirementToPolicy } from '../agent-roles.service';

/**
 * L4 gate, both clauses:
 *   an agent with every role pinned runs with routing disabled entirely;
 *   rebinding to a self-deployed fine-tune needs no graph edit.
 */
function role(key: string, binding: AgentRole['binding'], requirement: AgentRole['requirement'] = {}): AgentRole {
  return Object.assign(new AgentRole(), {
    id: `r-${key}`,
    organizationId: 'org',
    agentId: 'agent-1',
    key,
    displayName: key,
    requirement,
    binding,
  });
}

function makeService(roles: AgentRole[], router?: unknown): AgentRolesService {
  return new AgentRolesService({ find: async () => roles } as never, router as never);
}

/**
 * Worth recording: this is enforced by the type system as well as by the
 * tests below. RoleBinding is a discriminated union, so deleting the
 * pinned branch does not compile: `policy` does not exist on the pinned
 * variant. A pinned role reaching the router is unrepresentable, not
 * merely untested.
 */
describe('a pinned role never touches the router', () => {
  it('resolves every role with no router present at all', async () => {
    const service = makeService([
      role('principal', { mode: 'pinned', modelId: 'card-opus' }),
      role('verifier', { mode: 'pinned', modelId: 'card-haiku' }),
    ]);

    const resolved = await service.resolveRoles('org', 'agent-1');

    expect(resolved).toEqual([
      { key: 'principal', displayName: 'principal', modelId: 'card-opus', via: 'pinned' },
      { key: 'verifier', displayName: 'verifier', modelId: 'card-haiku', via: 'pinned' },
    ]);
  });

  it('does not call plan() even when a router is available', async () => {
    const plan = jest.fn();
    const service = makeService([role('principal', { mode: 'pinned', modelId: 'card-opus' })], { plan });

    await service.resolveRoles('org', 'agent-1');

    expect(plan).not.toHaveBeenCalled();
  });

  it('refuses a pinned role with no model rather than quietly routing instead', async () => {
    const service = makeService([role('principal', { mode: 'pinned', modelId: '' } as never)]);
    await expect(service.resolveRoles('org', 'agent-1')).rejects.toBeInstanceOf(RoleUnresolvedError);
  });
});

describe('rebinding is a binding change, not a graph edit', () => {
  it('fills the same role from a self-deployed model by changing only the binding', async () => {
    const before = await makeService([role('principal', { mode: 'pinned', modelId: 'card-frontier' })]).resolveRoles('org', 'agent-1');
    expect(before[0].modelId).toBe('card-frontier');

    // The only thing that changed is the binding. No node, no edge, no graph.
    const after = await makeService([role('principal', { mode: 'pinned', modelId: 'card-my-finetune' })]).resolveRoles('org', 'agent-1');
    expect(after[0].modelId).toBe('card-my-finetune');
    expect(after[0].key).toBe(before[0].key);
  });

  it('lets one run override a role without touching the agent', async () => {
    const service = makeService([role('principal', { mode: 'pinned', modelId: 'card-frontier' })]);
    const resolved = await service.resolveRoles('org', 'agent-1', { principal: 'card-experiment' });
    expect(resolved[0].modelId).toBe('card-experiment');
  });
});

describe('a resolved role goes through the router, and records why', () => {
  it('takes the head of the plan and keeps its rationale', async () => {
    const plan = jest.fn().mockResolvedValue({
      candidates: [{ modelId: 'card-cheap', rationale: 'cheapest ($1.50/M blended), rank 1' }],
      rejected: [],
    });
    const service = makeService([role('principal', { mode: 'resolved', policy: { objective: 'cheapest' } })], { plan });

    const resolved = await service.resolveRoles('org', 'agent-1');

    expect(resolved[0]).toMatchObject({ modelId: 'card-cheap', via: 'resolved', rationale: expect.stringContaining('cheapest') });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('says what was rejected when nothing satisfies the role', async () => {
    const plan = jest.fn().mockResolvedValue({
      candidates: [],
      rejected: [{ modelId: 'card-a', reason: 'privacy tier too public' }],
    });
    const service = makeService([role('principal', { mode: 'resolved', policy: {} })], { plan });

    await expect(service.resolveRoles('org', 'agent-1')).rejects.toThrow(/privacy tier too public/);
  });

  it('says so plainly when routing is not available on this install', async () => {
    const service = makeService([role('principal', { mode: 'resolved', policy: {} })]);
    await expect(service.resolveRoles('org', 'agent-1')).rejects.toThrow(/routing is not available/);
  });

  it('carries the role requirement into the policy it asks with', () => {
    const policy = requirementToPolicy(
      role('verifier', { mode: 'resolved', policy: {} }, { capabilities: { tools: true }, privacyTierCeiling: 'private_cloud', region: 'eu-central' }),
    );
    expect(policy).toEqual({ capabilities: { tools: true }, privacyTier: 'private_cloud', regions: ['eu-central'] });
  });
});
