import { CredentialsService } from '../credentials.service';
import { Credential, CredentialType } from '../../../entities/credential.entity';
import { ApiKey } from '../../../entities/api-key.entity';
import { Api } from '../../../entities/api.entity';
import { Tool } from '../../../entities/tool.entity';
import { LlmProvider } from '../../../entities/llm-provider.entity';
import { McpSource } from '../../../entities/mcp-source.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { ChannelInstallation } from '../../../entities/channel-installation.entity';
import { AgentChannel } from '../../../entities/agent-channel.entity';
import { Agent } from '../../../entities/agent.entity';
import { ExternalAgent } from '../../../entities/external-agent.entity';
import { Environment } from '../../../entities/environment.entity';
import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { PushSubscription } from '../../../entities/push-subscription.entity';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';

/**
 * "Used by" on Credentials came from the stored `credentials.usedBy`
 * column, which nothing writes for a connection, so a Gmail sign-in that
 * APIs sign in with read "Nothing yet" and its delete said "Nothing uses
 * it yet". It is now worked out on every read from what points at it.
 */
describe('a credential says what uses it', () => {
  const ORG = 'org-1';
  const OTHER = 'org-2';
  const ME = 'user-1';
  const cred = (id: string, over: Record<string, any> = {}) => ({ id, organizationId: ORG, name: id, type: CredentialType.OAUTH2, config: {}, visibility: 'org', usedBy: null, ...over });

  function build(seed: Record<string, any[]>) {
    const repos = {
      credentials: fakeRepository<any>({ seed: seed.credentials ?? [], make: () => new Credential() }),
      apis: fakeRepository<any>(seed.apis ?? []),
      tools: fakeRepository<any>(seed.tools ?? []),
      providers: fakeRepository<any>(seed.providers ?? []),
      mcp: fakeRepository<any>(seed.mcp ?? []),
      gateways: fakeRepository<any>(seed.gateways ?? []),
      installations: fakeRepository<any>(seed.installations ?? []),
      channels: fakeRepository<any>(seed.channels ?? []),
      agents: fakeRepository<any>(seed.agents ?? []),
      external: fakeRepository<any>(seed.external ?? []),
      environments: fakeRepository<any>(seed.environments ?? []),
      deployments: fakeRepository<any>(seed.deployments ?? []),
      push: fakeRepository<any>(seed.push ?? []),
    };
    fakeManager([
      [Credential, repos.credentials],
      [Api, repos.apis],
      [Tool, repos.tools],
      [LlmProvider, repos.providers],
      [McpSource, repos.mcp],
      [Gateway, repos.gateways],
      [ChannelInstallation, repos.installations],
      [AgentChannel, repos.channels],
      [Agent, repos.agents],
      [ExternalAgent, repos.external],
      [Environment, repos.environments],
      [ModelDeployment, repos.deployments],
      [PushSubscription, repos.push],
    ]);
    // The read rule: everything readable but rows marked private to someone else.
    const accessPolicy = {
      canAccess: jest.fn(async (_u: any, row: any) => ({ allowed: !(row.visibility === 'private' && row.ownerUserId !== ME && row.createdBy !== ME), reason: '' })),
      applyListFilter: jest.fn(async (qb: any) => qb),
    };
    // findAll's own list query goes through a query builder; hand back the org's rows.
    (repos.credentials as any).createQueryBuilder = () => ({
      orderBy() { return this; },
      getMany: async () => (await repos.credentials.find({ where: { organizationId: ORG } })),
    });
    (repos.providers as any).createQueryBuilder = () => ({ getMany: async () => [] });
    const service = new CredentialsService(
      repos.credentials as any,
      fakeRepository<any>({ make: () => new ApiKey() }) as any,
      repos.providers as any,
      repos.apis as any,
      repos.gateways as any,
      repos.agents as any,
      { log: jest.fn() } as any,
      accessPolicy as any,
      makeEnvelopeCryptoMock(),
    );
    return { service };
  }

  it('a Gmail sign-in lists the APIs that sign in with it, from either side of the binding', async () => {
    const { service } = build({
      credentials: [cred('gmail', { connectorKey: 'google' }), cred('spare'), cred('bound', { type: CredentialType.API_KEY, apiId: 'api-weather' })],
      apis: [
        { id: 'api-gmail', organizationId: ORG, name: 'Gmail', visibility: 'org', authentication: { type: 'oauth2', config: { connectionId: 'gmail' } } },
        { id: 'api-cal', organizationId: ORG, name: 'Calendar', visibility: 'org', authentication: { type: 'oauth2', config: { credentialId: 'gmail' } } },
        { id: 'api-weather', organizationId: ORG, name: 'Weather', visibility: 'org', authentication: { type: 'apiKey', config: {} } },
        // Another organization's API naming the same id is not a user.
        { id: 'api-theirs', organizationId: OTHER, name: 'Theirs', visibility: 'org', authentication: { type: 'oauth2', config: { connectionId: 'gmail' } } },
      ],
    });
    const rows = await service.findAll({ id: ME }, ORG);
    const used = Object.fromEntries(rows.map((r: any) => [r.id, r.usedBy]));
    expect(used.gmail).toEqual([
      { type: 'api', id: 'api-gmail', name: 'Gmail' },
      { type: 'api', id: 'api-cal', name: 'Calendar' },
    ]);
    expect(used.bound).toEqual([{ type: 'api', id: 'api-weather', name: 'Weather' }]);
    expect(used.spare).toEqual([]);
    expect((await service.findById('gmail', ORG, { id: ME })).usedBy).toHaveLength(2);
  });

  it('every kind of reference counts: tools, model connections, MCP servers, channels, agents, runners, hosted models, wake-ups', async () => {
    const { service } = build({
      credentials: [cred('c1')],
      tools: [{ id: 't1', organizationId: ORG, name: 'post_message', visibility: 'org', authConfig: { type: 'bearer', config: { credentialId: 'c1' } } }],
      providers: [{ id: 'p1', organizationId: ORG, name: 'Anthropic', visibility: 'org', credentialId: null, usageCredentialId: 'c1' }],
      mcp: [{ id: 'm1', organizationId: ORG, name: 'Linear MCP', credentialId: 'c1' }],
      gateways: [
        { id: 'g1', organizationId: ORG, name: 'Slack', visibility: 'org', configuration: { credentialId: 'c1' }, visitorOAuth: null, authConfigs: [] },
        { id: 'g2', organizationId: ORG, name: 'Company chat', visibility: 'org', configuration: {}, visitorOAuth: null, authConfigs: [{ id: 'ga', configuration: { directoryCredentialId: 'c1' } }] },
      ],
      installations: [{ id: 'i1', organizationId: ORG, gatewayId: 'g1', externalTenantId: 'T123', credentialId: 'c1' }],
      channels: [{ id: 'ch1', organizationId: ORG, agentId: 'a1', name: 'Desktop app', configuration: { signingCredentialId: 'c1' } }],
      agents: [{ id: 'a1', organizationId: ORG, name: 'Inbox agent', visibility: 'org', memoryConfig: { credentialId: 'c1' } }],
      external: [{ id: 'x1', organizationId: ORG, name: 'Partner agent', credentialId: 'c1' }],
      environments: [{ id: 'e1', organizationId: ORG, name: 'Cluster env', visibility: 'org', repo: null, envBindings: [], clusterConnectionId: 'c1' }],
      deployments: [{ id: 'd1', organizationId: ORG, modelRef: 'qwen-7b', providerType: 'modal', providerConfig: { credentialId: 'c1' } }],
      push: [{ id: 's1', organizationId: ORG, name: 'Gmail pushes', verifyCredentialId: 'c1' }],
    });
    const [row] = await service.findAll({ id: ME }, ORG);
    expect((row as any).usedBy.map((u: any) => u.type).sort()).toEqual(
      ['agent', 'agent_channel', 'channel_installation', 'environment', 'external_agent', 'gateway', 'gateway', 'llm_provider', 'mcp_source', 'model_deployment', 'push_subscription', 'tool'].sort(),
    );
    expect((row as any).usedBy).toContainEqual({ type: 'agent_channel', id: 'ch1', name: 'Desktop app', agentId: 'a1' });
  });

  it('a user the caller may not see is counted but not named', async () => {
    const { service } = build({
      credentials: [cred('c1')],
      apis: [{ id: 'api-private', organizationId: ORG, name: 'Secret project', visibility: 'private', ownerUserId: 'someone-else', authentication: { type: 'bearer', config: { credentialId: 'c1' } } }],
    });
    const [row] = await service.findAll({ id: ME }, ORG);
    expect((row as any).usedBy).toEqual([{ type: 'api', id: null, name: 'An API you cannot see' }]);
    expect(JSON.stringify(row)).not.toContain('Secret project');
  });
});
