import { ForbiddenException } from '@nestjs/common';

import { ConnectionsGovernanceHookImpl } from '../connections-governance.hook';

function build(licensed = true) {
  const governance = {
    decideConnect: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
    decideUse: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
    assertBudget: jest.fn().mockResolvedValue(undefined),
  };
  const licenses = { hasForOrg: jest.fn().mockResolvedValue(licensed) };
  return { hook: new ConnectionsGovernanceHookImpl(governance as any, licenses as any), governance, licenses };
}

const connection = { id: 'c1', ownerUserId: 'u1', connectorKey: 'openai' };

describe('ConnectionsGovernanceHookImpl', () => {
  it('is inert for an org without the entitlement', async () => {
    const { hook, governance, licenses } = build(false);
    await hook.beforeConnect('org-1', 'openai', 'user');
    await hook.beforeUse('org-1', connection, { userId: 'u1' }, {}, { via: 'grant', grant: { budgetId: 'b1' } });
    expect((await hook.evaluateUse('org-1', connection, { userId: 'u1' })).allowed).toBe(true);
    expect(licenses.hasForOrg).toHaveBeenCalledWith('org-1', 'connections_governance');
    expect(governance.decideConnect).not.toHaveBeenCalled();
    expect(governance.decideUse).not.toHaveBeenCalled();
    expect(governance.assertBudget).not.toHaveBeenCalled();
  });

  it('treats a failing license lookup as unlicensed', async () => {
    const { hook, governance, licenses } = build();
    licenses.hasForOrg.mockRejectedValue(new Error('db down'));
    await hook.beforeConnect('org-1', 'openai', 'org');
    expect(governance.decideConnect).not.toHaveBeenCalled();
  });

  it('beforeConnect refuses with CONNECTION_POLICY_DENIED', async () => {
    const { hook, governance } = build();
    governance.decideConnect.mockResolvedValue({ allowed: false, reason: 'not on the allow list', policyId: 'p1' });
    await expect(hook.beforeConnect('org-1', 'groq', 'org')).rejects.toMatchObject({
      response: { code: 'CONNECTION_POLICY_DENIED', reason: 'not on the allow list', policyId: 'p1', connectorKey: 'groq', owner: 'org' },
    });
    expect(governance.decideConnect).toHaveBeenCalledWith('org-1', 'groq', 'org');
  });

  it('beforeUse passes the grant principal type as via and refuses on a scope rule', async () => {
    const { hook, governance } = build();
    await hook.beforeUse('org-1', connection, { userId: 'u1' }, { agentId: 'a1' }, { via: 'grant', grant: { id: 'g1', principalType: 'team' } });
    expect(governance.decideUse).toHaveBeenCalledWith('org-1', connection, { userId: 'u1' }, { agentId: 'a1', via: { principalType: 'team' } });

    governance.decideUse.mockResolvedValue({ allowed: false, reason: 'production agents only use org connections', policyId: 's1' });
    const error = await hook.beforeUse('org-1', connection, { userId: 'u1' }, { agentId: 'a1' }).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({ code: 'CONNECTION_POLICY_DENIED', policyId: 's1', connectionId: 'c1' });
  });

  it('beforeUse enforces the grant budget only for grant-backed uses', async () => {
    const { hook, governance } = build();
    await hook.beforeUse('org-1', connection, { userId: 'u1', agentId: 'a9' }, {}, { via: 'grant', grant: { id: 'g1', budgetId: 'b1' } });
    expect(governance.assertBudget).toHaveBeenCalledWith('org-1', 'b1', 'a9');
    governance.assertBudget.mockClear();
    await hook.beforeUse('org-1', connection, { userId: 'u1' }, {}, { via: 'owner', grant: { id: 'g1', budgetId: 'b1' } });
    await hook.beforeUse('org-1', connection, { userId: 'u1' }, {}, { via: 'grant', grant: { id: 'g1', budgetId: null } });
    expect(governance.assertBudget).not.toHaveBeenCalled();
  });
});
