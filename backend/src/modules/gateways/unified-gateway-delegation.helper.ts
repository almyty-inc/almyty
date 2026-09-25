import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request, Response } from 'express';
import * as crypto from 'crypto';

import { Agent } from '../../entities/agent.entity';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { MetricsRecorderService } from '../../common/metrics/metrics-recorder.service';
import { MetricType, MetricStatus } from '../../entities/usage-metric.entity';
import { setProtocolContext } from '../../common/interceptors/protocol-context';
import { GatewayRateLimitService } from './gateway-rate-limit.service';
import { ChannelGatewayService } from './channels/channel-gateway.service';
import { WhatsAppCloudAdapter } from './channels/adapters/whatsapp-cloud.adapter';
import { ChannelCredentialService } from './channels/channel-credential.service';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { Organization } from '../../entities/organization.entity';
import { McpService } from '../mcp/mcp.service';
import { AlmytyMcpService } from '../mcp/almyty-mcp.service';
import { McpOAuthService } from '../mcp/services/mcp-oauth.service';
import { UtcpService } from '../mcp/utcp.service';
import { GatewayResolverService } from '../mcp/services/gateway-resolver.service';
import { A2AServerService } from '../a2a/a2a-server.service';
import { A2AAgentCardService } from '../a2a/a2a-agent-card.service';
import { AcpServerService } from '../acp/acp-server.service';
import { AcpDiscoveryService } from '../acp/acp-discovery.service';
import { isPrivateGateway } from './private-gateway';
import { gatewayPrincipal } from '../../common/authorization/execution-access.service';
import { SkillGeneratorService } from '../tools/skill-generator.service';

/**
 * Per-protocol delegation for gateways exposed under
 * `/:orgSlug/:resourceSlug`. The unified controller dispatches
 * to `handleGatewayRequest`, which fans out to the correct
 * MCP / UTCP / A2A / ACP / channel service based on `gateway.type`.
 */
@Injectable()
export class UnifiedGatewayDelegation {
  private readonly logger = new Logger(UnifiedGatewayDelegation.name);

