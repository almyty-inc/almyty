import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Api, ApiType } from '../../entities/api.entity';
import { Tool } from '../../entities/tool.entity';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';

import { ApisService } from '../apis/apis.service';
import { GatewaysService } from '../gateways/gateways.service';
import { GatewayToolService } from '../gateways/gateway-tool.service';
import { GatewayAuthService } from '../gateways/gateway-auth.service';
import { AgentsService } from '../agents/agents.service';

import { PETSTORE_OPENAPI, SAMPLE_METADATA, SAMPLE_WORKSPACE_KEY } from './petstore-sample';
import { SampleWorkspaceResult } from './dto/onboarding.dto';

/**
 * Seeds and removes the Petstore sample workspace — the productized
 * version of what we used to wire up by hand on staging. One idempotent
 * seed action, one delete action. Every entity it creates carries the
 * `sample` metadata stamp so the delete is a clean sweep.
 */
@Injectable()
export class SampleWorkspaceService {
  private readonly logger = new Logger(SampleWorkspaceService.name);

  constructor(
    @InjectRepository(Api)
    private readonly apiRepo: Repository<Api>,
    @InjectRepository(Tool)
    private readonly toolRepo: Repository<Tool>,
    @InjectRepository(Gateway)
    private readonly gatewayRepo: Repository<Gateway>,
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    @InjectRepository(LlmProvider)
    private readonly providerRepo: Repository<LlmProvider>,
    private readonly apisService: ApisService,
    private readonly gatewaysService: GatewaysService,
    private readonly gatewayToolService: GatewayToolService,
    private readonly gatewayAuthService: GatewayAuthService,
    private readonly agentsService: AgentsService,
  ) {}

  /**
   * Idempotent. If a Petstore sample already exists for the org, returns
   * its ids with `created: false` and creates nothing new.
   */
  async seed(organizationId: string, userId: string): Promise<SampleWorkspaceResult> {
    const existing = await this.findExistingSample(organizationId);
    if (existing) {
      return { ...existing, created: false };
    }

    // 1. API + inline schema import + tool generation (synchronous path).
    const api = await this.apisService.create(
      {
        name: 'Petstore (sample)',
        description: 'Sample OpenAPI workspace to explore almyty.',
        baseUrl: 'https://petstore.swagger.io/v1',
        type: ApiType.OPENAPI,
        organizationId,
        metadata: { ...SAMPLE_METADATA },
      },
      userId,
    );

    const imported = await this.apisService.importSchema(
      api.id,
      PETSTORE_OPENAPI,
      organizationId,
      { fileName: 'petstore.json', generateTools: true },
    );

    let tools: Tool[] = imported.tools ?? [];
    if (tools.length === 0) {
      tools = await this.apisService.generateToolsFromApi(api.id, organizationId);
    }

    // Stamp generated tools as sample so the delete sweep can find them.
    if (tools.length > 0) {
      await this.toolRepo.update(
        { id: In(tools.map((t) => t.id)) },
        { metadata: { ...SAMPLE_METADATA } } as any,
      );
    }

    // 2. MCP gateway with the tools assigned + an API key.
    const gateway = await this.gatewaysService.createGateway(
      {
        name: 'Petstore Gateway (sample)',
        description: 'Serves the Petstore tools over MCP.',
        type: GatewayType.MCP,
        endpoint: `/petstore-sample-${Date.now().toString(36)}`,
        configuration: { transport: 'http' },
        metadata: { ...SAMPLE_METADATA },
      },
      organizationId,
      userId,
    );

    for (const tool of tools) {
      await this.gatewayToolService.associateTool(
        gateway.id,
        { toolId: tool.id, isActive: true },
        organizationId,
        userId,
      );
    }

    await this.gatewayAuthService.generateApiKey(
      'petstore-sample-key',
      organizationId,
      userId,
      ['gateway:use'],
      undefined,
      gateway.id,
    );

    // 3. Demo agent wired to the org's first healthy provider (skipped if none).
    const agentId = await this.maybeCreateDemoAgent(
      organizationId,
      userId,
      tools.map((t) => t.id),
    );

    return {
      apiId: api.id,
      toolIds: tools.map((t) => t.id),
      gatewayId: gateway.id,
      agentId,
      created: true,
    };
  }

