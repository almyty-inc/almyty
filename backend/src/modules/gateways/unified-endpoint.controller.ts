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
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, IsNull } from 'typeorm';
import { Response, Request } from 'express';
import * as crypto from 'crypto';
import { Organization } from '../../entities/organization.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { setProtocolContext } from '../../common/interceptors/protocol-context';
import { ApiKey } from '../../entities/api-key.entity';
import { GatewayResolverService } from '../mcp/services/gateway-resolver.service';
import { A2AServerService } from '../a2a/a2a-server.service';
import { A2AAgentCardService } from '../a2a/a2a-agent-card.service';
import { UnifiedAgentHelper } from './unified-agent.helper';
import { UnifiedGatewayDelegation } from './unified-gateway-delegation.helper';

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
    private readonly gatewayResolver: GatewayResolverService,
    private readonly a2aServerService: A2AServerService,
    private readonly a2aAgentCardService: A2AAgentCardService,
    private readonly configService: ConfigService,
    private readonly agentHelper: UnifiedAgentHelper,
    private readonly gatewayDelegation: UnifiedGatewayDelegation,
  ) {}


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
      // No auth — try to return a default agent card (first active agent gateway)
      // This satisfies A2A spec requirement for public agent card access
      const defaultGw = await this.gatewayRepository.findOne({
        where: {
          status: GatewayStatus.ACTIVE,
          type: In([GatewayType.A2A, GatewayType.ACP, GatewayType.OPENAI_CHAT]),
          agentId: Not(IsNull()),
        },
        relations: { authConfigs: true },
        order: { createdAt: 'ASC' },
      });
      if (defaultGw) {
        const agent = await this.agentRepository.findOne({ where: { id: defaultGw.agentId } });
        const org = await this.organizationRepository.findOne({ where: { id: defaultGw.organizationId } });
        if (agent && org) {
          const baseUrl = this.configService.get<string>('BASE_URL') || `${req.protocol}://${req.get('host')}`;
          const card = this.a2aAgentCardService.buildAgentCard(defaultGw, agent, org, baseUrl);
          // Public card omits security details — clients get full card via authenticated request
          delete card.securitySchemes;
          delete card.security;
          res.setHeader('Cache-Control', 'public, max-age=300');
          return res.json(card);
        }
      }
      throw new HttpException('No agent gateway found. Pass API key for specific agent.', HttpStatus.NOT_FOUND);
    }

    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyHash, isActive: true },
    });

    if (!apiKey) {
      throw new HttpException('Invalid API key', HttpStatus.UNAUTHORIZED);
    }

    if (!apiKey.canMakeRequest()) {
      throw new HttpException('API key expired or inactive', HttpStatus.UNAUTHORIZED);
    }

    // Find the gateway this key belongs to
    const gateway = await this.gatewayRepository.findOne({
      where: apiKey.gatewayId
        ? { id: apiKey.gatewayId, status: GatewayStatus.ACTIVE }
        : { organizationId: apiKey.organizationId, status: GatewayStatus.ACTIVE },
      relations: { authConfigs: true },
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

    setProtocolContext(req, {
      gatewayId: gateway.id,
      organizationId: apiKey.organizationId,
      protocol: 'a2a',
    });
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
      return res.status(401).json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32600, message: 'Authentication required. Pass API key via x-api-key header.' },
      });
    }

    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyHash, isActive: true },
    });

    if (!apiKey) {
      return res.status(401).json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32600, message: 'Invalid API key' },
      });
    }

    if (!apiKey.canMakeRequest()) {
      return res.status(401).json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32600, message: 'API key expired or inactive' },
      });
    }

    const gateway = await this.gatewayRepository.findOne({
      where: apiKey.gatewayId
        ? { id: apiKey.gatewayId, status: GatewayStatus.ACTIVE }
        : { organizationId: apiKey.organizationId, status: GatewayStatus.ACTIVE },
      relations: { authConfigs: true },
    });

    if (!gateway?.agentId) {
      return res.json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32600, message: 'No agent gateway found for this key' },
      });
    }

    // Delegate to A2A server
    setProtocolContext(req, {
      gatewayId: gateway.id,
      organizationId: apiKey.organizationId,
      protocol: 'a2a',
    });
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
      relations: { authConfigs: true },
    });

    if (gateway) {
      return this.gatewayDelegation.handleGatewayRequest(organization, gateway, orgSlug, resourceSlug, req, res, body);
    }

    // 3. Try to find an agent by slug/name
    const agent = await this.resolveAgent(resourceSlug, organization.id);

    if (agent) {
      return this.agentHelper.handleAgentRequest(agent, organization, req, res, body);
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
      relations: { authConfigs: true },
    });

    if (gateway) {
      return this.gatewayDelegation.handleGatewayRequest(organization, gateway, orgSlug, resourceSlug, req, res, body);
    }

    // 3. Try agent sub-paths (e.g., /:org/:agent/stream, /:org/:agent/invoke)
    const agent = await this.resolveAgent(resourceSlug, organization.id);

    if (agent) {
      return this.agentHelper.handleAgentRequest(agent, organization, req, res, body);
    }

    throw new HttpException(
      `Resource not found: ${orgSlug}/${resourceSlug}`,
      HttpStatus.NOT_FOUND,
    );
  }

  // ─── Gateway Delegation ─────────────────────────────────────────────



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
