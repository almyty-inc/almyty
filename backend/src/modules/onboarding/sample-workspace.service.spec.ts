import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SampleWorkspaceService } from './sample-workspace.service';
import { Api } from '../../entities/api.entity';
import { Tool } from '../../entities/tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { ApisService } from '../apis/apis.service';
import { GatewaysService } from '../gateways/gateways.service';
import { GatewayToolService } from '../gateways/gateway-tool.service';
import { GatewayAuthService } from '../gateways/gateway-auth.service';
import { AgentsService } from '../agents/agents.service';

function makeQb(overrides: { one?: any; many?: any[] } = {}) {
  return {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(overrides.one ?? null),
    getMany: jest.fn().mockResolvedValue(overrides.many ?? []),
    getCount: jest.fn().mockResolvedValue(0),
  };
}

const ORG = 'org-1';
const USER = 'user-1';

describe('SampleWorkspaceService', () => {
  let service: SampleWorkspaceService;
  let apiRepo: any;
  let toolRepo: any;
  let gatewayRepo: any;
  let agentRepo: any;
  let providerRepo: any;
  let apisService: any;
  let gatewaysService: any;
  let gatewayToolService: any;
  let gatewayAuthService: any;
  let agentsService: any;

  beforeEach(async () => {
    apiRepo = { createQueryBuilder: jest.fn(() => makeQb()) };
    toolRepo = { createQueryBuilder: jest.fn(() => makeQb()), update: jest.fn() };
    gatewayRepo = { createQueryBuilder: jest.fn(() => makeQb()) };
    agentRepo = { createQueryBuilder: jest.fn(() => makeQb()) };
    providerRepo = { findOne: jest.fn().mockResolvedValue(null) };

    apisService = {
      create: jest.fn().mockResolvedValue({ id: 'api-1' }),
      importSchema: jest.fn().mockResolvedValue({ tools: [{ id: 'tool-1' }, { id: 'tool-2' }] }),
      generateToolsFromApi: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    gatewaysService = {
      createGateway: jest.fn().mockResolvedValue({ id: 'gw-1' }),
      deleteGateway: jest.fn().mockResolvedValue(undefined),
    };
    gatewayToolService = { associateTool: jest.fn().mockResolvedValue({}) };
    gatewayAuthService = { generateApiKey: jest.fn().mockResolvedValue({ id: 'key-1' }) };
    agentsService = {
      createAgent: jest.fn().mockResolvedValue({ id: 'agent-1' }),
      deleteAgent: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SampleWorkspaceService,
        { provide: getRepositoryToken(Api), useValue: apiRepo },
        { provide: getRepositoryToken(Tool), useValue: toolRepo },
        { provide: getRepositoryToken(Gateway), useValue: gatewayRepo },
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
        { provide: getRepositoryToken(LlmProvider), useValue: providerRepo },
        { provide: ApisService, useValue: apisService },
        { provide: GatewaysService, useValue: gatewaysService },
        { provide: GatewayToolService, useValue: gatewayToolService },
        { provide: GatewayAuthService, useValue: gatewayAuthService },
        { provide: AgentsService, useValue: agentsService },
      ],
    }).compile();

    service = module.get(SampleWorkspaceService);
  });

  describe('seed', () => {
    it('creates the full workspace on first run (no existing sample)', async () => {
      // findExistingSample -> apiRepo QB getOne returns null (no sample yet).
      apiRepo.createQueryBuilder.mockReturnValue(makeQb({ one: null }));
      providerRepo.findOne.mockResolvedValue({
        id: 'prov-1',
        configuration: { model: 'gpt-4o-mini' },
      });

      const result = await service.seed(ORG, USER);

      expect(result.created).toBe(true);
      expect(apisService.create).toHaveBeenCalledTimes(1);
      expect(apisService.importSchema).toHaveBeenCalledTimes(1);
      expect(gatewaysService.createGateway).toHaveBeenCalledTimes(1);
      // Two tools -> two associations.
      expect(gatewayToolService.associateTool).toHaveBeenCalledTimes(2);
      expect(gatewayAuthService.generateApiKey).toHaveBeenCalledTimes(1);
      expect(agentsService.createAgent).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        apiId: 'api-1',
        toolIds: ['tool-1', 'tool-2'],
        gatewayId: 'gw-1',
        agentId: 'agent-1',
      });
    });

    it('is idempotent — a second run creates nothing new', async () => {
      // First run: no existing sample.
      apiRepo.createQueryBuilder.mockReturnValueOnce(makeQb({ one: null }));
      providerRepo.findOne.mockResolvedValue({ id: 'prov-1', configuration: { model: 'm' } });
      const first = await service.seed(ORG, USER);
      expect(first.created).toBe(true);

      const createCallsAfterFirst = apisService.create.mock.calls.length;
      const gatewayCallsAfterFirst = gatewaysService.createGateway.mock.calls.length;

      // Second run: findExistingSample now finds the sample API + gateway + agent.
      apiRepo.createQueryBuilder.mockReturnValue(makeQb({ one: { id: 'api-1' } }));
      toolRepo.createQueryBuilder.mockReturnValue(makeQb({ many: [{ id: 'tool-1' }] }));
      gatewayRepo.createQueryBuilder.mockReturnValue(makeQb({ one: { id: 'gw-1' } }));
      agentRepo.createQueryBuilder.mockReturnValue(makeQb({ one: { id: 'agent-1' } }));

      const second = await service.seed(ORG, USER);

      expect(second.created).toBe(false);
      // No new entities were created on the second run.
      expect(apisService.create.mock.calls.length).toBe(createCallsAfterFirst);
      expect(gatewaysService.createGateway.mock.calls.length).toBe(gatewayCallsAfterFirst);
      expect(second).toMatchObject({ apiId: 'api-1', gatewayId: 'gw-1', agentId: 'agent-1' });
    });

    it('skips the demo agent when no healthy provider exists', async () => {
      apiRepo.createQueryBuilder.mockReturnValue(makeQb({ one: null }));
      providerRepo.findOne.mockResolvedValue(null);

      const result = await service.seed(ORG, USER);

      expect(result.created).toBe(true);
      expect(agentsService.createAgent).not.toHaveBeenCalled();
      expect(result.agentId).toBeNull();
    });
  });

  describe('remove', () => {
    it('deletes every sample entity found', async () => {
      agentRepo.createQueryBuilder.mockReturnValue(makeQb({ many: [{ id: 'agent-1' }] }));
      gatewayRepo.createQueryBuilder.mockReturnValue(makeQb({ many: [{ id: 'gw-1' }] }));
      apiRepo.createQueryBuilder.mockReturnValue(makeQb({ many: [{ id: 'api-1' }] }));

      await service.remove(ORG, USER);

      expect(agentsService.deleteAgent).toHaveBeenCalledWith('agent-1', ORG, USER);
      expect(gatewaysService.deleteGateway).toHaveBeenCalledWith('gw-1', ORG, USER);
      expect(apisService.remove).toHaveBeenCalledWith('api-1', ORG, USER);
    });

    it('is a no-op when nothing is seeded', async () => {
      await service.remove(ORG, USER);
      expect(agentsService.deleteAgent).not.toHaveBeenCalled();
      expect(gatewaysService.deleteGateway).not.toHaveBeenCalled();
      expect(apisService.remove).not.toHaveBeenCalled();
    });
  });
});
