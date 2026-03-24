import {
  All,
  Controller,
  Param,
  Body,
  Req,
  Res,
  Logger,
  HttpException,
  HttpStatus,
  Header,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response, Request } from 'express';

import { Organization } from '../../entities/organization.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { McpService } from '../mcp/mcp.service';
import { A2AService } from '../mcp/a2a.service';
import { UtcpService } from '../mcp/utcp.service';
import { GatewayResolverService } from '../mcp/services/gateway-resolver.service';
import { AgentsService } from '../agents/agents.service';
import { AgentExecutionEngine, StreamEvent } from '../agents/agent-execution.engine';

/**
 * Unified endpoint controller that provides GitHub-style URLs:
 *   /:orgSlug/:resourceSlug
 *
 * Routes to the correct handler based on whether the resource is a
 * gateway (MCP/A2A/UTCP/Skills) or an agent.
 *
 * IMPORTANT: This controller is registered LAST so it doesn't catch
 * existing routes like /auth/login, /apis, /health, etc.
 */
@Controller()
export class UnifiedEndpointController {
  private readonly logger = new Logger(UnifiedEndpointController.name);

  constructor(
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(Agent)
    private agentRepository: Repository<Agent>,
    private readonly mcpService: McpService,
    private readonly a2aService: A2AService,
    private readonly utcpService: UtcpService,
    private readonly gatewayResolver: GatewayResolverService,
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
  ) {}

