import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import {
  JsonRpcResponse,
  McpInitializeRequest,
  McpCapabilities,
  McpSession,
  McpCallToolRequest,
  McpReadResourceRequest,
  McpGetPromptRequest,
} from './types/mcp.types';
import {
  DEFAULT_CALL_CONTEXT,
  McpCallContext,
  McpSurface,
  handleMessage,
  handleSingleMessage,
} from './core/mcp-protocol-core';
import { toolsChangedChannel } from '../mcp-events/mcp-change-bus.service';

import { Gateway } from '../../entities/gateway.entity';
import { Organization } from '../../entities/organization.entity';
import { ToolsService } from '../tools/tools.service';
import { McpToolHandler } from './services/mcp-tool.handler';
import { McpContentHandler } from './services/mcp-content.handler';
import { McpServerRequestService } from './services/mcp-server-request.service';
import { MetricsRecorderService } from '../../common/metrics/metrics-recorder.service';
import { MetricType } from '../../entities/usage-metric.entity';

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly sessions = new Map<string, McpSession>();
  private readonly serverInfo = {
    name: 'almyty',
    version: '1.0.0',
  };

  constructor(
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    private toolsService: ToolsService,
    private toolHandler: McpToolHandler,
    private contentHandler: McpContentHandler,
    private serverRequestService: McpServerRequestService,
    @Optional() private readonly metrics?: MetricsRecorderService,
  ) {}

  /**
   * Entry point for a POSTed MCP *message* on a tenant gateway or the
   * gateway-less org endpoint: one JSON-RPC message, or (2025-03-26 and
   * older only) a batch. Everything protocol-shaped -- notifications,
   * batching, version negotiation, per-version result shaping -- is the
   * core's (core/mcp-protocol-core.ts); this service is the surface.
   *
   * `ctx` is the version the HTTP binding resolved for this request.
   * Omitted (in-process callers, the legacy SSE transport), the request is
   * treated as the spec's no-header default, 2025-03-26.
   *
   * Returns `null` when there is nothing to send back at all — a lone
   * notification, or a batch made up entirely of notifications. Callers
   * turn that into an empty 202 Accepted.
   */
  async handleJsonRpcMessage(
    message: any,
    organizationId: string,
    userId?: string,
    gatewayId?: string,
    ctx: McpCallContext = DEFAULT_CALL_CONTEXT,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    return handleMessage(message, this.surfaceFor(organizationId, userId, gatewayId), ctx);
  }

  /** One JSON-RPC message; null for a notification. */
  async handleJsonRpc(
    requestBody: any,
    organizationId: string,
    userId?: string,
    gatewayId?: string,
    ctx: McpCallContext = DEFAULT_CALL_CONTEXT,
  ): Promise<JsonRpcResponse> {
    return handleSingleMessage(requestBody, this.surfaceFor(organizationId, userId, gatewayId), ctx) as Promise<JsonRpcResponse>;
  }

  /**
   * The tenant gateway (or, without a gateway, the caller's organization)
   * as an MCP surface.
   *
   * `bypassTeamFilter: true` on the tool-listing paths is documented as
   * safe because gateway-tool resolution gates access by gateway
   * membership. On the gateway-less path there is no gateway, so the
   * handlers get the real caller and scope the listing to it.
   */
  private surfaceFor(organizationId: string, userId?: string, gatewayId?: string): McpSurface {
    const caller = userId ? { id: userId } : undefined;
    const tools = this.toolHandler;
    const content = this.contentHandler;
    return {
      serverInfo: async () => ({ name: await this.serverName(organizationId, gatewayId), version: '1.0.0' }),
      capabilities: () => this.capabilities(),
      listTools: (params) => tools.handleToolsList(params, organizationId, gatewayId, caller),
      callTool: (params, ctx) =>
        tools.handleToolCall(params as McpCallToolRequest, organizationId, userId, gatewayId, ctx?.paramHeaders),
      complete: (params) => tools.handleCompletionComplete(params, organizationId, gatewayId),
      listResources: (params) => content.handleResourcesList(params, organizationId, gatewayId, caller),
      readResource: (params) =>
        content.handleResourceRead(params as McpReadResourceRequest, organizationId, caller, gatewayId),
      listResourceTemplates: () => content.handleResourceTemplatesList(),
      listPrompts: (params) => content.handlePromptsList(params, organizationId, gatewayId, caller),
      getPrompt: (params) => content.handlePromptGet(params as McpGetPromptRequest, organizationId, gatewayId, caller),
      // almyty's own methods, kept for the clients that use them (design
      // doc, decision 16). Not in any MCP revision.
      extraMethods: {
        'tools/discover': (params) => tools.handleToolsDiscover(params, organizationId, gatewayId, caller),
        'tools/search': (params) => tools.handleToolsSearch(params, organizationId, gatewayId, caller),
        'tools/get': (params) => tools.handleToolGet(params, organizationId, userId, gatewayId),
        'skills/list': (params) => content.handleSkillsList(params, organizationId, gatewayId, caller),
        'skills/get': (params) => content.handleSkillGet(params, organizationId, caller, gatewayId),
      },
      // A tenant gateway's tool set changes (assignments, activations,
      // re-syncs); the org-wide surface has no channel of its own.
      toolsChangedChannel: () => (gatewayId ? toolsChangedChannel(gatewayId) : null),
      onInitialize: (params) => this.recordInitialize(params as McpInitializeRequest, organizationId, userId, gatewayId),
      onOutcome: gatewayId ? (success) => this.bumpGatewayMetrics(gatewayId, organizationId, success) : undefined,
    };
  }

  private async serverName(organizationId: string, gatewayId?: string): Promise<string> {
    if (!gatewayId) return 'almyty';
    const gateway = await this.gatewayRepository.findOne({ where: { id: gatewayId, organizationId } });
    return gateway?.name ?? 'almyty';
  }

  private capabilities(): McpCapabilities {
    return {
      // listChanged stays false: telling a legacy client about a change
      // needs a server stream, which needs sessions (owner decision 13).
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
      completions: {},
      logging: {},
      experimental: {
        almyty: {
          universalApiTranslation: true,
          multiProtocolSupport: ['mcp', 'utcp', 'a2a'],
          apiFormats: ['openapi', 'graphql', 'soap', 'protobuf'],
          progressiveDiscovery: {
            methods: ['tools/discover', 'tools/search', 'tools/get'],
            description: 'Use tools/discover for categories, tools/search for filtered results, tools/get for full schema',
          },
          skills: {
            methods: ['skills/list', 'skills/get'],
            description: 'Generate procedural skill files (YAML frontmatter + markdown) for tools and gateways',
          },
        },
      },
    };
  }

  private async bumpGatewayMetrics(
    gatewayId: string,
    organizationId: string,
    success: boolean,
  ): Promise<void> {
    try {
      await this.gatewayRepository
        .createQueryBuilder()
        .update(Gateway)
        .set({
          totalRequests: () => '"totalRequests" + 1',
          successfulRequests: success
            ? () => '"successfulRequests" + 1'
            : () => '"successfulRequests"',
          lastRequestAt: new Date(),
        })
        .where('id = :gatewayId', { gatewayId })
        .andWhere('organizationId = :organizationId', { organizationId })
        .execute();
    } catch (metricsError: any) {
      this.logger.error(`Failed to update gateway metrics: ${metricsError.message}`);
    }
  }

  private recordInitialize(
    params: McpInitializeRequest,
    organizationId: string,
    userId?: string,
    gatewayId?: string,
  ): void {
    const sessionId = uuidv4();
    const session: McpSession = {
      id: sessionId,
      clientInfo: params.clientInfo,
      capabilities: params.capabilities,
      clientCapabilities: params.capabilities as any,
      transport: 'http',
      isInitialized: true,
      createdAt: new Date(),
      lastActivity: new Date(),
      organizationId,
      userId,
    };
    this.sessions.set(sessionId, session);
    this.logger.log(`MCP session initialized: ${sessionId} for org: ${organizationId}`);
    this.metrics?.record(MetricType.MCP_SESSION, {
      organizationId,
      userId: userId || null,
      gatewayId: gatewayId || null,
    });
  }

  // Session Management
  async getSession(sessionId: string): Promise<McpSession | null> {
    return this.sessions.get(sessionId) || null;
  }

  async removeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.logger.log(`MCP session removed: ${sessionId}`);
  }

  async getActiveSessions(organizationId: string): Promise<McpSession[]> {
    return Array.from(this.sessions.values()).filter(
      session => session.organizationId === organizationId,
    );
  }

  async broadcastNotification(
    organizationId: string,
    method: string,
    _params?: any,
  ): Promise<void> {
    const sessions = await this.getActiveSessions(organizationId);
    for (const session of sessions) {
      this.logger.debug(`Broadcasting notification ${method} to session ${session.id}`);
    }
  }

  // Server-to-client requests
  get serverRequests(): McpServerRequestService {
    return this.serverRequestService;
  }

  async healthCheck(): Promise<{
    status: string;
    activeSessions: number;
    serverInfo: any;
  }> {
    return {
      status: 'healthy',
      activeSessions: this.sessions.size,
      serverInfo: this.serverInfo,
    };
  }
}
