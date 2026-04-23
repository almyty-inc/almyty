import { A2AAgentCardService } from '../a2a-agent-card.service';
import { Gateway, GatewayType, GatewayKind } from '../../../entities/gateway.entity';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { Organization } from '../../../entities/organization.entity';

describe('A2AAgentCardService', () => {
  let service: A2AAgentCardService;

  const makeGateway = (overrides: Partial<Gateway> = {}): Gateway => {
    const gw = new Gateway();
    Object.assign(gw, {
      id: 'gw-1',
      name: 'Test A2A',
      type: GatewayType.A2A,
      kind: GatewayKind.AGENT,
      endpoint: '/test-a2a',
      agentId: 'agent-1',
      organizationId: 'org-1',
      authConfigs: [],
      ...overrides,
    });
    return gw;
  };

  const makeAgent = (overrides: Partial<Agent> = {}): Agent => {
    const agent = new Agent();
    Object.assign(agent, {
      id: 'agent-1',
      name: 'Test Agent',
      description: 'A test agent',
      status: AgentStatus.ACTIVE,
      mode: 'autonomous',
      ...overrides,
    });
    return agent;
  };

  const makeOrg = (overrides: Partial<Organization> = {}): Organization => {
    const org = new Organization();
    Object.assign(org, {
      id: 'org-1',
      name: 'Test Org',
      slug: 'test-org',
      ...overrides,
    });
    return org;
  };

  beforeEach(() => {
    service = new A2AAgentCardService();
  });

  it('should build a valid agent card with all required fields', () => {
    const card = service.buildAgentCard(
      makeGateway(),
      makeAgent(),
      makeOrg(),
      'https://api.example.com',
    );

    expect(card.name).toBe('Test Agent');
    expect(card.description).toBe('A test agent');
    expect(card.url).toBe('https://api.example.com/test-org/test-a2a');
    expect(card.version).toBeDefined();
    expect(card.skills).toBeInstanceOf(Array);
    expect(card.skills.length).toBeGreaterThan(0);
    expect(card.capabilities).toBeDefined();
    expect(card.capabilities.streaming).toBe(true);
  });

  it('should always include provider.url (required by A2A spec)', () => {
    // With website
    const cardWithWebsite = service.buildAgentCard(
      makeGateway(),
      makeAgent(),
      makeOrg({ website: 'https://example.com' } as any),
      'https://api.example.com',
    );
    expect(cardWithWebsite.provider.url).toBe('https://example.com');

    // Without website — falls back to baseUrl/slug
    const cardWithoutWebsite = service.buildAgentCard(
      makeGateway(),
      makeAgent(),
      makeOrg(),
      'https://api.example.com',
    );
    expect(cardWithoutWebsite.provider.url).toBe('https://api.example.com/test-org');
    expect(cardWithoutWebsite.provider.url).toBeDefined();
  });

  it('should include provider.organization', () => {
    const card = service.buildAgentCard(
      makeGateway(),
      makeAgent(),
      makeOrg(),
      'https://api.example.com',
    );
    expect(card.provider.organization).toBe('Test Org');
  });

  it('should build skill from agent', () => {
    const card = service.buildAgentCard(
      makeGateway(),
      makeAgent({ name: 'My Bot', description: 'Does stuff' }),
      makeOrg(),
      'https://api.example.com',
    );
    expect(card.skills[0].name).toBe('My Bot');
    expect(card.skills[0].description).toBe('Does stuff');
    expect(card.skills[0].inputModes).toContain('text');
    expect(card.skills[0].outputModes).toContain('text');
  });

  it('should include security schemes from gateway auth configs', () => {
    const gw = makeGateway({
      authConfigs: [
        { id: 'auth-1', type: 'api_key' as any, isActive: true, configuration: { keyHeader: 'x-api-key' } } as any,
      ],
    });

    const card = service.buildAgentCard(gw, makeAgent(), makeOrg(), 'https://api.example.com');

    expect(card.securitySchemes).toBeDefined();
    expect(Object.keys(card.securitySchemes!).length).toBe(1);
    const scheme = Object.values(card.securitySchemes!)[0];
    expect(scheme.apiKeySecurityScheme).toBeDefined();
    expect(scheme.apiKeySecurityScheme.in).toBe('header');
  });

  it('should omit security schemes when no auth configs', () => {
    const card = service.buildAgentCard(
      makeGateway({ authConfigs: [] }),
      makeAgent(),
      makeOrg(),
      'https://api.example.com',
    );
    expect(card.securitySchemes).toBeUndefined();
    expect(card.security).toBeUndefined();
  });

  it('should include default input/output modes', () => {
    const card = service.buildAgentCard(
      makeGateway(),
      makeAgent(),
      makeOrg(),
      'https://api.example.com',
    );
    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.defaultOutputModes).toEqual(['text']);
  });

  it('should declare extendedAgentCard capability', () => {
    const card = service.buildAgentCard(
      makeGateway(),
      makeAgent(),
      makeOrg(),
      'https://api.example.com',
    );
    expect(card.capabilities?.extendedAgentCard).toBe(true);
  });

  it('should declare pushNotifications as false', () => {
    const card = service.buildAgentCard(
      makeGateway(),
      makeAgent(),
      makeOrg(),
      'https://api.example.com',
    );
    expect(card.capabilities?.pushNotifications).toBe(false);
  });

  it('should include supportedInterfaces with jsonrpc binding', () => {
    const card = service.buildAgentCard(
      makeGateway(),
      makeAgent(),
      makeOrg(),
      'https://api.example.com',
    );
    expect(card.supportedInterfaces).toBeDefined();
    expect(card.supportedInterfaces![0].protocolBinding).toBe('jsonrpc');
    expect(card.supportedInterfaces![0].url).toBe('https://api.example.com/test-org/test-a2a');
  });
});
