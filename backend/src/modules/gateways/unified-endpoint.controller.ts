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
  UseFilters,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JsonRpcParseErrorFilter } from '../a2a/json-rpc-parse-error.filter';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Response, Request } from 'express';
import * as crypto from 'crypto';
import { JwtService } from '@nestjs/jwt';

import { Organization } from '../../entities/organization.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { Tool } from '../../entities/tool.entity';
import { In } from 'typeorm';
import { ApiKey } from '../../entities/api-key.entity';
import { McpService } from '../mcp/mcp.service';
import { AlmytyMcpService } from '../mcp/almyty-mcp.service';
import { McpOAuthService } from '../mcp/services/mcp-oauth.service';
import { UtcpService } from '../mcp/utcp.service';
import { GatewayResolverService } from '../mcp/services/gateway-resolver.service';
import { AgentsService } from '../agents/agents.service';
import { AgentExecutionEngine, StreamEvent } from '../agents/agent-execution.engine';
import { AgentRuntimeService } from '../agents/agent-runtime.service';
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
@UseFilters(JsonRpcParseErrorFilter)
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
    private readonly runtimeService: AgentRuntimeService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
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
  /**
   * Authenticate an agent request via API key or JWT.
   *
   * Tries API key first (SHA-256 hash lookup). If that fails,
   * tries JWT verification — this allows CLI users authenticated
   * via `npx @almyty/auth login` to use the unified endpoint
   * without a separate API key.
   *
   * Returns an ApiKey object for API key auth, or a synthetic
   * ApiKey-like object for JWT auth with the user's ID and org.
   */
  private async authenticateAgentRequest(req: Request, agent: Agent): Promise<ApiKey> {
    const authHeader = (req.headers?.authorization as string) || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw new HttpException(
        {
          success: false,
          message: 'Authentication required. Send `Authorization: Bearer <key-or-jwt>`.',
          error: 'AGENT_AUTH_REQUIRED',
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const rawToken = authHeader.slice(7).trim();
    if (!rawToken) {
      throw new HttpException(
        { success: false, message: 'Empty token', error: 'AGENT_AUTH_REQUIRED' },
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Try API key first
    const keyHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const apiKey = await this.apiKeyRepository.findOne({
      where: {
        keyHash,
        organizationId: agent.organizationId,
        isActive: true,
      },
    });

    if (apiKey) {
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        throw new HttpException(
          { success: false, message: 'API key expired', error: 'AGENT_AUTH_EXPIRED' },
          HttpStatus.UNAUTHORIZED,
        );
      }
      return apiKey;
    }

    // Try JWT
    try {
      const payload = this.jwtService.verify(rawToken);
      const userId = payload.sub;
      const userOrgs: Array<{ id: string }> = payload.organizations || [];
      const hasAccess = userOrgs.some(o => o.id === agent.organizationId);

      if (!hasAccess) {
        this.logger.warn(`JWT org mismatch: agent.orgId=${agent.organizationId}, JWT orgs=${JSON.stringify(userOrgs.map(o => o.id))}`);
        throw new HttpException(
          { success: false, message: `No access to this agent's organization`, error: 'AGENT_AUTH_FORBIDDEN' },
          HttpStatus.FORBIDDEN,
        );
      }

      // Return a synthetic ApiKey-like object for downstream code
      return { userId, organizationId: agent.organizationId } as ApiKey;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { success: false, message: 'Invalid API key or JWT', error: 'AGENT_AUTH_INVALID' },
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  /**
   * Domain-root agent card: /.well-known/agent-card.json
   *
   * Returns the agent card for the gateway that owns the API key
   * in the request. This allows A2A SDKs and the TCK (which strip
   * the path and only use the domain root) to discover agents on
   * a multi-tenant platform.
   */
  @All('.well-known/agent-card.json')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async handleRootAgentCard(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Resolve gateway from API key
    const authHeader = (req.headers?.authorization as string) || '';
    const apiKeyHeader = (req.headers?.['x-api-key'] as string) || '';
    const queryKey = (req.query?.key as string) || '';
    const rawKey = apiKeyHeader || (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '') || queryKey;

    if (!rawKey) {
      throw new HttpException('API key required. Pass as x-api-key header, Bearer token, or ?key= query param.', HttpStatus.UNAUTHORIZED);
    }

    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyHash, isActive: true },
    });

    if (!apiKey) {
      throw new HttpException('Invalid API key', HttpStatus.UNAUTHORIZED);
    }

    // Find the gateway this key belongs to
    const gateway = await this.gatewayRepository.findOne({
      where: apiKey.gatewayId
        ? { id: apiKey.gatewayId, status: GatewayStatus.ACTIVE }
        : { organizationId: apiKey.organizationId, status: GatewayStatus.ACTIVE },
      relations: ['authConfigs'],
    });

    if (!gateway || !gateway.agentId) {
      throw new HttpException('No agent gateway found for this key', HttpStatus.NOT_FOUND);
    }

    const agent = await this.agentRepository.findOne({
      where: { id: gateway.agentId, organizationId: apiKey.organizationId },
    });

    if (!agent) {
      throw new HttpException('Agent not found', HttpStatus.NOT_FOUND);
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: apiKey.organizationId },
    });

    if (!organization) {
      throw new HttpException('Organization not found', HttpStatus.NOT_FOUND);
    }

    const baseUrl = this.configService.get<string>('BASE_URL') || `${req.protocol}://${req.get('host')}`;
    const card = this.a2aAgentCardService.buildAgentCard(gateway, agent, organization, baseUrl);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(card);
  }

  /**
   * Root-level JSON-RPC POST: handles A2A message/send etc. at domain root.
   *
   * The A2A TCK and SDKs send JSON-RPC POSTs to the base URL (domain root).
   * API key in the request determines which gateway to route to.
   */
  @All('/')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async handleRootJsonRpc(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: any,
  ) {
    if (req.method === 'GET') {
      // GET / is not agent card — that's at /.well-known/agent-card.json
      throw new HttpException('Not Found', HttpStatus.NOT_FOUND);
    }

    // Resolve gateway from API key
    const apiKeyHeader = (req.headers?.['x-api-key'] as string) || '';
    const authHeader = (req.headers?.authorization as string) || '';
    const rawKey = apiKeyHeader || (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '');

    if (!rawKey) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyHash, isActive: true },
    });

    if (!apiKey) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const gateway = await this.gatewayRepository.findOne({
      where: apiKey.gatewayId
        ? { id: apiKey.gatewayId, status: GatewayStatus.ACTIVE }
        : { organizationId: apiKey.organizationId, status: GatewayStatus.ACTIVE },
      relations: ['authConfigs'],
    });

    if (!gateway?.agentId) {
      return res.json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32600, message: 'No agent gateway found for this key' },
      });
    }

    // Delegate to A2A server
    return this.a2aServerService.handleJsonRpc(gateway, req, body, res);
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
    // Extract action from sub-path (e.g., /:org/:gw/.well-known/a2a -> .well-known/a2a)
    const afterGateway = req.path.replace(`/${orgSlug}/${resourceSlug}`, '');
    const action = afterGateway.replace(/^\//, '') || '';

    // Discovery endpoints are public (A2A agent card, ACP discovery, UTCP manual)
    // GET on A2A/ACP root is also discovery (agent card / capability doc)
    const isDiscovery = action.startsWith('.well-known/')
      || (action === '' && req.method === 'GET' && [GatewayType.A2A, GatewayType.ACP].includes(gateway.type));

    // Authenticate the request (skip for discovery)
    let auth: any = null;
    if (!isDiscovery) {
      const result = await this.gatewayResolver.resolveAndAuthenticate(
        orgSlug,
        `/${resourceSlug}`,
        req,
      );
      auth = result.auth;
    }

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
    // Discovery: GET on root or .well-known/agent-card.json returns agent card
    if (action === '.well-known/agent-card.json' || action === '.well-known/agent.json' || (action === '' && req.method === 'GET')) {
      const agent = await this.agentRepository.findOne({
        where: { id: gateway.agentId, organizationId: organization.id },
      });
      if (!agent) {
        throw new HttpException('Agent not found for this A2A gateway', HttpStatus.NOT_FOUND);
      }
      const baseUrl = this.configService.get<string>('BASE_URL') || `${req.protocol}://${req.get('host')}`;
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
      const baseUrl = this.configService.get<string>('BASE_URL') || `${req.protocol}://${req.get('host')}`;
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
      // GET /:org/:agent — return agent info with tools
      let tools: Array<{ id: string; name: string; description?: string }> = [];
      if (agent.toolIds?.length) {
        const toolRepo = this.agentRepository.manager.getRepository(Tool);
        const toolEntities = await toolRepo.find({ where: { id: In(agent.toolIds) }, select: ['id', 'name', 'description'] }).catch(() => []);
        tools = toolEntities.map(t => ({ id: t.id, name: t.name, description: t.description }));
      }
      return res.json({
        success: true,
        data: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          mode: agent.mode,
          status: agent.status,
          tools,
        },
      });
    }

    if (req.method === 'POST' && (!action || action === 'invoke')) {
      return this.invokeAgent(agent, organization, body, res, apiKey);
    }

    if (req.method === 'POST' && action === 'stream') {
      return this.streamAgent(agent, organization, body, res, apiKey);
    }

    // ── Autonomous run endpoints ──────────────────────────────────
    // POST /:org/:agent/runs         — start a run
    // GET  /:org/:agent/runs/:runId  — get run status
    // GET  /:org/:agent/runs/:runId/stream — SSE stream
    // POST /:org/:agent/runs/:runId/input  — send input
    // POST /:org/:agent/runs/:runId/cancel — cancel run

    if (action === 'runs' || action.startsWith('runs/')) {
      return this.handleAgentRuns(agent, organization, body, req, res, apiKey, action);
    }

    // GET /conversations/:convId/messages — conversation history
    if (req.method === 'GET' && action.startsWith('conversations/')) {
      const parts = action.split('/');
      const convId = parts[1];
      const sub = parts[2];
      if (convId && (!sub || sub === 'messages')) {
        return this.getConversationMessages(convId, organization.id, res);
      }
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

  // ─── Autonomous Runs ─────────────────────────────────────────────────

  private async handleAgentRuns(
    agent: Agent,
    organization: Organization,
    body: any,
    req: Request,
    res: Response,
    apiKey: ApiKey,
    action: string,
  ) {
    const userId = apiKey.userId ?? null;
    const parts = action.split('/'); // ['runs'] or ['runs', runId] or ['runs', runId, 'stream']
    const runId = parts[1];
    const subAction = parts[2];

    // POST /runs — start a new run
    if (req.method === 'POST' && !runId) {
      if (agent.mode !== 'autonomous') {
        throw new HttpException('Agent is not autonomous. Use /invoke or /stream.', HttpStatus.BAD_REQUEST);
      }
      const run = await this.runtimeService.startRun(
        agent.id, organization.id, userId, body.input,
        { conversationId: body.conversationId },
      );
      return res.status(201).json({ success: true, data: run });
    }

    if (!runId) {
      // GET /runs — list runs
      const runs = await this.runtimeService.listRuns(agent.id, organization.id);
      return res.json({ success: true, data: runs });
    }

    // GET /runs/:runId
    if (req.method === 'GET' && !subAction) {
      const run = await this.runtimeService.getRun(runId, organization.id);
      return res.json({ success: true, data: run });
    }

    // GET /runs/:runId/stream — SSE via Redis Streams (cross-pod)
    if (req.method === 'GET' && subAction === 'stream') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const abortController = new AbortController();
      req.on('close', () => abortController.abort());

      try {
        await this.runtimeService.subscribeRunEvents(
          runId,
          (event) => {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
              res.end();
            }
          },
          abortController.signal,
        );
      } catch {
        // Stream ended or aborted
      }

      if (!res.writableEnded) res.end();
      return;
    }

    // POST /runs/:runId/input
    if (req.method === 'POST' && subAction === 'input') {
      await this.runtimeService.sendInput(runId, organization.id, body.input || body.message);
      return res.json({ success: true });
    }

    // POST /runs/:runId/cancel
    if (req.method === 'POST' && subAction === 'cancel') {
      await this.runtimeService.cancelRun(runId, organization.id);
      return res.json({ success: true });
    }

    throw new HttpException(`Unknown runs action: ${subAction}`, HttpStatus.NOT_FOUND);
  }

  // ─── Agent Resolution ───────────────────────────────────────────────

  private async getConversationMessages(convId: string, organizationId: string, res: Response) {
    const Conversation = (await import('../../entities/conversation.entity')).Conversation;
    const Message = (await import('../../entities/message.entity')).Message;
    const convRepo = this.agentRepository.manager.getRepository(Conversation);
    const msgRepo = this.agentRepository.manager.getRepository(Message);

    const conv = await convRepo.findOne({ where: { id: convId, organizationId } as any });
    if (!conv) {
      throw new HttpException('Conversation not found', HttpStatus.NOT_FOUND);
    }

    const messages = await msgRepo.find({
      where: { conversationId: convId },
      order: { createdAt: 'ASC' },
      select: ['id', 'role', 'content', 'createdAt'],
    });

    return res.json({
      success: true,
      data: messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
  }

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
