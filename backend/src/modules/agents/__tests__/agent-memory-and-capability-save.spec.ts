import { BadRequestException } from '@nestjs/common';
import { Agent } from '../../../entities/agent.entity';
import { Api } from '../../../entities/api.entity';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { Tool } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { orgMembersPolicy } from '../../../test/execution-access.fixture';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { AgentsService } from '../agents.service';

/**
 * Saving an agent's Memory and Capabilities sections: what the runtime
 * could not honour is refused with a sentence, the lists are tidied, and a
 * changed retention reaches what the agent already saved.
 */
describe('saving the memory and capabilities sections', () => {
  const service = () => {
    const agents = fakeRepository<Agent>({
      make: () => new Agent(),
      idPrefix: 'agent',
      seed: [
        {
          id: 'ag-1',
          name: 'Support',
          organizationId: 'org-1',
          mode: 'autonomous',
          visibility: 'org',
          createdBy: 'user-1',
          metadata: {},
          pipeline: { nodes: [], edges: [] },
          toolIds: [],
          memoryConfig: { enabled: true, retentionDays: 30 },
          agentConfig: {},
        } as any,
        { id: 'ag-billing', name: 'Billing', organizationId: 'org-1', mode: 'autonomous', visibility: 'org', createdBy: 'user-1', isTemporary: false, metadata: {} } as any,
        { id: 'ag-other-org', name: 'Elsewhere', organizationId: 'org-2', mode: 'autonomous', visibility: 'org', createdBy: 'user-9', isTemporary: false, metadata: {} } as any,
      ],
    });
    const apis = fakeRepository<Api>([{ id: 'api-orders', organizationId: 'org-1' }, { id: 'api-foreign', organizationId: 'org-2' }] as any);
    (agents as any).manager = {
      getRepository: (entity: unknown) =>
        entity === Api ? apis : entity === LlmProvider ? fakeRepository([]) : entity === Tool ? fakeRepository([]) : fakeRepository([]),
    };
    const memoryAccounts = {
      accounts: jest.fn(async () => [
        { id: 'almyty-native', name: "almyty's own memory", canExpire: true, expiresItself: true },
        { id: 'mem0', name: 'Mem0', canExpire: true, expiresItself: false },
        { id: 'vertex-memory-bank', name: 'Vertex AI Memory Bank', canExpire: false, expiresItself: false },
      ]),
      setAgentRetention: jest.fn(async () => undefined),
      describe: jest.fn((id: string) => (id === 'zep' ? { id: 'zep', name: 'Zep', canExpire: true, expiresItself: false } : null)),
    };
    // The connections: a team one, a private one of user-1's, and a key of another kind.
    const connections: Record<string, any> = {
      'cred-team': { id: 'cred-team', organizationId: 'org-1', type: 'memory_backend', visibility: 'team', teamId: 'team-1' },
      'cred-mine': { id: 'cred-mine', organizationId: 'org-1', type: 'memory_backend', visibility: 'private', ownerUserId: 'user-1' },
      'cred-llm': { id: 'cred-llm', organizationId: 'org-1', type: 'api_key', visibility: 'org' },
    };
    const credentialRefs = {
      load: jest.fn(async (_org: string, id: string) => {
        if (!connections[id]) throw new Error('credential not found');
        return connections[id];
      }),
      // The real rule, in short: a scoped connection only for a resource of the same scope.
      assertAttachable: jest.fn(async (row: any, target: any) => {
        if (row.visibility === 'private' && !(target.visibility === 'private' && target.ownerUserId === row.ownerUserId)) {
          throw new BadRequestException(`The connection is private to its owner, so nobody else who uses this ${target.noun} could use it.`);
        }
        if (row.visibility === 'team' && !(target.visibility === 'team' && target.teamId === row.teamId)) {
          throw new BadRequestException('The connection belongs to its team only.');
        }
      }),
    };
    const svc = new AgentsService(
      agents as any,
      {} as any,
      fakeRepository([{ id: 'org-1' }]) as any,
      {} as any,
      { log: async () => undefined } as any,
      { validatePipeline: () => undefined } as any,
      orgMembersPolicy('org-1', { 'user-1': OrganizationRole.MEMBER }) as any,
      { assertReady: async () => undefined } as any,
      memoryAccounts as any,
      credentialRefs as any,
    );
    return { svc, agents, memoryAccounts, credentialRefs };
  };

  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => {
        expect(e).toBeInstanceOf(BadRequestException);
        return e.message;
      },
    );

  it('stores a sound memory section as sent', async () => {
    const { svc, agents } = service();
    const memoryConfig = { enabled: true, account: 'mem0', whose: 'agent', save: 'facts', neverSave: 'payment details', retentionDays: 90 } as const;
    const saved = await svc.createAgent({ name: 'New', mode: 'autonomous', memoryConfig }, 'org-1', 'user-1');
    expect(agents.row(saved.id)!.memoryConfig).toEqual(memoryConfig);
  });

  it('refuses an account the organization has not set up, and one that cannot take a time limit', async () => {
    const { svc } = service();
    expect(await refusal(svc.createAgent({ name: 'x', mode: 'autonomous', memoryConfig: { enabled: true, account: 'zep' } }, 'org-1', 'user-1'))).toBe(
      'Invalid settings: The memory account "zep" is not set up for this organization. Set it up on the Memory page first',
    );
    expect(
      await refusal(
        svc.updateAgent('ag-1', { memoryConfig: { enabled: true, account: 'vertex-memory-bank', retentionDays: 7 } }, 'org-1', 'user-1'),
      ),
    ).toBe('Invalid settings: Vertex AI Memory Bank has no way to delete one memory, so its memories are kept until deleted there');
  });

  it('refuses agents to call and APIs to use that are not in this organization, and the agent itself', async () => {
    const { svc } = service();
    expect(
      await refusal(
        svc.updateAgent('ag-1', { agentConfig: { callableAgentIds: ['ag-billing', 'ag-other-org'], apiIds: ['api-orders', 'api-foreign'] } }, 'org-1', 'user-1'),
      ),
    ).toBe('Invalid settings: These agents are not in this organization: ag-other-org; These APIs are not in this organization: api-foreign');
    expect(await refusal(svc.updateAgent('ag-1', { agentConfig: { callableAgentIds: ['ag-1'] } }, 'org-1', 'user-1'))).toBe(
      'Invalid settings: An agent cannot call itself',
    );
  });

  it('keeps the old switch equal to the list, and drops repeats', async () => {
    const { svc, agents } = service();
    await svc.updateAgent(
      'ag-1',
      { agentConfig: { canCallAgents: false, callableAgentIds: ['ag-billing', 'ag-billing'], apiIds: ['api-orders'], canCreateAgents: true, maxTemporaryAgents: 2, maxTemporaryAgentsAlive: 4 } },
      'org-1',
      'user-1',
    );
    expect(agents.row('ag-1')!.agentConfig).toEqual({
      canCallAgents: true,
      callableAgentIds: ['ag-billing'],
      apiIds: ['api-orders'],
      canCreateAgents: true,
      maxTemporaryAgents: 2,
      maxTemporaryAgentsAlive: 4,
    });
  });

  it('applies a changed retention to what the agent already saved, and leaves it alone otherwise', async () => {
    const { svc, memoryAccounts } = service();
    await svc.updateAgent('ag-1', { memoryConfig: { enabled: true, retentionDays: 30 } }, 'org-1', 'user-1');
    expect(memoryAccounts.setAgentRetention).not.toHaveBeenCalled();
    await svc.updateAgent('ag-1', { memoryConfig: { enabled: true, retentionDays: 7 } }, 'org-1', 'user-1');
    expect(memoryAccounts.setAgentRetention).toHaveBeenCalledWith('org-1', 'ag-1', 7 * 86400);
    await svc.updateAgent('ag-1', { memoryConfig: { enabled: true, retentionDays: null } }, 'org-1', 'user-1');
    expect(memoryAccounts.setAgentRetention).toHaveBeenLastCalledWith('org-1', 'ag-1', null);
  });

  describe("an account of the agent's own (added from its page by whoever can edit it)", () => {
    it('is saved for any memory service, checked as usable by the agent and by whoever attaches it', async () => {
      const { svc, agents, credentialRefs } = service();
      const memoryConfig = { enabled: true, account: 'zep', credentialId: 'cred-mine' };
      const saved = await svc.createAgent({ name: 'Mine', mode: 'autonomous', visibility: 'private', memoryConfig }, 'org-1', 'user-1');
      expect(agents.row(saved.id)!.memoryConfig).toEqual(memoryConfig);
      expect(credentialRefs.assertAttachable).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cred-mine' }),
        { organizationId: 'org-1', visibility: 'private', teamId: null, ownerUserId: 'user-1', noun: 'agent' },
        { actorId: 'user-1' },
      );
    });

    it("refuses a connection the agent's scope does not cover: a private one on an org agent", async () => {
      const { svc } = service();
      expect(
        await refusal(svc.updateAgent('ag-1', { memoryConfig: { enabled: true, account: 'mem0', credentialId: 'cred-mine' } }, 'org-1', 'user-1')),
      ).toMatch(/private to its owner/);
    });

    it('checks it again when the agent changes scope', async () => {
      const { svc, agents } = service();
      const saved = await svc.createAgent(
        { name: 'Mine', mode: 'autonomous', visibility: 'private', memoryConfig: { enabled: true, account: 'mem0', credentialId: 'cred-mine' } },
        'org-1',
        'user-1',
      );
      expect(await refusal(svc.updateAgent(saved.id, { visibility: 'org' }, 'org-1', 'user-1'))).toMatch(/private to its owner/);
      expect(agents.row(saved.id)!.visibility).toBe('private');
    });

    it('refuses a connection that is not a memory account, one that does not exist, and one for almyty itself', async () => {
      const { svc } = service();
      const save = (memoryConfig: any) => refusal(svc.updateAgent('ag-1', { memoryConfig }, 'org-1', 'user-1'));
      expect(await save({ enabled: true, account: 'mem0', credentialId: 'cred-llm' })).toBe('Invalid settings: That connection is not a memory account');
      expect(await save({ enabled: true, account: 'mem0', credentialId: 'cred-gone' })).toBe('Invalid settings: The memory account connection was not found');
      expect(await save({ enabled: true, account: 'almyty-native', credentialId: 'cred-mine' })).toBe(
        "Invalid settings: almyty's own memory needs no account: choose the service the connection is for",
      );
    });
  });
});
