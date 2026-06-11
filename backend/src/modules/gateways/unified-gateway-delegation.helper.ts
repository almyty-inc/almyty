import { HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request, Response } from 'express';
import * as crypto from 'crypto';

import { Agent } from '../../entities/agent.entity';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { MetricsRecorderService } from '../../common/metrics/metrics-recorder.service';
import { MetricType, MetricStatus } from '../../entities/usage-metric.entity';
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
 * MCP / UTCP / A2A / ACP service based on `gateway.type`.
 */
@Injectable()
export class UnifiedGatewayDelegation {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepository: Repository<Agent>,
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

    const isDiscovery =
      action.startsWith('.well-known/') ||
      (action === '' && req.method === 'GET' && [GatewayType.A2A, GatewayType.ACP].includes(gateway.type));

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
        return this.delegateUtcp(gateway, organization, action, auth, req, res, body);
      case GatewayType.A2A:
        return this.delegateA2A(gateway, organization, action, req, res, body);
      case GatewayType.ACP:
        return this.delegateACP(gateway, organization, action, req, res, body);
      // TODO: Channel gateway types (slack, discord, telegram, etc.)
      // will be routed to ChannelGatewayService.handleInboundMessage here.
      default:
        throw new HttpException(
          `Gateway type '${gateway.type}' does not support direct requests. Use the protocol-specific endpoint or the Skills CLI.`,
          HttpStatus.BAD_REQUEST,
        );
    }
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
}
