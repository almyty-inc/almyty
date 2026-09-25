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
import { Repository, In, Not, IsNull, type FindOptionsWhere } from 'typeorm';
import { Response, Request } from 'express';
import * as crypto from 'crypto';
import { Organization } from '../../entities/organization.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../entities/gateway.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { setProtocolContext } from '../../common/interceptors/protocol-context';
import { ApiKey } from '../../entities/api-key.entity';
import { GatewayResolverService } from '../mcp/services/gateway-resolver.service';
import { A2AServerService } from '../a2a/a2a-server.service';
import { A2AAgentCardService } from '../a2a/a2a-agent-card.service';
import { UnifiedAgentHelper } from './unified-agent.helper';
import { UnifiedGatewayDelegation } from './unified-gateway-delegation.helper';
import { isPrivateGateway, resourceServableThroughGateway } from './private-gateway';

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
      // No credential. The A2A spec wants a public agent card, but on a
      // multi-tenant host there is no such thing as "the" agent — and
      // this used to answer with `findOne(... order: createdAt ASC)`
      // with NO organization predicate, i.e. the oldest active agent
      // gateway on the whole platform. Any anonymous caller got that
      // tenant's organization name, agent name, description and skill
      // list, from a route that exists on every deployment.
      //
      // The per-gateway card is the one that is actually well defined
      // and it is already public at
      // /:orgSlug/:resourceSlug/.well-known/agent-card.json (the
      // `isDiscovery` branch in UnifiedGatewayDelegation). A
      // single-tenant operator who wants a root card names the gateway
      // explicitly; everyone else gets a 404 rather than a stranger's.
      const defaultGatewayId = this.configService.get<string>('PUBLIC_AGENT_CARD_GATEWAY_ID');
      const defaultGw = defaultGatewayId
        ? await this.gatewayRepository.findOne({
            where: {
              id: defaultGatewayId,
              status: GatewayStatus.ACTIVE,
              type: In([GatewayType.A2A, GatewayType.ACP, GatewayType.OPENAI_CHAT]),
              agentId: Not(IsNull()),
              // A card served to anyone is never a private gateway's.
              visibility: Not('private'),
            },
            relations: { authConfigs: true },
          })
        : null;
      if (defaultGw) {
        // The gateway's own agent, in the gateway's own organization, and
        // only while it is active: a card served to anyone never describes
        // another tenant's agent (agentId is a bare column) or a draft /
        // switched-off one. Nor one the gateway could not serve (a private
        // or team agent behind a wider gateway). Anything else is the same
        // 404 as no gateway at all.
        const agent = await this.agentRepository.findOne({
          where: { id: defaultGw.agentId, organizationId: defaultGw.organizationId, status: AgentStatus.ACTIVE },
        });
        const servable = agent && resourceServableThroughGateway(defaultGw, agent) ? agent : null;
        const org = servable ? await this.organizationRepository.findOne({ where: { id: defaultGw.organizationId } }) : null;
        if (servable && org) {
          const baseUrl = this.configService.get<string>('BASE_URL') || `${req.protocol}://${req.get('host')}`;
          const card = this.a2aAgentCardService.buildAgentCard(defaultGw, servable, org, baseUrl);
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
      // organizationId on BOTH branches. The key carries a gatewayId that
      // was stamped on it at mint time, and without this predicate a key
      // naming another tenant's gateway id resolved that tenant's gateway --
      // auth configs loaded and its agent addressed. The sibling below
      // survived only because it re-scopes the agent afterwards; this path
      // had no such second check.
      where: servableToKey(
        apiKey.gatewayId
          ? { id: apiKey.gatewayId, organizationId: apiKey.organizationId, status: GatewayStatus.ACTIVE }
          : { organizationId: apiKey.organizationId, status: GatewayStatus.ACTIVE },
        apiKey.userId,
      ),
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
      // organizationId on BOTH branches. The key carries a gatewayId that
      // was stamped on it at mint time, and without this predicate a key
      // naming another tenant's gateway id resolved that tenant's gateway --
      // auth configs loaded and its agent addressed. The sibling below
      // survived only because it re-scopes the agent afterwards; this path
      // had no such second check.
      //
      // And an A2A gateway only: this handler speaks A2A JSON-RPC, and a
      // gateway serves its agent through its own protocol. A hosted-chat or
      // Slack gateway's key (or an org key that happened to match one of
      // those first) used to turn that agent into an A2A endpoint.
      where: servableToKey(
        apiKey.gatewayId
          ? { id: apiKey.gatewayId, organizationId: apiKey.organizationId, status: GatewayStatus.ACTIVE, type: GatewayType.A2A }
          : { organizationId: apiKey.organizationId, status: GatewayStatus.ACTIVE, type: GatewayType.A2A, agentId: Not(IsNull()) },
        apiKey.userId,
      ),
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
  // Its three siblings here all carry this; this one did not, so the same
  // gateway traffic was rate-limited or not depending on whether the path had
  // a trailing segment.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
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

    if (gateway && (await this.privateGatewayVisible(gateway, req))) {
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

    // 2. Try to find a gateway. A published app surface lives one level
    // deeper than a hand-made gateway -- its endpoint is
    // /apps/<app>/<target> (endpointFor in agent-apps) -- so the callback
    // URL Slack, Meta or Teams is given for it, /<org>/apps/<app>/<target>,
    // arrives here with resourceSlug 'apps' and has to be matched on the
    // full three segments. Every other path does exactly one lookup.
    const appSurface = appSurfaceSlug(req.path, orgSlug, resourceSlug);
    const findActive = (endpoint: string) =>
      this.gatewayRepository.findOne({
        where: {
          endpoint,
          organizationId: organization.id,
          status: GatewayStatus.ACTIVE,
        },
        relations: { authConfigs: true },
      });
    const appGateway = appSurface ? await findActive(`/${appSurface}`) : null;
    const gateway = appGateway ?? (await findActive(`/${resourceSlug}`));

    if (gateway && (await this.privateGatewayVisible(gateway, req))) {
      return this.gatewayDelegation.handleGatewayRequest(
        organization,
        gateway,
        orgSlug,
        appGateway ? appSurface! : resourceSlug,
        req,
        res,
        body,
      );
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

  /**
   * Whether this request may see a gateway at all. Anything not private:
   * yes, and the gateway's own auth decides the rest. A private gateway
   * exists only for a request authenticated as its owner; for everyone
   * else the lookup carries on exactly as if no gateway had matched
   * (agent resolution, then the same 404), so the answer is identical to
   * a slug nobody uses.
   */
  private async privateGatewayVisible(gateway: Gateway, req: Request): Promise<boolean> {
    if (!isPrivateGateway(gateway)) return true;
    return !!(await this.gatewayResolver.authenticatePrivateOwner(gateway, req));
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
    if (agent) return agent;

    // Last resort: slugify each name the way the client does and compare.
    //
    // Undoing hyphens into spaces only reverses names made of letters,
    // digits and spaces. The Integration snippet builds its URL with
    // `name.toLowerCase().replace(/[^a-z0-9]+/g, '-')`, so every agent
    // whose name carries punctuation -- "Support Bot (Copy)", "v1.2",
    // "Ann's agent" -- was handed a copy-pasteable URL that 404'd. The
    // three lookups above are indexed and answer the common case; this
    // one runs only when they all miss.
    const candidates = await this.agentRepository.find({
      where: { organizationId },
      select: { id: true, name: true },
    });
    const wanted = slugifyName(slugOrName);
    const match = candidates.find(candidate => slugifyName(candidate.name) === wanted);
    return match ? this.agentRepository.findOne({ where: { id: match.id, organizationId } }) : null;
  }
}

/**
 * The gateway slug of a published app surface, or null.
 *
 * `/acme/apps/support/whatsapp_cloud` names the gateway whose endpoint is
 * `/apps/support/whatsapp_cloud`. Only paths under the reserved `apps`
 * segment are read this way, and anything after the target (a platform
 * sub-path) is left to the delegation, as for any other gateway.
 */
export function appSurfaceSlug(path: string, orgSlug: string, resourceSlug: string): string | null {
  if (resourceSlug !== 'apps') return null;
  const parts = (path || '').split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== orgSlug || parts[1] !== 'apps') return null;
  return `apps/${parts[2]}/${parts[3]}`;
}

/**
 * The client's slug rule, so both ends agree on what a name looks like in
 * a URL. Leading and trailing separators are dropped: "(Copy)" would
 * otherwise leave a bare hyphen hanging off the end.
 */
export function slugifyName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The gateways an API key may be routed to: every non-private one that
 * matches `base`, plus private ones owned by the key's user. A key minted
 * by another member (or an org-wide key with no user) never lands on
 * someone's private gateway.
 */
function servableToKey(
  base: FindOptionsWhere<Gateway>,
  userId: string | null | undefined,
): FindOptionsWhere<Gateway>[] {
  const out: FindOptionsWhere<Gateway>[] = [{ ...base, visibility: Not('private' as const) }];
  if (userId) out.push({ ...base, visibility: 'private', ownerUserId: userId });
  return out;
}