  /**
   * Channel platform webhooks (Slack events, Telegram updates, Twilio
   * callbacks, ...) delivered to the unified endpoint.
   *
   * Membership here SKIPS almyty API-key authentication (see the
   * `isChannel` branch below), so the only thing standing between the
   * internet and an agent run is `adapter.verifyWebhook`. That makes
   * this set a security boundary with one invariant:
   *
   *   An adapter that sets `inboundIsUnauthenticatedByDesign` must NOT
   *   be in this set.
   *
   * Discord was, and that was a hole: its adapter declares itself
   * unauthenticated-by-design because its real inbound is the
   * authenticated gateway websocket, so `verifyWebhook` returned true
   * for anyone — an unsigned POST to /:orgSlug/:resourceSlug started an
   * agent run in the victim's org, with the attacker choosing both the
   * prompt and (through `channel_id`) where the reply was delivered.
   * Discord has no HTTP webhook at all, so it does not belong here; a
   * POST to a discord gateway now authenticates like any other
   * non-channel type and is then refused as an unsupported direct
   * request.
   *
   * The chat widget is absent for the same reason plus one more: it has
   * its own dedicated, rate-limited controller and a request/response
   * contract (runId/threadId) that does not fit the fire-and-forget
   * webhook shape.
   *
   * `unauthenticated-inbound.guard.spec.ts` asserts the invariant.
   */
  static readonly CHANNEL_TYPES: ReadonlySet<GatewayType> = new Set([
    GatewayType.SLACK,
    GatewayType.TELEGRAM,
    GatewayType.WHATSAPP,
    GatewayType.WHATSAPP_CLOUD,
    GatewayType.SMS,
    GatewayType.EMAIL,
    GatewayType.WEBHOOK,
    GatewayType.GOOGLE_CHAT,
    GatewayType.MICROSOFT_TEAMS,
    GatewayType.SIGNAL,
    GatewayType.MATRIX,
    GatewayType.IRC,
  ]);

  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
    @InjectRepository(Gateway)
    private readonly gatewayRepository: Repository<Gateway>,
    private readonly mcpService: McpService,
    private readonly almytyMcpService: AlmytyMcpService,
    private readonly mcpOAuthService: McpOAuthService,
    private readonly utcpService: UtcpService,
    private readonly gatewayResolver: GatewayResolverService,
    private readonly a2aServerService: A2AServerService,
    private readonly a2aAgentCardService: A2AAgentCardService,
    private readonly acpServerService: AcpServerService,
    private readonly acpDiscoveryService: AcpDiscoveryService,
    private readonly configService: ConfigService,
    private readonly gatewayRateLimit: GatewayRateLimitService,
    private readonly channelGatewayService: ChannelGatewayService,
    @Optional() private readonly metrics?: MetricsRecorderService,
    // Optional so positional unit tests can construct the helper; when
    // present, warms a BYO-KMS org's DEK before the channel config read.
    @Optional() private readonly envelopeCrypto?: EnvelopeCryptoService,
    // Optional for the same reason; resolves the gateway's connection.
    @Optional() private readonly channelCredentials?: ChannelCredentialService,
    // A shared-tools gateway's Skills listing. Optional for the same reason;
    // without it /skills answers not found rather than an empty list.
    @Optional() private readonly skills?: SkillGeneratorService,
  ) {}

  async handleGatewayRequest(
    organization: Organization,
    gateway: Gateway,
    orgSlug: string,
    resourceSlug: string,
    req: Request,
    res: Response,
    body: any,
  ) {
    const afterGateway = req.path.replace(`/${orgSlug}/${resourceSlug}`, '');
    const action = afterGateway.replace(/^\//, '') || '';

    // Tag the request so the logging interceptor can attribute it — the
    // slug path alone identifies neither gateway nor protocol. A shared-tools
    // gateway is tagged with the protocol this request actually speaks.
    setProtocolContext(req, {
      gatewayId: gateway.id,
      organizationId: organization.id,
      protocol: gateway.type === GatewayType.TOOLS ? (toolsGatewayProtocol(action) ?? gateway.type) : gateway.type,
    });

    // Per-gateway rate limits (configured in the dashboard). Enforced
    // here so every protocol behind the unified endpoint honors them.
    const rate = await this.gatewayRateLimit.check(gateway);
    if (rate.limited) {
      if (rate.retryAfterSeconds) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      }
      // Carry the limiter's own code and the bucket that tripped onto the
      // 429. Throwing the message text alone discarded the one field that
      // distinguishes a surface ceiling from this visitor's ceiling — the
      // difference between "the gateway is busy" and "you are sending too
      // fast", which is the whole answer to the ticket.
      throw new HttpException(
        {
          message: rate.message ?? 'Gateway rate limit exceeded',
          code: rate.code ?? 'RATE_LIMITED',
          errorCode: rate.code ?? 'RATE_LIMITED',
          ...(rate.retryAfterSeconds ? { retryAfter: rate.retryAfterSeconds } : {}),
          ...(rate.bucket ? { bucket: rate.bucket } : {}),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const isDiscovery =
      action.startsWith('.well-known/') ||
      (action === '' && req.method === 'GET' && [GatewayType.A2A, GatewayType.ACP].includes(gateway.type));

    // Channel platform webhooks authenticate via platform signature
    // (verified by the adapter), not via almyty API keys — Slack or
    // Twilio cannot attach an x-api-key header.
    const isChannel = UnifiedGatewayDelegation.CHANNEL_TYPES.has(gateway.type);

    let auth: any = null;
    // A private gateway authenticates every request, discovery and channel
    // webhooks included: the resolver serves it to its owner only and
    // answers everyone else with the not-found a missing gateway gets.
    if (isPrivateGateway(gateway) || (!isDiscovery && !isChannel)) {
      // The org and the gateway (with its auth configs) are already in
      // hand from the unified controller — hand them over so the resolver
      // does not repeat both lookups.
      const result = await this.gatewayResolver.resolveAndAuthenticate(
        orgSlug,
        `/${resourceSlug}`,
        req,
        { organization, gateway },
      );
      auth = result.auth;
    }

    if (isChannel) {
      return this.delegateChannel(gateway, req, res, body);
    }

    switch (gateway.type) {
      case GatewayType.MCP:
        // MCP bumps the gateway request counters inside McpService.
        return this.delegateMcp(gateway, auth, body, req, res);
      case GatewayType.UTCP: {
        const out = await this.delegateUtcp(gateway, organization, action, auth, req, res, body);
        this.bumpGatewayCounters(gateway.id, res.statusCode < 400);
        return out;
      }
      case GatewayType.A2A: {
        const out = await this.delegateA2A(gateway, organization, action, req, res, body);
        this.bumpGatewayCounters(gateway.id, res.statusCode < 400);
        return out;
      }
      case GatewayType.ACP: {
        const out = await this.delegateACP(gateway, organization, action, req, res, body);
        this.bumpGatewayCounters(gateway.id, res.statusCode < 400);
        return out;
      }
      case GatewayType.TOOLS:
        return this.delegateTools(gateway, organization, orgSlug, action, auth, req, res, body);
      default:
        throw new HttpException(
          `Gateway type '${gateway.type}' does not support direct requests. Use the protocol-specific endpoint or the Skills CLI.`,
          HttpStatus.BAD_REQUEST,
        );
    }
  }

  /**
   * Channel platform webhook delivered to the unified endpoint. Runs
   * the same verify -> normalize -> dispatch pipeline as the channel
   * layer: the adapter verifies the platform signature against the
   * raw request body, then ChannelGatewayService.handleInboundMessage
   * normalizes the payload and drives the agent run. Platforms expect
   * a fast 2xx, so processing is fire-and-forget after verification.
   */
  private async delegateChannel(
    gateway: Gateway,
    req: Request,
    res: Response,
    body: any,
  ) {
    // The channel's effective configuration: the connection's secrets
    // (through the credential store) over the normalized, decrypted row.
    const channelConfig = await ChannelCredentialService.resolveWith(
      this.channelCredentials,
      this.envelopeCrypto,
      gateway,
      'channel_inbound',
    );

    // Meta's webhook verification handshake for WhatsApp Cloud is a
    // GET (hub.mode=subscribe&hub.verify_token=...&hub.challenge=...)
    // that must be answered with the raw challenge string. This is the
    // only channel GET we accept; it authenticates via the configured
    // verify_token, not a signature.
    if (req.method === 'GET' && gateway.type === GatewayType.WHATSAPP_CLOUD) {
      const challenge = WhatsAppCloudAdapter.handleVerification(
        (req.query as Record<string, any>) ?? {},
        channelConfig,
      );
      if (challenge === null) {
        throw new HttpException('Webhook verification failed', HttpStatus.FORBIDDEN);
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(HttpStatus.OK).send(challenge);
    }

    if (req.method !== 'POST') {
      throw new HttpException(
        'Channel gateways only accept platform webhook POSTs',
        HttpStatus.METHOD_NOT_ALLOWED,
      );
    }

    // Flatten express headers to the Record<string, string> shape the
    // adapters expect (multi-value headers are irrelevant here).
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = Array.isArray(value) ? value[0] : ((value as string) ?? '');
    }

    // Raw body (captured by main.ts rawBody: true) — signatures like
    // Slack's sign the exact bytes on the wire, not a re-serialization.
    const rawBody = (req as any).rawBody
      ? Buffer.from((req as any).rawBody).toString('utf8')
      : undefined;

    const adapter = this.channelGatewayService.getAdapter(gateway.type);
    const verified = await adapter.verifyWebhook(body, headers, channelConfig, rawBody);
    if (!verified) {
      this.bumpGatewayCounters(gateway.id, false);
      throw new HttpException('Webhook signature verification failed', HttpStatus.UNAUTHORIZED);
    }

    // Slack URL-verification handshake needs a synchronous echo.
    if (gateway.type === GatewayType.SLACK && body?.type === 'url_verification') {
      return res.json({ challenge: body.challenge });
    }

    // handleInboundMessage re-verifies (harmless), logs channel events
    // and bumps the gateway request counters itself.
    this.channelGatewayService
      .handleInboundMessage(gateway, body, headers, rawBody)
      .catch((err: any) => {
        this.logger.error(
          `Channel webhook processing failed (gateway ${gateway.id}): ${err.message}`,
        );
      });

    return res.status(HttpStatus.OK).json({ ok: true });
  }

  private async delegateMcp(
    gateway: Gateway,
    auth: any,
    body: any,
    req: Request,
    res: Response,
  ) {
    const incomingSessionId = req.headers['mcp-session-id'] as string;

    if (gateway.isSystem) {
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
      // 202 Accepted, not 204: the Streamable HTTP revision names 202 for a
      // POST that carries only notifications or responses, and the
      // TypeScript SDK's StreamableHTTPClientTransport branches on
      // `status === 202` to decide whether to open the server->client SSE
      // stream after `notifications/initialized`. On a 204 it returns
      // without error and never opens the stream, so a server-initiated
      // notification could never be delivered.
      if (result === null) {
        return res.status(202).end();
      }
      // A batch response is an array; only a single response carries a
      // session id to echo.
      const single = Array.isArray(result) ? null : result;
      if (single?.result?.sessionId || incomingSessionId) {
        res.setHeader('Mcp-Session-Id', single?.result?.sessionId || incomingSessionId);
      }
      return res.json(result);
    }

    // The caller the gateway's own auth identified (an API key's or OAuth
    // token's user), as UTCP does. With no user, tools/call and tools/get
    // treat the caller as nobody: another member's private tool -- and on
    // a private gateway, which only its owner reaches, the owner's own --
    // is refused rather than run on no one's behalf. Passing null here made
    // a private gateway useless to its owner and ran every call unattributed.
    const callerId: string | undefined = auth?.userId || (req as any).user?.sub || (req as any).user?.id || undefined;
    const result = await this.mcpService.handleJsonRpcMessage(
      body,
      gateway.organizationId,
      callerId,
      gateway.id,
    );

    // 202 Accepted for a notification-only POST — see the system-gateway
    // branch above for why the SDK cares about the exact status.
    if (result === null) {
      return res.status(202).end();
    }

    const single = Array.isArray(result) ? null : result;
    if (body?.method === 'initialize' && single?.result) {
      const sessionId = single.result.sessionId || crypto.randomUUID();
      res.setHeader('Mcp-Session-Id', sessionId);
    } else if (incomingSessionId) {
      res.setHeader('Mcp-Session-Id', incomingSessionId);
    }

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
    if (
      action === '.well-known/agent-card.json' ||
      action === '.well-known/agent.json' ||
      (action === '' && req.method === 'GET')
    ) {
      const agent = await this.agentRepository.findOne({
        where: { id: gateway.agentId, organizationId: organization.id },
      });
      if (!agent) {
        throw new HttpException('Agent not found for this A2A gateway', HttpStatus.NOT_FOUND);
      }
      const baseUrl =
        this.configService.get<string>('BASE_URL') || `${req.protocol}://${req.get('host')}`;
      const card = this.a2aAgentCardService.buildAgentCard(gateway, agent, organization, baseUrl);
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(card);
    }

    if (req.method !== 'POST') {
      throw new HttpException('A2A gateways only accept POST for JSON-RPC', HttpStatus.METHOD_NOT_ALLOWED);
    }

    const agent = await this.agentRepository.findOne({
      where: { id: gateway.agentId, organizationId: organization.id },
    });
    const baseUrl =
      this.configService.get<string>('BASE_URL') || `${req.protocol}://${req.get('host')}`;
    await this.a2aServerService.handleJsonRpc(gateway, req, body, res, {
      agent,
      org: organization,
      baseUrl,
    });
  }

  private async delegateACP(
    gateway: Gateway,
    organization: Organization,
    action: string,
    req: Request,
    res: Response,
    body: any,
  ) {
    if (action === '.well-known/acp') {
      const agent = await this.agentRepository.findOne({
        where: { id: gateway.agentId, organizationId: organization.id },
      });
      if (!agent) {
        throw new HttpException('Agent not found for this ACP gateway', HttpStatus.NOT_FOUND);
      }
      const baseUrl =
        this.configService.get<string>('BASE_URL') || `${req.protocol}://${req.get('host')}`;
      const doc = this.acpDiscoveryService.buildDiscoveryDocument(gateway, agent, organization, baseUrl);
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(doc);
    }

    if (req.method !== 'POST') {
      throw new HttpException('ACP gateways only accept POST for JSON-RPC', HttpStatus.METHOD_NOT_ALLOWED);
    }

    await this.acpServerService.handleJsonRpc(gateway, req, body, res);
  }

  /**
   * A shared-tools gateway: one address, three protocols, one servable set.
   * Which protocol a request speaks follows from its path alone
   * (`toolsGatewayProtocol`), so a client never has to be told to pick one.
   * Auth has already run above, exactly as for a single-protocol gateway,
   * and each branch is the same code a single-protocol gateway runs, so MCP,
   * UTCP and Skills list and call from `servableToolsOnGateway` alike.
   */
  private async delegateTools(
    gateway: Gateway,
    organization: Organization,
    orgSlug: string,
    action: string,
    auth: any,
    req: Request,
    res: Response,
    body: any,
  ) {
    switch (toolsGatewayProtocol(action)) {
      case 'mcp':
        // MCP bumps the gateway request counters inside McpService.
        return this.delegateMcp(gateway, auth, body, req, res);
      case 'utcp': {
        const out = await this.delegateUtcp(gateway, organization, action, auth, req, res, body);
        this.bumpGatewayCounters(gateway.id, res.statusCode < 400);
        return out;
      }
      case 'skills': {
        if (req.method !== 'GET') {
          throw new HttpException('Skills are listed with GET', HttpStatus.METHOD_NOT_ALLOWED);
        }
        if (!this.skills) {
          throw new HttpException('Skills are not available on this server', HttpStatus.NOT_FOUND);
        }
        const gatewaySlug = (gateway.endpoint || '').replace(/^\/+/, '');
        const skills = await this.skills.generateIndividualSkills(gateway.id, organization.id, {
          orgSlug: organization.slug || orgSlug,
          gatewaySlug,
        });
        this.bumpGatewayCounters(gateway.id, true);
        return res.json({ success: true, data: { skills } });
      }
      default:
        throw new HttpException(`Unknown action: ${action}`, HttpStatus.NOT_FOUND);
    }
  }

  private async delegateUtcp(
    gateway: Gateway,
    organization: Organization,
    action: string,
    auth: any,
    req: Request,
    res: Response,
    body: any,
  ) {
    if (action === '.well-known/utcp') {
      const baseUrl =
        this.configService.get<string>('BASE_URL') || `${req.protocol}://${req.get('host')}`;
      return res.json(
        this.utcpService.getDiscoveryInfo({
          organizationId: organization.id,
          gateway,
          baseUrl,
          orgSlug: organization.slug || organization.id,
        }),
      );
    }

    if (action === 'manual') {
      const manual = await this.utcpService.generateManual({
        organizationId: organization.id,
        gateway,
      });
      this.metrics?.record(MetricType.UTCP_MANUAL, {
        organizationId: organization.id,
        gatewayId: gateway.id,
      });
      return res.json(manual);
    }

    if (action === 'execute' && req.method === 'POST') {
      const userId = auth?.userId || (req as any).user?.sub || null;
      const result = await this.utcpService.executeUtcpTool(
        body,
        organization.id,
        userId,
        gateway.id,
        // Runs in the gateway's scope: the gateway serves only what its own
        // visibility covers.
        gatewayPrincipal(gateway, userId),
      );
      this.metrics?.record(MetricType.UTCP_DIRECT_CALL, {
        organizationId: organization.id,
        gatewayId: gateway.id,
        userId,
        status: result?.success === false ? MetricStatus.ERROR : MetricStatus.SUCCESS,
      });
      return res.json(result);
    }

    throw new HttpException(`Unknown UTCP action: ${action}`, HttpStatus.NOT_FOUND);
  }

  /**
   * Bump the per-gateway request counters shown on the gateway list page.
   * MCP traffic already does this in McpService; UTCP / A2A / ACP used to
   * skip it, so those gateways permanently showed "0 requests".
   * Fire-and-forget — counter loss is preferable to slowing the response.
   */
  private bumpGatewayCounters(gatewayId: string, success: boolean): void {
    this.gatewayRepository
      .createQueryBuilder()
      .update(Gateway)
      .set({
        totalRequests: () => '"totalRequests" + 1',
        successfulRequests: success
          ? () => '"successfulRequests" + 1'
          : () => '"successfulRequests"',
        lastRequestAt: new Date(),
      })
      .where('id = :id', { id: gatewayId })
      .execute()
      .catch((err: any) => {
        this.logger.warn(`Failed to bump gateway counters: ${err.message}`);
      });
  }
}

/**
 * Which protocol a request to a shared-tools gateway speaks, from the path
 * after the gateway's address:
 *
 *   ''                          MCP (JSON-RPC over Streamable HTTP)
 *   '.well-known/utcp'          UTCP discovery
 *   'manual', 'execute'         UTCP
 *   'skills'                    Agent Skills
 *   any other '.well-known/...' MCP, as on an MCP gateway
 *
 * Anything else is null: not found, never a guess.
 */
export function toolsGatewayProtocol(action: string): 'mcp' | 'utcp' | 'skills' | null {
  if (action === '') return 'mcp';
  if (action === '.well-known/utcp' || action === 'manual' || action === 'execute') return 'utcp';
  if (action === 'skills') return 'skills';
  if (action.startsWith('.well-known/')) return 'mcp';
  return null;
}
