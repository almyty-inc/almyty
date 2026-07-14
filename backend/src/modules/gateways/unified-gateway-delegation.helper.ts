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
import { getChannelConfig } from './channels/channel-config.helper';
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
   * callbacks, ...) delivered to the unified endpoint. The chat widget
   * is deliberately absent — it has its own dedicated controller and a
   * request/response contract (runId/threadId) that does not fit the
   * fire-and-forget webhook shape.
   */
  private static readonly CHANNEL_TYPES: ReadonlySet<GatewayType> = new Set([
    GatewayType.SLACK,
    GatewayType.DISCORD,
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
    // slug path alone identifies neither gateway nor protocol.
    setProtocolContext(req, {
      gatewayId: gateway.id,
      organizationId: organization.id,
      protocol: gateway.type,
    });

    // Per-gateway rate limits (configured in the dashboard). Enforced
    // here so every protocol behind the unified endpoint honors them.
    const rate = await this.gatewayRateLimit.check(gateway);
    if (rate.limited) {
      if (rate.retryAfterSeconds) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      }
      throw new HttpException(rate.message ?? 'Gateway rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    const isDiscovery =
      action.startsWith('.well-known/') ||
      (action === '' && req.method === 'GET' && [GatewayType.A2A, GatewayType.ACP].includes(gateway.type));

    // Channel platform webhooks authenticate via platform signature
    // (verified by the adapter), not via almyty API keys — Slack or
    // Twilio cannot attach an x-api-key header.
    const isChannel = UnifiedGatewayDelegation.CHANNEL_TYPES.has(gateway.type);

    let auth: any = null;
    if (!isDiscovery && !isChannel) {
      const result = await this.gatewayResolver.resolveAndAuthenticate(
        orgSlug,
        `/${resourceSlug}`,
        req,
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
    // Meta's webhook verification handshake for WhatsApp Cloud is a
    // GET (hub.mode=subscribe&hub.verify_token=...&hub.challenge=...)
    // that must be answered with the raw challenge string. This is the
    // only channel GET we accept; it authenticates via the configured
    // verify_token, not a signature.
    if (req.method === 'GET' && gateway.type === GatewayType.WHATSAPP_CLOUD) {
      const challenge = WhatsAppCloudAdapter.handleVerification(
        (req.query as Record<string, any>) ?? {},
        getChannelConfig(gateway.configuration),
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
    const verified = await adapter.verifyWebhook(body, headers, getChannelConfig(gateway.configuration), rawBody);
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
      if (result === null) {
        return res.status(204).end();
      }
      if (result?.result?.sessionId || incomingSessionId) {
        res.setHeader('Mcp-Session-Id', result?.result?.sessionId || incomingSessionId);
      }
      return res.json(result);
    }

    const result = await this.mcpService.handleJsonRpc(
      body,
      gateway.organizationId,
      null,
      gateway.id,
    );

    if (result === null) {
      return res.status(204).end();
    }

    if (body?.method === 'initialize' && result?.result) {
      const sessionId = result.result.sessionId || crypto.randomUUID();
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
      const result = await this.utcpService.executeUtcpTool(body, organization.id, userId);
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
