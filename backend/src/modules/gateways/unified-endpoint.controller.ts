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
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response, Request } from 'express';
import * as crypto from 'crypto';

import { Organization } from '../../entities/organization.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { McpService } from '../mcp/mcp.service';
import { AlmytyMcpService } from '../mcp/almyty-mcp.service';
import { McpOAuthService } from '../mcp/services/mcp-oauth.service';
import { UtcpService } from '../mcp/utcp.service';
import { GatewayResolverService } from '../mcp/services/gateway-resolver.service';
import { AgentsService } from '../agents/agents.service';
import { AgentExecutionEngine, StreamEvent } from '../agents/agent-execution.engine';
import { A2AServerService } from '../a2a/a2a-server.service';
import { A2AAgentCardService } from '../a2a/a2a-agent-card.service';
import { AcpServerService } from '../acp/acp-server.service';
import { AcpDiscoveryService } from '../acp/acp-discovery.service';

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
    @InjectRepository(ApiKey)
    private apiKeyRepository: Repository<ApiKey>,
    private readonly mcpService: McpService,
    private readonly almytyMcpService: AlmytyMcpService,
    private readonly mcpOAuthService: McpOAuthService,
    private readonly utcpService: UtcpService,
    private readonly gatewayResolver: GatewayResolverService,
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
    private readonly a2aServerService: A2AServerService,
    private readonly a2aAgentCardService: A2AAgentCardService,
    private readonly acpServerService: AcpServerService,
    private readonly acpDiscoveryService: AcpDiscoveryService,
  ) {}

  /**
   * Enforce API-key authentication for the agent path.
   *
   * Prior to this gate, `POST /:orgSlug/:agentSlug/invoke` and
   * `POST /:orgSlug/:agentSlug/stream` were WIDE OPEN. Any
   * anonymous caller could execute any agent by knowing the org
   * slug and agent slug — and every successful execution burns
   * LLM tokens billed to the agent's org, potentially reads
   * credentials wired into the agent's tools, and produces
   * output that bypasses the intended auth story. This was the
   * single highest-severity finding of the full-sweep audit pass.
   *
   * The fix: every agent request MUST carry a valid API key via
   * the `Authorization: Bearer <key>` header. The key is hashed
   * with SHA-256, looked up in the `api_keys` table filtered by
   * the agent's org (so a key from org A cannot execute an agent
   * in org B), and every property of the key is verified
   * (isActive, not expired).
   *
   * The gateway path is untouched — it already goes through
   * `gatewayResolver.resolveAndAuthenticate` which enforces the
   * gateway's own auth config (API key / OAuth / JWT).
   */
  private async authenticateAgentRequest(req: Request, agent: Agent): Promise<ApiKey> {
    const authHeader = (req.headers?.authorization as string) || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new HttpException(
        {
          success: false,
          message: 'Agent execution requires an API key. Send it as `Authorization: Bearer <key>`.',
          error: 'AGENT_AUTH_REQUIRED',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const rawKey = authHeader.slice(7).trim();
    if (!rawKey) {
      throw new HttpException(
        { success: false, message: 'Empty API key', error: 'AGENT_AUTH_REQUIRED' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Scope the lookup to the agent's own org so a valid key
    // from another org can't be used to execute this agent.
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await this.apiKeyRepository.findOne({
      where: {
        keyHash,
        organizationId: agent.organizationId,
        isActive: true,
      },
    });

    if (!apiKey) {
      throw new HttpException(
        { success: false, message: 'Invalid API key for this agent', error: 'AGENT_AUTH_INVALID' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new HttpException(
        { success: false, message: 'API key expired', error: 'AGENT_AUTH_EXPIRED' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    return apiKey;
  }

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
  @Throttle({ default: { limit: 60, ttl: 60000 } })
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
        return this.delegateMcp(gateway, auth, body, req, res);
      case GatewayType.UTCP:
        return this.delegateUtcp(gateway, organization, action, req, res, body);
      case GatewayType.A2A:
        return this.delegateA2A(gateway, organization, action, req, res, body);
      case GatewayType.ACP:
        return this.delegateACP(gateway, organization, action, req, res, body);
      // TODO: Channel gateway types (slack, discord, telegram, etc.)
      // will be routed to ChannelGatewayService.handleInboundMessage here.
      default:
        // Skills gateways don't have a runtime endpoint
        throw new HttpException(
          `Gateway type '${gateway.type}' does not support direct requests. Use the protocol-specific endpoint or the Skills CLI.`,
          HttpStatus.BAD_REQUEST,
        );
    }
  }

  private async delegateMcp(gateway: Gateway, auth: any, body: any, req: Request, res: Response) {
    // System gateways serve almyty platform management tools via AlmytyMcpService
    if (gateway.isSystem) {
      // Resolve userId from auth result, req.user, or OAuth bearer token
      let userId = auth?.userId || (req as any).user?.sub || (req as any).user?.id;
      if (!userId) {
        const token = req.headers?.authorization?.startsWith('Bearer ')
          ? (req.headers.authorization as string).slice(7).trim()
          : null;
        if (token) {
          const validation = await this.mcpOAuthService.validateAccessToken(token);
          if (validation.valid) userId = validation.userId;
        }
      }
      const result = await this.almytyMcpService.handleJsonRpc(
        body,
        gateway.organizationId,
        userId,
      );
      return res.json(result);
    }

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
    action: string,
    req: Request,
    res: Response,
    body: any,
  ) {
    // Discovery: .well-known/agent-card.json
    if (action === '.well-known/agent-card.json' || action === '.well-known/agent.json') {
      const agent = await this.agentRepository.findOne({
        where: { id: gateway.agentId, organizationId: organization.id },
      });
      if (!agent) {
        throw new HttpException('Agent not found for this A2A gateway', HttpStatus.NOT_FOUND);
      }
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const card = this.a2aAgentCardService.buildAgentCard(gateway, agent, organization, baseUrl);
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(card);
    }

    // All other A2A requests are JSON-RPC POSTs to the gateway root
    if (req.method !== 'POST') {
      throw new HttpException('A2A gateways only accept POST for JSON-RPC', HttpStatus.METHOD_NOT_ALLOWED);
    }

    await this.a2aServerService.handleJsonRpc(gateway, req, body, res);
  }

  private async delegateACP(
    gateway: Gateway,
    organization: Organization,
    action: string,
    req: Request,
    res: Response,
    body: any,
  ) {
    // Discovery: .well-known/acp
    if (action === '.well-known/acp') {
      const agent = await this.agentRepository.findOne({
        where: { id: gateway.agentId, organizationId: organization.id },
      });
      if (!agent) {
        throw new HttpException('Agent not found for this ACP gateway', HttpStatus.NOT_FOUND);
      }
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const doc = this.acpDiscoveryService.buildDiscoveryDocument(gateway, agent, organization, baseUrl);
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(doc);
    }

    // All other ACP requests are JSON-RPC POSTs to the gateway root
    if (req.method !== 'POST') {
      throw new HttpException('ACP gateways only accept POST for JSON-RPC', HttpStatus.METHOD_NOT_ALLOWED);
    }

    await this.acpServerService.handleJsonRpc(gateway, req, body, res);
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
    // EVERY agent path requires an API key — no anonymous
    // execution, no anonymous metadata read. The discovery info
    // (GET /:org/:agent) also requires auth because the agent's
    // description / node graph leaks the shape of the tool
    // composition, which is tenant-sensitive. See
    // authenticateAgentRequest's docstring for the threat model.
    const apiKey = await this.authenticateAgentRequest(req, agent);

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
      return this.invokeAgent(agent, organization, body, res, apiKey);
    }

    if (req.method === 'POST' && action === 'stream') {
      return this.streamAgent(agent, organization, body, res, apiKey);
    }

    throw new HttpException(`Unknown agent action: ${action}`, HttpStatus.NOT_FOUND);
  }

  private async invokeAgent(
    agent: Agent,
    organization: Organization,
    body: any,
    res: Response,
    apiKey: ApiKey,
  ) {
    if (agent.status !== AgentStatus.ACTIVE) {
      throw new HttpException(
        { success: false, message: 'Agent must be active to invoke', error: 'AGENT_NOT_ACTIVE' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const execution = await this.executionEngine.execute(
      agent,
      organization.id,
      // Attribute the execution to the API key's owner so audit
      // logs can trace who actually ran the agent — previously
      // the userId was hardcoded to null which made every run
      // look anonymous.
      apiKey.userId ?? null,
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

  private async streamAgent(
    agent: Agent,
    organization: Organization,
    body: any,
    res: Response,
    apiKey: ApiKey,
  ) {
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
      apiKey.userId ?? null,
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
