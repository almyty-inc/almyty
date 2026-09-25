import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

import { Tool } from '../../entities/tool.entity';
import { Api } from '../../entities/api.entity';
import { Operation } from '../../entities/operation.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { findServableGatewayTool, servableToolsOnGateway } from '../gateways/gateway-servable';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuthType } from '../../entities/gateway-auth.entity';
import { ToolsService } from '../tools/tools.service';
import { ToolExecutorService, ToolExecutionResult } from '../tools/tool-executor.service';
import { ExecutionPrincipal, userPrincipal } from '../../common/authorization/execution-access.service';
import { batchAsync } from '../../common/utils/batch-async';

const UTCP_VERSION = '1.0.0';

interface ManualOptions {
  organizationId: string;
  gateway: Gateway;
  /** Where this server is reached and the organization's slug: the gateway's address is built from both. */
  baseUrl: string;
  orgSlug: string;
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
   * The manual lists exactly the gateway's servable set, every tool type
   * included, so it names the same tools MCP tools/list and the Skills
   * list do. Only the call template differs by type (`buildCallTemplate`).
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
    const gatewayBase = gatewayBaseUrl(opts.baseUrl, opts.orgSlug, gateway);

    const utcpTools: UtcpTool[] = await batchAsync(tools, 5, (tool) => this.convertToolToUtcp(tool, gateway, gatewayBase));

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
    // The manual is served (and cached) per gateway, not per caller: it is
    // exactly the gateway's servable set, the same set /execute resolves
    // against, so what the manual shows and what runs cannot disagree.
    return servableToolsOnGateway(this.gatewayToolRepository, gateway.id);
  }

  /**
   * Convert a Tool to a spec-compliant UtcpTool, with the
   * `tool_call_template` inlined per UTCP spec.
   */
  private async convertToolToUtcp(tool: Tool, gateway: Gateway, gatewayBase: string): Promise<UtcpTool> {
    return {
      name: tool.name,
      description: tool.description || `Tool ${tool.name}`,
      inputs: tool.parameters || { type: 'object', properties: {}, required: [] },
      outputs: tool.outputSchema || { type: 'object' },
      tags: this.extractToolTags(tool),
      tool_call_template: await this.buildCallTemplate(tool, gateway, gatewayBase),
    };
  }

  /**
   * How a UTCP client calls this tool.
   *
   * A tool generated from an API operation is plain HTTP against that API,
   * so its template points there, with the API's auth as placeholders.
   *
   * Every other tool runs here and nowhere else: a JavaScript or LLM tool
   * has no address of its own, and a hand-made HTTP or GraphQL tool is more
   * than its URL (stored auth, a body template, a GraphQL document, a
   * response mapping, the gateway's security policy). Its template points
   * at this gateway's per-tool execute address, authenticated with the
   * gateway's own auth. The client sends the tool's arguments as the query
   * string (what a UTCP client does with arguments that are not a body) or
   * as a JSON body; `utcpCallArguments` reads either against the tool's
   * input schema.
   */
  private async buildCallTemplate(tool: Tool, gateway: Gateway, gatewayBase: string): Promise<UtcpHttpCallTemplate> {
    // A generated tool whose operation cannot be read is still served: it
    // runs here like any other, so it is never dropped from the manual.
    const upstream = await this.upstreamCallTemplate(tool).catch(() => null);
    return upstream ?? this.gatewayCallTemplate(tool, gateway, gatewayBase);
  }

  private gatewayCallTemplate(tool: Tool, gateway: Gateway, gatewayBase: string): UtcpHttpCallTemplate {
    const template: UtcpHttpCallTemplate = {
      call_template_type: 'http',
      url: `${gatewayBase}/execute/${encodeURIComponent(tool.id)}`,
      http_method: 'POST',
      content_type: 'application/json',
    };
    const [auth] = this.buildGatewayAuth(gateway);
    if (auth) template.auth = auth;
    return template;
  }

  /** The API operation's own HTTP call, or null for a tool no operation backs. */
  private async upstreamCallTemplate(tool: Tool): Promise<UtcpHttpCallTemplate | null> {
    if (!tool.operationId) {
      return null;
    }

    const operation = await this.operationRepository.findOne({
      where: { id: tool.operationId },
      relations: { api: true },
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
        // Same field-name fragmentation as ToolAuthService: read
        // headerName / parameter / name in priority order so the
        // descriptor stays accurate regardless of which call site
        // wrote the row.
        const c: Record<string, any> = auth.config || {};
        const varName = c.headerName || c.parameter || c.name || 'X-API-Key';
        const location = (c.location || 'header') as 'header' | 'query' | 'cookie';
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
    const gatewayBase = gatewayBaseUrl(baseUrl, orgSlug, gateway);

    const info: UtcpDiscoveryInfo = {
      utcp_version: UTCP_VERSION,
      manual_version: `${gateway.id}:${gateway.updatedAt?.toISOString?.() || ''}`,
      manual_url: `${gatewayBase}/manual`,
      execute_url: `${gatewayBase}/execute`,
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

  /**
   * A call to a tool's own execute address (`<gateway>/execute/<toolId>`),
   * the one a tool's call template names when the tool runs here. The
   * arguments are the query string and the JSON body, read against the
   * tool's input schema. A tool this gateway does not serve is not found,
   * exactly as on the `execute` envelope.
   */
  async executeServedTool(
    toolId: string,
    request: { query?: unknown; body?: unknown },
    organizationId: string,
    userId: string | null,
    gatewayId: string,
    principal: ExecutionPrincipal,
  ): Promise<UtcpExecutionResult> {
    const startTime = Date.now();
    const served = await findServableGatewayTool(this.gatewayToolRepository, gatewayId, toolId);
    if (!served || served.tool.organizationId !== organizationId) {
      return this.toolNotFound(toolId, startTime);
    }
    const parameters = utcpCallArguments(served.tool.parameters, request.query, request.body);
    return this.executeUtcpTool({ toolId, parameters }, organizationId, userId, gatewayId, principal);
  }

  // UTCP Tool Execution (Proxy Mode — almyty extension)
  async executeUtcpTool(
    context: UtcpExecutionContext,
    organizationId: string,
    userId: string | null,
    gatewayId?: string | null,
    principal?: ExecutionPrincipal,
  ): Promise<UtcpExecutionResult> {
    const startTime = Date.now();

    try {
      // Through a gateway, only a tool on that gateway's manual runs. The
      // id used to go straight to the executor, so any tool of the
      // organization ran through any UTCP gateway that answered the caller.
      // A tool the manual does not carry is not found, as an unknown id is.
      if (gatewayId) {
        const served = await findServableGatewayTool(this.gatewayToolRepository, gatewayId, context?.toolId);
        if (!served || served.tool.organizationId !== organizationId) {
          return this.toolNotFound(context?.toolId, startTime);
        }
      }

      const result: ToolExecutionResult = await this.toolExecutorService.executeTool(
        context.toolId,
        context.parameters,
        {
          // userId is a UUID FK on the execution row — must be the
          // real API-key owner or null, never a placeholder string
          // like 'utcp-client' which crashes the Postgres UUID cast.
          userId: userId ?? null,
          organizationId,
          timeout: context.options?.timeout,
          retries: context.options?.retries,
          skipCache: context.options?.skipCache,
          // Lets the executor resolve and enforce this gateway_tool's
          // securityPolicy. UTCP proxy calls always arrive through a
          // gateway, so leaving it out silently skipped the policy.
          gatewayId: gatewayId ?? null,
          // The gateway's scope when the call came through one; the
          // caller's otherwise.
          principal: principal ?? userPrincipal(userId),
        },
      );

      // Out of the call's scope reads exactly as a tool that does not exist.
      if (result.notFound) {
        return this.toolNotFound(context.toolId, startTime);
      }

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

  /** The one answer for a tool this call cannot reach, whatever the reason. */
  private toolNotFound(toolId: string | undefined, startTime: number): UtcpExecutionResult {
    return {
      success: false,
      error: { code: 'TOOL_NOT_FOUND', message: 'Tool not found' },
      metadata: {
        executionTime: Date.now() - startTime,
        toolId: toolId as string,
        requestId: this.requestId(),
        timestamp: new Date().toISOString(),
      },
    };
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

/** The public address of a gateway: `<base>/<org slug><gateway endpoint>`. */
export function gatewayBaseUrl(baseUrl: string, orgSlug: string, gateway: Pick<Gateway, 'endpoint'>): string {
  return `${baseUrl.replace(/\/+$/, '')}/${orgSlug}${gateway.endpoint}`;
}

/**
 * The arguments of a call to a tool's execute address.
 *
 * A UTCP HTTP client sends every argument that is not the template's body
 * field as a query parameter, so a query value arrives as a string; it is
 * read back to the type the tool's input schema declares (number, integer,
 * boolean, or JSON for an object or array). A JSON object body is the
 * other way to send them and wins over the query string where both name
 * the same argument. An argument the schema does not declare stays as it
 * arrived; validating it is the executor's job.
 */
export function utcpCallArguments(
  schema: Record<string, any> | null | undefined,
  query: unknown,
  body: unknown,
): Record<string, any> {
  const properties: Record<string, any> = schema?.properties ?? {};
  const args: Record<string, any> = {};
  if (query && typeof query === 'object') {
    for (const [name, raw] of Object.entries(query as Record<string, unknown>)) {
      args[name] = fromQueryValue(properties[name], raw);
    }
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    Object.assign(args, body);
  }
  return args;
}

function fromQueryValue(property: Record<string, any> | undefined, raw: unknown): unknown {
  const type = Array.isArray(property?.type) ? property!.type.find((t: string) => t !== 'null') : property?.type;
  if (typeof raw !== 'string') {
    if (type === 'array' && raw !== undefined && !Array.isArray(raw)) return [raw];
    return raw;
  }
  switch (type) {
    case 'number':
    case 'integer': {
      const n = Number(raw);
      return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
    }
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : raw;
    case 'object':
    case 'array':
      try {
        return JSON.parse(raw);
      } catch {
        return type === 'array' ? [raw] : raw;
      }
    default:
      return raw;
  }
}
