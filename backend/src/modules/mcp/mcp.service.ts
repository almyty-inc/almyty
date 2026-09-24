import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcErrorCode,
  McpInitializeRequest,
  McpInitializeResult,
  McpCapabilities,
  McpSession,
  McpTool,
  McpCallToolRequest,
  McpReadResourceRequest,
  McpGetPromptRequest,
} from './types/mcp.types';

import { Tool } from '../../entities/tool.entity';
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
   * Entry point for a POSTed MCP *message*, which — in the 2025-03-26
   * revision this server negotiates for modern clients — may be a single
   * JSON-RPC message or an array batching several of them.
   *
   * An array used to be rejected outright with -32600 even though the
   * transport docstring claimed batch support and the negotiated revision
   * requires a server to accept one. (2025-06-18 removed batching again,
   * but a client asking for that version is answered 2025-03-26, so the
   * obligation stands.)
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
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (!Array.isArray(message)) {
      return this.handleJsonRpc(message, organizationId, userId, gatewayId);
    }

    // JSON-RPC 2.0 §6: an empty array is itself an Invalid Request, and is
    // answered with a single (non-array) error response.
    if (message.length === 0) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: JsonRpcErrorCode.INVALID_REQUEST,
          message: 'Invalid Request: empty batch',
        },
      };
    }

    const responses: JsonRpcResponse[] = [];
    for (const member of message) {
      const response = await this.handleJsonRpc(member, organizationId, userId, gatewayId);
      if (response !== null) {
        responses.push(response);
      }
    }

    // A batch of nothing but notifications gets no response document.
    return responses.length > 0 ? responses : null;
  }

  async handleJsonRpc(requestBody: any, organizationId: string, userId?: string, gatewayId?: string): Promise<JsonRpcResponse> {
    // JSON-RPC 2.0 §4.1: a Notification is any message with no `id`, and it
    // MUST NOT be answered. Captured before validation so that a malformed
    // notification is dropped rather than answered with an error — which
    // would itself be a reply to a notification.
    const isNotification = requestBody && typeof requestBody === 'object' && requestBody.id === undefined;
    try {
      const request = this.validateJsonRpcRequest(requestBody);

      // `bypassTeamFilter: true` on the tool-listing paths is documented as
      // safe because gateway-tool resolution gates access by gateway
      // membership. On the gateway-less path there is no gateway -- gatewayId
      // is undefined on every call from McpController and from the transports
      // -- so nothing compensated, AccessPolicyService.applyListFilter was
      // skipped, and the listing fell back to an org-only filter that exposed
      // team-scoped tools the caller holds no membership for. Hand the
      // handlers the real caller so they can scope properly.
      const caller = userId ? { id: userId } : undefined;

      this.logger.debug(`Handling MCP method: ${request.method} for org: ${organizationId}`);

      let result: any;

      switch (request.method) {
        case 'initialize':
          result = await this.handleInitialize(request.params as McpInitializeRequest, organizationId, userId, gatewayId);
          break;

        case 'ping':
          result = {};
          break;

        // Tool methods
        case 'tools/list':
          result = await this.toolHandler.handleToolsList(request.params, organizationId, gatewayId, caller);
          break;

        case 'tools/discover':
          result = await this.toolHandler.handleToolsDiscover(request.params, organizationId, gatewayId, caller);
          break;

        case 'tools/search':
          result = await this.toolHandler.handleToolsSearch(request.params, organizationId, gatewayId, caller);
          break;

        case 'tools/get':
          result = await this.toolHandler.handleToolGet(request.params, organizationId, userId);
          break;

        case 'tools/call':
          result = await this.toolHandler.handleToolCall(request.params as McpCallToolRequest, organizationId, userId, gatewayId);
          break;

        case 'completion/complete':
          result = await this.toolHandler.handleCompletionComplete(request.params, organizationId, gatewayId);
          break;

        // Resource methods
        case 'resources/list':
          result = await this.contentHandler.handleResourcesList(request.params, organizationId, gatewayId, caller);
          break;

        case 'resources/read':
          result = await this.contentHandler.handleResourceRead(request.params as McpReadResourceRequest, organizationId, caller);
          break;

        case 'resources/templates/list':
          result = await this.contentHandler.handleResourceTemplatesList();
          break;

        case 'resources/subscribe':
        case 'resources/unsubscribe':
          result = {};
          break;

        // Prompt methods
        case 'prompts/list':
          result = await this.contentHandler.handlePromptsList(request.params, organizationId, gatewayId, caller);
          break;

        case 'prompts/get':
          result = await this.contentHandler.handlePromptGet(request.params as McpGetPromptRequest, organizationId);
          break;

        // Skills methods
        case 'skills/list':
          result = await this.contentHandler.handleSkillsList(request.params, organizationId, gatewayId, caller);
          break;

        case 'skills/get':
          result = await this.contentHandler.handleSkillGet(request.params, organizationId, caller, gatewayId);
          break;

        // Logging
        case 'logging/setLevel':
          result = {};
          break;

        // Client→server notifications (fire-and-forget, no response per JSON-RPC 2.0)
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/progress':
        case 'notifications/roots/list_changed':
          return null;

        default:
          throw this.createJsonRpcError(
            JsonRpcErrorCode.METHOD_NOT_FOUND,
            `Method not found: ${request.method}`,
            request.id,
          );
      }

      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };

      if (gatewayId) {
        await this.bumpGatewayMetrics(gatewayId, organizationId, true);
      }

      // The method ran — a notification is allowed side effects — but a
      // message with no `id` gets no reply. `{"jsonrpc":"2.0","method":"ping"}`
      // used to come back as a -32600 error, which was both wrong and itself
      // a reply to a notification.
      return isNotification ? null : response;

    } catch (error) {
      if (gatewayId) {
        await this.bumpGatewayMetrics(gatewayId, organizationId, false);
      }

      // Same rule on the error path: never answer a notification, not even
      // to complain about it.
      if (isNotification) {
        this.logger.debug(`Dropping error for notification: ${error?.message}`);
        return null;
      }

      // `?? null`, not `|| null`: id `0` is a legal JSON-RPC id, and
      // rewriting it to null left the client unable to correlate the error
      // with its request — the call just hung.
      if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
        return {
          jsonrpc: '2.0',
          id: requestBody?.id ?? null,
          error,
        };
      }

      this.logger.error(`MCP JSON-RPC error: ${error.message}`, error.stack);
      return {
        jsonrpc: '2.0',
        id: requestBody?.id ?? null,
        error: {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: 'Internal server error',
        },
      };
    }
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

  private async handleInitialize(
    params: McpInitializeRequest,
    organizationId: string,
    userId?: string,
    gatewayId?: string,
  ): Promise<McpInitializeResult> {
    const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26'];
    if (!params.protocolVersion || params.protocolVersion < '2024-11-05') {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_PARAMS,
        `Unsupported protocol version: ${params.protocolVersion}. Supported: ${SUPPORTED_VERSIONS.join(', ')}`,
      );
    }

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

    // Resolve gateway name for serverInfo
    let serverName = 'almyty';
    if (gatewayId) {
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });
      if (gateway) {
        serverName = gateway.name;
      }
    }

    const serverCapabilities: McpCapabilities = {
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

    const negotiatedVersion = params.protocolVersion >= '2025-03-26'
      ? '2025-03-26'
      : '2024-11-05';

    return {
      protocolVersion: negotiatedVersion,
      capabilities: serverCapabilities,
      serverInfo: { name: serverName, version: '1.0.0' },
    };
  }

  private validateJsonRpcRequest(body: any): JsonRpcRequest {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw this.createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, 'Invalid request body');
    }

    if (body.jsonrpc !== '2.0') {
      throw this.createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC version');
    }

    if (!body.method || typeof body.method !== 'string') {
      throw this.createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, 'Missing or invalid method');
    }

    // A JSON-RPC notification is any message with no `id` — the method name
    // has nothing to do with it. Keying off a `notifications/` prefix made
    // `{"jsonrpc":"2.0","method":"ping"}` a -32600 "Missing request ID",
    // which is both wrong and a reply to a notification. There is no
    // "missing id" error to raise: an absent id simply means notification,
    // and handleJsonRpc drops the reply.
    return body as JsonRpcRequest;
  }

  private createJsonRpcError(code: JsonRpcErrorCode, message: string, id?: string | number): JsonRpcError {
    const error = new Error() as any;
    error.code = code;
    error.message = message;
    error.id = id;
    return error;
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
    params?: any,
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