  /**
   * Catch-all handler for /:orgSlug/:resourceSlug and sub-paths.
   * Resolves org, then finds gateway or agent by slug/name.
   */
  @All(':orgSlug/:resourceSlug')
  async handleRequest(
    @Param('orgSlug') orgSlug: string,
    @Param('resourceSlug') resourceSlug: string,
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: any,
  ) {
    this.logger.log(`Unified endpoint: org=${orgSlug}, resource=${resourceSlug}, method=${req.method}`);

    // 1. Resolve organization
    let organization: Organization;
    try {
      organization = await this.gatewayResolver.resolveOrganization(orgSlug);
    } catch {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }

    // 2. Try to find a gateway with this endpoint
    const normalizedEndpoint = `/${resourceSlug}`;
    const gateway = await this.gatewayRepository.findOne({
      where: {
        endpoint: normalizedEndpoint,
        organizationId: organization.id,
        status: GatewayStatus.ACTIVE,
      },
      relations: ['authConfigs'],
    });

    if (gateway) {
      return this.handleGatewayRequest(organization, gateway, orgSlug, resourceSlug, req, res, body);
    }

    // 3. Try to find an agent by slug/name
    const agent = await this.resolveAgent(resourceSlug, organization.id);

    if (agent) {
      return this.handleAgentRequest(agent, organization, req, res, body);
    }

    // 4. Neither found
    throw new HttpException(
      `Resource not found: ${orgSlug}/${resourceSlug}`,
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Handle sub-paths: /:orgSlug/:resourceSlug/action/...
   * Needed for A2A discovery, UTCP manual, etc.
   */
  @All(':orgSlug/:resourceSlug/*')
  async handleSubPathRequest(
    @Param('orgSlug') orgSlug: string,
    @Param('resourceSlug') resourceSlug: string,
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: any,
  ) {
    this.logger.log(`Unified endpoint (sub-path): org=${orgSlug}, resource=${resourceSlug}, path=${req.path}`);

    // 1. Resolve organization
    let organization: Organization;
    try {
      organization = await this.gatewayResolver.resolveOrganization(orgSlug);
    } catch {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }

    // 2. Try to find a gateway
    const normalizedEndpoint = `/${resourceSlug}`;
    const gateway = await this.gatewayRepository.findOne({
      where: {
        endpoint: normalizedEndpoint,
        organizationId: organization.id,
        status: GatewayStatus.ACTIVE,
      },
      relations: ['authConfigs'],
    });

    if (gateway) {
      return this.handleGatewayRequest(organization, gateway, orgSlug, resourceSlug, req, res, body);
    }

    // 3. Try agent sub-paths (e.g., /:org/:agent/stream, /:org/:agent/invoke)
    const agent = await this.resolveAgent(resourceSlug, organization.id);

    if (agent) {
      return this.handleAgentRequest(agent, organization, req, res, body);
    }

    throw new HttpException(
      `Resource not found: ${orgSlug}/${resourceSlug}`,
      HttpStatus.NOT_FOUND,
    );
  }

  // ─── Gateway Delegation ─────────────────────────────────────────────

  private async handleGatewayRequest(
    organization: Organization,
    gateway: Gateway,
    orgSlug: string,
    resourceSlug: string,
    req: Request,
    res: Response,
    body: any,
  ) {
    // Authenticate the request against the gateway's auth config
    const { auth } = await this.gatewayResolver.resolveAndAuthenticate(
      orgSlug,
      `/${resourceSlug}`,
      req,
    );

    // Extract action from sub-path (e.g., /:org/:gw/.well-known/a2a -> .well-known/a2a)
    const afterGateway = req.path.replace(`/${orgSlug}/${resourceSlug}`, '');
    const action = afterGateway.replace(/^\//, '') || '';

    switch (gateway.type) {
      case GatewayType.MCP:
        return this.delegateMcp(gateway, body, res);
      case GatewayType.A2A:
        return this.delegateA2A(gateway, organization, orgSlug, resourceSlug, action, req, res, body);
      case GatewayType.UTCP:
        return this.delegateUtcp(gateway, organization, action, req, res, body);
      default:
        // Skills gateways don't have a runtime endpoint
        throw new HttpException(
          `Gateway type '${gateway.type}' does not support direct requests. Use the protocol-specific endpoint or the Skills CLI.`,
          HttpStatus.BAD_REQUEST,
        );
    }
  }

  private async delegateMcp(gateway: Gateway, body: any, res: Response) {
    const result = await this.mcpService.handleJsonRpc(
      body,
      gateway.organizationId,
      null,
      gateway.id,
    );
    return res.json(result);
  }

  private async delegateA2A(
    gateway: Gateway,
    organization: Organization,
    orgSlug: string,
    resourceSlug: string,
    action: string,
    req: Request,
    res: Response,
    body: any,
  ) {
    // Discovery endpoints
    if (action === '.well-known/agent.json' || action === '.well-known/agent-card.json' || action === '.well-known/a2a') {
      const baseUrl = process.env.BASE_URL || 'http://localhost:4000';
      return res.json({
        protocol: 'a2a',
        version: '1.0.0',
        server: { name: 'apifai', version: '1.0.0', description: gateway.name },
        endpoints: {
          agents: `${baseUrl}/${orgSlug}/${resourceSlug}/agents`,
          messages: `${baseUrl}/${orgSlug}/${resourceSlug}/messages`,
          discovery: `${baseUrl}/${orgSlug}/${resourceSlug}/.well-known/agent.json`,
        },
        gateway: { id: gateway.id, name: gateway.name },
      });
    }

    if (action === 'agents' && req.method === 'GET') {
      return res.json(await this.a2aService.listAgents(organization.id));
    }

    if (action === 'messages' && req.method === 'POST' && body.fromAgentId && body.toAgentId) {
      return res.json(await this.a2aService.sendMessage(body.fromAgentId, body.toAgentId, body.content, body.messageType));
    }

    if (action === 'agents' && req.method === 'POST' && body.name) {
      return res.json(await this.a2aService.registerAgent(organization.id, body));
    }

    throw new HttpException(`Unknown A2A action: ${action}`, HttpStatus.NOT_FOUND);
  }

  private async delegateUtcp(
    gateway: Gateway,
    organization: Organization,
    action: string,
    req: Request,
    res: Response,
    body: any,
  ) {
    if (action === '.well-known/utcp' || action === 'manual') {
      if (action === '.well-known/utcp') {
        return res.json(this.utcpService.getDiscoveryInfo(organization.id));
      }
      return res.json(await this.utcpService.generateManual(organization.id));
    }

    if (action === 'execute' && req.method === 'POST') {
      return res.json(await this.utcpService.executeUtcpTool(body, organization.id));
    }

    throw new HttpException(`Unknown UTCP action: ${action}`, HttpStatus.NOT_FOUND);
  }

  // ─── Agent Delegation ───────────────────────────────────────────────

  private async handleAgentRequest(
    agent: Agent,
    organization: Organization,
    req: Request,
    res: Response,
    body: any,
  ) {
    // Extract action sub-path
    const pathParts = req.path.split('/').filter(Boolean);
    // pathParts: [orgSlug, agentSlug, ...action]
    const action = pathParts.slice(2).join('/') || '';

    if (req.method === 'GET' && !action) {
      // GET /:org/:agent — return agent info
      return res.json({
        success: true,
        data: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          status: agent.status,
        },
      });
    }

    if (req.method === 'POST' && (!action || action === 'invoke')) {
      return this.invokeAgent(agent, organization, body, res);
    }

    if (req.method === 'POST' && action === 'stream') {
      return this.streamAgent(agent, organization, body, res);
    }

    throw new HttpException(`Unknown agent action: ${action}`, HttpStatus.NOT_FOUND);
  }

  private async invokeAgent(agent: Agent, organization: Organization, body: any, res: Response) {
    if (agent.status !== AgentStatus.ACTIVE) {
      throw new HttpException(
        { success: false, message: 'Agent must be active to invoke', error: 'AGENT_NOT_ACTIVE' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const execution = await this.executionEngine.execute(
      agent,
      organization.id,
      null,
      {
        input: body.input || body,
        variables: body.variables,
        metadata: body.metadata,
      },
    );

    return res.json({
      success: execution.status === 'completed',
      data: execution,
      message: execution.status === 'completed'
        ? 'Agent executed successfully'
        : `Agent execution ${execution.status}: ${execution.error || ''}`,
    });
  }

  private async streamAgent(agent: Agent, organization: Organization, body: any, res: Response) {
    if (agent.status !== AgentStatus.ACTIVE) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        success: false,
        message: 'Agent must be active to invoke',
        error: 'AGENT_NOT_ACTIVE',
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const onEvent = (event: StreamEvent) => {
      const data = JSON.stringify(event);
      res.write(`event: ${event.type}\ndata: ${data}\n\n`);
    };

    const execution = await this.executionEngine.execute(
      agent,
      organization.id,
      null,
      {
        input: body.input || body,
        variables: body.variables,
        metadata: body.metadata,
      },
      onEvent,
    );

    res.write(`event: done\ndata: ${JSON.stringify({ executionId: execution.id, status: execution.status })}\n\n`);
    res.end();
  }

  // ─── Agent Resolution ───────────────────────────────────────────────

  private async resolveAgent(slugOrName: string, organizationId: string): Promise<Agent | null> {
    // Try exact name match
    let agent = await this.agentRepository.findOne({
      where: { name: slugOrName, organizationId },
    });
    if (agent) return agent;

    // Try case-insensitive match
    agent = await this.agentRepository
      .createQueryBuilder('agent')
      .where('agent.organizationId = :organizationId', { organizationId })
      .andWhere('LOWER(agent.name) = LOWER(:name)', { name: slugOrName })
      .getOne();
    if (agent) return agent;

    // Try slug match: "my-agent" matches "My Agent"
    const deslugified = slugOrName.replace(/-/g, ' ');
    agent = await this.agentRepository
      .createQueryBuilder('agent')
      .where('agent.organizationId = :organizationId', { organizationId })
      .andWhere('LOWER(agent.name) = LOWER(:name)', { name: deslugified })
      .getOne();
    return agent;
  }
}