  /** Removes every sample entity. Safe to call when nothing is seeded. */
  async remove(organizationId: string, userId: string): Promise<void> {
    const agents = await this.agentRepo
      .createQueryBuilder('a')
      .where('a.organizationId = :organizationId', { organizationId })
      .andWhere("a.metadata->>'sampleWorkspace' = :key", { key: SAMPLE_WORKSPACE_KEY })
      .getMany();
    for (const agent of agents) {
      await this.agentsService.deleteAgent(agent.id, organizationId, userId);
    }

    const gateways = await this.gatewayRepo
      .createQueryBuilder('g')
      .where('g.organizationId = :organizationId', { organizationId })
      .andWhere("g.metadata->>'sampleWorkspace' = :key", { key: SAMPLE_WORKSPACE_KEY })
      .getMany();
    for (const gateway of gateways) {
      // Deleting a gateway cascades its GatewayTool join rows + auth/keys.
      await this.gatewaysService.deleteGateway(gateway.id, organizationId, userId);
    }

    const apis = await this.apiRepo
      .createQueryBuilder('api')
      .where('api.organizationId = :organizationId', { organizationId })
      .andWhere("api.metadata->>'sampleWorkspace' = :key", { key: SAMPLE_WORKSPACE_KEY })
      .getMany();
    for (const api of apis) {
      // Removing the API cascades its operations; deleting it also
      // removes the sample tools generated from it.
      await this.apisService.remove(api.id, organizationId, userId);
    }
  }

  private async findExistingSample(
    organizationId: string,
  ): Promise<Omit<SampleWorkspaceResult, 'created'> | null> {
    const api = await this.apiRepo
      .createQueryBuilder('api')
      .where('api.organizationId = :organizationId', { organizationId })
      .andWhere("api.metadata->>'sampleWorkspace' = :key", { key: SAMPLE_WORKSPACE_KEY })
      .getOne();
    if (!api) return null;

    const [tools, gateway, agent] = await Promise.all([
      this.toolRepo
        .createQueryBuilder('t')
        .where('t.organizationId = :organizationId', { organizationId })
        .andWhere("t.metadata->>'sampleWorkspace' = :key", { key: SAMPLE_WORKSPACE_KEY })
        .getMany(),
      this.gatewayRepo
        .createQueryBuilder('g')
        .where('g.organizationId = :organizationId', { organizationId })
        .andWhere("g.metadata->>'sampleWorkspace' = :key", { key: SAMPLE_WORKSPACE_KEY })
        .getOne(),
      this.agentRepo
        .createQueryBuilder('a')
        .where('a.organizationId = :organizationId', { organizationId })
        .andWhere("a.metadata->>'sampleWorkspace' = :key", { key: SAMPLE_WORKSPACE_KEY })
        .getOne(),
    ]);

    return {
      apiId: api.id,
      toolIds: tools.map((t) => t.id),
      gatewayId: gateway?.id ?? '',
      agentId: agent?.id ?? null,
    };
  }

  private async maybeCreateDemoAgent(
    organizationId: string,
    userId: string,
    toolIds: string[],
  ): Promise<string | null> {
    const provider = await this.providerRepo.findOne({
      where: { organizationId, status: LlmProviderStatus.ACTIVE },
      order: { createdAt: 'ASC' },
    });
    if (!provider) {
      this.logger.log(
        `[SAMPLE_WORKSPACE] No healthy provider for org=${organizationId}; skipping demo agent.`,
      );
      return null;
    }

    const model = provider.configuration?.model || 'default';
    const agent = await this.agentsService.createAgent(
      {
        name: 'Petstore Demo Agent (sample)',
        description: 'A minimal agent wired to your first provider.',
        mode: 'workflow',
        pipeline: {
          nodes: [
            { id: 'input_1', type: 'input', config: {} },
            {
              id: 'llm_1',
              type: 'llm_call',
              config: {},
              data: {
                providerId: provider.id,
                model,
                userPromptTemplate: '{{input.message}}',
              },
            },
            {
              id: 'output_1',
              type: 'output',
              config: {},
              data: { mapping: '{{nodes.llm_1.output}}' },
            },
          ],
          edges: [
            { id: 'e1', source: 'input_1', target: 'llm_1' },
            { id: 'e2', source: 'llm_1', target: 'output_1' },
          ],
        },
        modelConfig: { providerId: provider.id, model },
        toolIds,
        metadata: { ...SAMPLE_METADATA },
      },
      organizationId,
      userId,
    );
    return agent.id;
  }
}
