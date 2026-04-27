import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import * as Redis from 'ioredis';

import {
  UtcpManual,
  UtcpTool,
  UtcpHttpCallTemplate,
  UtcpAuth,
  UtcpDiscoveryInfo,
  UtcpExecutionContext,
  UtcpExecutionResult,
} from './types/utcp.types';

import { Tool, ToolStatus } from '../../entities/tool.entity';
import { Api } from '../../entities/api.entity';
import { Operation } from '../../entities/operation.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuthType } from '../../entities/gateway-auth.entity';
import { ToolsService } from '../tools/tools.service';
import { ToolExecutorService, ToolExecutionResult } from '../tools/tool-executor.service';
import { batchAsyncSettled } from '../../common/utils/batch-async';

const UTCP_VERSION = '1.0.0';

interface ManualOptions {
  organizationId: string;
  gateway: Gateway;
}

interface DiscoveryOptions {
  organizationId: string;
  gateway: Gateway;
  baseUrl: string;
  orgSlug: string;
}

@Injectable()
export class UtcpService {
  private readonly logger = new Logger(UtcpService.name);

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Api)
    private apiRepository: Repository<Api>,
    @InjectRepository(Operation)
    private operationRepository: Repository<Operation>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    private toolsService: ToolsService,
    private toolExecutorService: ToolExecutorService,
    @InjectRedis() private readonly redis: Redis.Redis,
  ) {}

  /**
   * Build a spec-compliant UTCP manual scoped to a gateway.
   *
   * Spec: https://utcp.io — top-level fields are `utcp_version`,
   * `manual_version`, `tools`. Each tool carries an inline
   * `tool_call_template`. Snake_case throughout — UTCP SDKs (python,
   * typescript, go) parse against these exact field names.
   *
   * Tools are always scoped to the gateway's active assignments;
   * there is no "global manual" surface — each gateway owns its
   * own slice of the org's tools.
   */
  async generateManual(opts: ManualOptions): Promise<UtcpManual> {
    const { organizationId, gateway } = opts;
    const cacheKey = `utcp:manual:gw:${gateway.id}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // cache miss is non-fatal
    }

    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const tools = await this.resolveTools(gateway);

    const utcpToolResults = await batchAsyncSettled(tools, 5, async (tool) => {
      return this.convertToolToUtcp(tool);
    });

    const utcpTools: UtcpTool[] = utcpToolResults.filter((t): t is UtcpTool => !!t);

    const manual: UtcpManual = {
      utcp_version: UTCP_VERSION,
      manual_version: `${gateway.id}:${gateway.updatedAt?.toISOString?.() || ''}`,
      tools: utcpTools,
    };

    try {
      await this.redis.setex(cacheKey, 300, JSON.stringify(manual));
    } catch {
      // non-critical
    }

    return manual;
  }

  private async resolveTools(gateway: Gateway): Promise<Tool[]> {
    const assignments = await this.gatewayToolRepository.find({
      where: { gatewayId: gateway.id, isActive: true },
      relations: ['tool'],
    });
    return assignments
      .map((a) => a.tool)
      .filter((t): t is Tool => !!t && t.status === ToolStatus.ACTIVE);
  }

  /**
   * Convert a Tool to a spec-compliant UtcpTool, with the
   * `tool_call_template` inlined per UTCP spec.
   */
  private async convertToolToUtcp(tool: Tool): Promise<UtcpTool | null> {
    const callTemplate = await this.buildCallTemplate(tool);
    if (!callTemplate) {
      return null;
    }

    return {
      name: tool.name,
      description: tool.description || `Tool ${tool.name}`,
      inputs: tool.parameters || { type: 'object', properties: {}, required: [] },
      outputs: tool.outputSchema || { type: 'object' },
      tags: this.extractToolTags(tool),
      tool_call_template: callTemplate,
    };
  }

  /**
   * Build an HttpCallTemplate from the underlying API + operation.
   * Returns null if the tool is not backed by an API operation
   * (manual JS / LLM tools — no http target).
   */
  private async buildCallTemplate(tool: Tool): Promise<UtcpHttpCallTemplate | null> {
    if (!tool.operationId) {
      return null;
    }

    const operation = await this.operationRepository.findOne({
      where: { id: tool.operationId },
      relations: ['api'],
    });
    if (!operation || !operation.api) {
      return null;
    }

    const api = operation.api;
    const httpMethod = (operation.method || 'GET').toUpperCase() as UtcpHttpCallTemplate['http_method'];
    const headerFields = Object.keys(operation.parameters?.header || {});
    const hasBody = !!operation.parameters?.body && ['POST', 'PUT', 'PATCH'].includes(httpMethod);

    const template: UtcpHttpCallTemplate = {
      call_template_type: 'http',
      url: `${api.baseUrl}${operation.endpoint}`,
      http_method: httpMethod,
      content_type: this.getContentType(operation),
      headers: { ...(api.headers || {}) },
    };

    if (hasBody) {
      template.body_field = 'body';
    }
    if (headerFields.length > 0) {
      template.header_fields = headerFields;
    }

    const auth = this.buildApiAuth(api);
    if (auth) {
      template.auth = auth;
    }

    return template;
  }

  /**
   * Map the API's stored auth into a UTCP-spec auth descriptor.
   *
   * Returns the auth shape only — the API key, password, or client
   * secret is replaced with a `{{...}}` template placeholder. The
   * manual is served to anyone with gateway access, so leaking the
   * raw secret would be a privilege-escalation path.
   */
  private buildApiAuth(api: Api): UtcpAuth | undefined {
    const auth = api.authentication;
    if (!auth || auth.type === 'none') {
      return undefined;
    }

    switch (auth.type) {
      case 'api_key': {
        const varName = auth.config?.parameter || 'X-API-Key';
        const location = (auth.config?.location || 'header') as 'header' | 'query' | 'cookie';
        return {
          auth_type: 'api_key',
          api_key: `{{${api.id.toUpperCase()}_API_KEY}}`,
          var_name: varName,
          location,
        };
      }
      case 'bearer':
        return {
          auth_type: 'api_key',
          api_key: `Bearer {{${api.id.toUpperCase()}_TOKEN}}`,
          var_name: 'Authorization',
          location: 'header',
        };
      case 'basic':
        return {
          auth_type: 'basic',
          username: `{{${api.id.toUpperCase()}_USERNAME}}`,
          password: `{{${api.id.toUpperCase()}_PASSWORD}}`,
        };
      case 'oauth2':
        return {
          auth_type: 'oauth2',
          client_id: `{{${api.id.toUpperCase()}_CLIENT_ID}}`,
          client_secret: `{{${api.id.toUpperCase()}_CLIENT_SECRET}}`,
          token_url: auth.config?.tokenUrl || '',
          scope: auth.config?.scope,
        };
      default:
        return undefined;
    }
  }

  /**
   * Build a UTCP auth descriptor from a gateway's auth configuration.
   * This is what the gateway requires from clients (NOT the API's auth)
   * — used in the discovery payload so clients know how to call /execute.
   */
  buildGatewayAuth(gateway: Gateway): UtcpAuth[] {
    const configs = gateway.authConfigs?.filter((a) => a.isActive) || [];
    const result: UtcpAuth[] = [];
    // Dedupe by (auth_type, var_name) — a gateway can carry an
    // auto-created API_KEY config plus a manually-added one; the
    // discovery payload should advertise each scheme once, not echo
    // every row.
    const seen = new Set<string>();
    const push = (key: string, auth: UtcpAuth) => {
      if (seen.has(key)) return;
      seen.add(key);
      result.push(auth);
    };

    for (const cfg of configs) {
      switch (cfg.type) {
        case GatewayAuthType.API_KEY: {
          const varName = cfg.configuration?.keyHeader || 'x-api-key';
          push(`api_key:${varName}`, {
            auth_type: 'api_key',
            api_key: `{{GATEWAY_${gateway.id.toUpperCase()}_API_KEY}}`,
            var_name: varName,
            location: 'header',
          });
          break;
        }
        case GatewayAuthType.BEARER_TOKEN:
        case GatewayAuthType.JWT:
          push('bearer:Authorization', {
            auth_type: 'api_key',
            api_key: `Bearer {{GATEWAY_${gateway.id.toUpperCase()}_TOKEN}}`,
            var_name: 'Authorization',
            location: 'header',
          });
          break;
        case GatewayAuthType.BASIC_AUTH:
          push('basic', {
            auth_type: 'basic',
            username: `{{GATEWAY_${gateway.id.toUpperCase()}_USERNAME}}`,
            password: `{{GATEWAY_${gateway.id.toUpperCase()}_PASSWORD}}`,
          });
          break;
        case GatewayAuthType.OAUTH2:
          push('oauth2', {
            auth_type: 'oauth2',
            client_id: `{{GATEWAY_${gateway.id.toUpperCase()}_CLIENT_ID}}`,
            client_secret: `{{GATEWAY_${gateway.id.toUpperCase()}_CLIENT_SECRET}}`,
            token_url: cfg.configuration?.tokenUrl || '',
            scope: cfg.configuration?.scope,
          });
          break;
        case GatewayAuthType.NONE:
        default:
          break;
      }
    }
    return result;
  }

  /**
   * Discovery descriptor served at `.well-known/utcp`.
   * Points clients at the manual and surfaces the gateway's auth
   * requirements so they know what to send to /execute.
   */
  getDiscoveryInfo(opts: DiscoveryOptions): UtcpDiscoveryInfo {
    const { gateway, baseUrl, orgSlug } = opts;
    const manualUrl = gateway
      ? `${baseUrl}/${orgSlug}${gateway.endpoint}/manual`
      : `${baseUrl}/utcp/global/manual`;

    const info: UtcpDiscoveryInfo = {
      utcp_version: UTCP_VERSION,
      manual_version: gateway
        ? `${gateway.id}:${gateway.updatedAt?.toISOString?.() || ''}`
        : 'global',
      manual_url: manualUrl,
      server: {
        name: 'almyty',
        version: UTCP_VERSION,
        description: 'almyty UTCP gateway',
      },
    };

    if (gateway) {
      const auths = this.buildGatewayAuth(gateway);
      if (auths.length === 1) {
        info.auth = auths[0];
      } else if (auths.length > 1) {
        info.auth = auths;
      }
    }

    return info;
  }

  // UTCP Tool Execution (Proxy Mode — almyty extension)
  async executeUtcpTool(
    context: UtcpExecutionContext,
    organizationId: string,
    userId?: string,
  ): Promise<UtcpExecutionResult> {
    const startTime = Date.now();

    try {
      const result: ToolExecutionResult = await this.toolExecutorService.executeTool(
        context.toolId,
        context.parameters,
        {
          userId: userId || 'utcp-client',
          organizationId,
          timeout: context.options?.timeout,
          retries: context.options?.retries,
          skipCache: context.options?.skipCache,
        },
      );

      return {
        success: result.success,
        data: result.data,
        error: result.error
          ? {
              code: 'EXECUTION_ERROR',
              message: result.error,
              details: result.metadata,
            }
          : undefined,
        metadata: {
          executionTime: result.executionTime,
          toolId: context.toolId,
          requestId: this.requestId(),
          timestamp: new Date().toISOString(),
          cached: result.cached,
          retryCount: result.retryCount,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error?.message || 'unknown error',
        },
        metadata: {
          executionTime: Date.now() - startTime,
          toolId: context.toolId,
          requestId: this.requestId(),
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private extractToolTags(tool: Tool): string[] {
    const tags: string[] = [];
    if (tool.metadata?.sourceApi?.type) tags.push(tool.metadata.sourceApi.type);
    if (tool.metadata?.autoGenerated) tags.push('auto-generated');
    return tags;
  }

  private getContentType(operation: Operation): string {
    switch (operation.method?.toUpperCase()) {
      case 'GET':
      case 'DELETE':
      case 'HEAD':
        return 'application/json';
      case 'POST':
      case 'PUT':
      case 'PATCH':
        return operation.metadata?.contentType || 'application/json';
      default:
        return 'application/json';
    }
  }

  private requestId(): string {
    return `utcp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
}
