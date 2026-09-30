import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AxiosRequestConfig } from 'axios';
import { Repository } from 'typeorm';

import { Tool } from '../../../entities/tool.entity';
import { Api } from '../../../entities/api.entity';
import { ApiSchema } from '../../../entities/api-schema.entity';
import { Operation } from '../../../entities/operation.entity';
import { Organization } from '../../../entities/organization.entity';
import { decideToolRequest } from '../../../common/security/gateway-tool-policy';
import { ToolAuthService } from '../services/tool-auth.service';
import { GrpcCallerService } from './grpc-caller.service';
import { decideToolEgress } from './tool-egress';
import { ToolExecutionOptions, ToolExecutionResult } from '../tool-execution.types';
import { getByDotPath, generateRequestId } from '../tool-execution-utils';

/**
 * gRPC / Protobuf execution paths split out of ToolProtocolExecutor.
 * Covers the structured `grpcConfig` shape (a tool made on the Create
 * tool page, carrying its own proto) and the operation-based path (tools
 * generated from an imported proto). Both make a real gRPC call through
 * GrpcCallerService, with the same auth and egress rules.
 */
@Injectable()
export class ToolGrpcExecutor {
  private readonly logger = new Logger(ToolGrpcExecutor.name);

  constructor(
    private readonly authService: ToolAuthService,
    private readonly grpcCaller: GrpcCallerService,
    @InjectRepository(ApiSchema)
    private readonly apiSchemaRepo: Repository<ApiSchema>,
    // The organization's egress allowlist; see decideToolEgress.
    @Optional()
    @InjectRepository(Organization)
    private readonly organizations?: Repository<Organization>,
  ) {}

  /**
   * A gRPC tool made on the Create tool page. It carries its own proto
   * (`protoDefinition`), the service and the method, and the server's
   * address (`endpoint`: https:// for TLS, http:// for plaintext). The
   * call is a real gRPC call through the same caller an imported proto's
   * tools use; whether the method streams is read from the proto. A tool
   * linked to an imported gRPC API may leave the proto and endpoint out:
   * the API's latest schema and base URL are used.
   */
  async executeGrpcConfig(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const grpcConfig = tool.grpcConfig!;
    const api = tool.api ?? tool.operation?.api ?? null;
    const endpoint = grpcConfig.endpoint || api?.baseUrl || '';
    if (!grpcConfig.serviceName || !grpcConfig.methodName) {
      return this.failure(`gRPC tool ${tool.name} names no service or method.`, startTime);
    }

    const egress = await decideToolEgress(endpoint, api?.organizationId ?? tool.organizationId, this.organizations);
    if (egress.error) {
      this.logger.warn(`SSRF blocked for gRPC tool ${tool.name}: ${egress.error}`);
      return this.blocked(egress.error, startTime);
    }

    // Gateway-tool security policy: domains and require-HTTPS judge the
    // endpoint; a gRPC call is a POST on the wire.
    const grpcPolicy = decideToolRequest(options.securityPolicy, endpoint, 'POST');
    if (!grpcPolicy.allowed) {
      this.logger.warn(`Security policy blocked gRPC tool ${tool.name}: ${grpcPolicy.reason}`);
      return this.blocked(grpcPolicy.reason!, startTime);
    }

    let protoSource = grpcConfig.protoDefinition || '';
    if (!protoSource && api) {
      const schemaRow = await this.apiSchemaRepo.findOne({
        where: { apiId: api.id },
        order: { createdAt: 'DESC' },
      });
      protoSource = schemaRow?.rawSchema || '';
    }
    if (!protoSource) {
      return this.failure(
        `gRPC tool ${tool.name} has no proto definition. Paste or upload the .proto on the tool.`,
        startTime,
      );
    }

    let request: Record<string, any> = parameters || {};
    if (grpcConfig.requestMapping && Object.keys(grpcConfig.requestMapping).length > 0) {
      request = {};
      for (const [k, v] of Object.entries(grpcConfig.requestMapping)) {
        if (typeof v !== 'string') {
          request[k] = v;
          continue;
        }
        const whole = /^\{(\w+)\}$/.exec(v);
        if (whole) {
          if (whole[1] in parameters) request[k] = parameters[whole[1]];
          continue;
        }
        request[k] = v.replace(/\{(\w+)\}/g, (_, n) =>
          n in parameters ? String(parameters[n]) : `{${n}}`,
        );
      }
    }

    const metadata = await this.authMetadata(tool, api, options);

    const callRes = await this.grpcCaller.call({
      protoSource,
      baseUrl: endpoint,
      tls: (api as any)?.configuration?.tls,
      serviceName: grpcConfig.serviceName,
      methodName: grpcConfig.methodName,
      request,
      metadata,
      timeoutMs: options.timeout ?? tool.configuration?.timeout ?? 30000,
      pinDns: true,
      pinDnsExemptHost: egress.exemptHost,
    });

    const baseMeta: Record<string, any> = { grpcStatus: callRes.code, requestId: generateRequestId() };
    if (callRes.streamMessageCount !== undefined) baseMeta.streamMessageCount = callRes.streamMessageCount;
    if (callRes.streamTruncated) baseMeta.streamTruncated = true;
    if (!callRes.success) {
      return { ...this.failure(`gRPC request failed: ${callRes.error}`, startTime), metadata: baseMeta };
    }
    let data = callRes.data;
    if (grpcConfig.responseMapping?.dataPath) {
      data = getByDotPath(data, grpcConfig.responseMapping.dataPath);
    }
    return { ...this.success(data, startTime), metadata: baseMeta };
  }

  /**
   * The credential a gRPC call carries, as metadata. The auth service
   * writes headers onto an axios config; the same headers, lower-cased,
   * are the gRPC metadata. An API's auth when the tool is linked to one,
   * else the credential the tool itself points at.
   */
  private async authMetadata(
    tool: Tool,
    api: Api | null,
    options: ToolExecutionOptions,
  ): Promise<Record<string, string>> {
    const holder: AxiosRequestConfig = { headers: {} };
    if (api) await this.authService.applyApiAuth(holder, api, options);
    else if (tool.authConfig) await this.authService.applyToolAuth(holder, tool, options);
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries((holder.headers || {}) as Record<string, any>)) {
      if (typeof v === 'string') metadata[k.toLowerCase()] = v;
    }
    return metadata;
  }

  // ─── gRPC (legacy operation-based) ─────────────────────────────

  async executeProtobufOperation(
    tool: Tool,
    operation: Operation,
    api: Api,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const baseCheck = await decideToolEgress(api.baseUrl, api.organizationId ?? tool.organizationId, this.organizations);
    if (baseCheck.error) {
      this.logger.warn(`SSRF blocked for gRPC tool ${tool.name}: ${baseCheck.error}`);
      return this.blocked(baseCheck.error, startTime);
    }

    const basePolicy = decideToolRequest(options.securityPolicy, api.baseUrl, 'POST');
    if (!basePolicy.allowed) {
      this.logger.warn(`Security policy blocked gRPC tool ${tool.name}: ${basePolicy.reason}`);
      return this.blocked(basePolicy.reason!, startTime);
    }

    // Resolve service + method from the parser-emitted endpoint
    // shape `/grpc/{Service}/{Method}`. Fall back to operation.name
    // (the parser writes the method name there too).
    const m = (operation.endpoint || '').match(/^\/grpc\/([^/]+)\/([^/]+)/);
    if (!m) {
      return this.failure(
        `gRPC operation has malformed endpoint: ${operation.endpoint}. ` +
          `Expected /grpc/{ServiceName}/{MethodName}.`,
        startTime,
      );
    }
    const [, serviceName, methodName] = m;

    // Pull the .proto source from the most recent ApiSchema row for
    // this api. We need this every call — proto is per-api, not
    // per-tool, and embedding the whole proto on each Tool entity
    // would balloon the row size.
    const schemaRow = await this.apiSchemaRepo.findOne({
      where: { apiId: api.id },
      order: { createdAt: 'DESC' },
    });
    if (!schemaRow?.rawSchema) {
      return this.failure(
        `gRPC tool ${tool.name} has no proto schema on file (api_schemas.rawSchema is empty for api ${api.id}). Re-import the proto.`,
        startTime,
      );
    }

    // Build metadata for the call. Reuse the auth service to pick
    // up bearer/api_key/oauth2 headers exactly the way HTTP tools
    // do, then copy them onto the gRPC Metadata.
    const metadata = await this.authMetadata(tool, api, options);

    // Streaming flags persisted by the parser (operation.metadata.
     // requestStream / responseStream). Caller passes a single message
    // for unary + server-streaming, an array for client-streaming +
    // bidi. The executor doesn't reshape parameters here — it trusts
    // the upstream gateway to feed the right shape because the
    // parameters JSON schema for streaming methods will say `type:
    // 'array'`.
    const opMeta = (operation.metadata as any) || {};
    const requestStream = !!opMeta.requestStream;
    const responseStream = !!opMeta.responseStream;

    const callRes = await this.grpcCaller.call({
      protoSource: schemaRow.rawSchema,
      baseUrl: api.baseUrl,
      tls: (api as any).configuration?.tls,
      serviceName,
      methodName,
      request: parameters || {},
      metadata,
      timeoutMs: options.timeout ?? tool.configuration?.timeout ?? 30000,
      requestStream,
      responseStream,
      // baseUrl is tenant-written: dial the address the pinned lookup
      // approved, not whatever grpc-js resolves on its own.
      pinDns: true,
      pinDnsExemptHost: baseCheck.exemptHost,
    });

    const executionTime = Date.now() - startTime;
    const baseMeta: Record<string, any> = {
      grpcStatus: callRes.code,
      requestId: generateRequestId(),
    };
    if (responseStream || requestStream) {
      baseMeta.streaming = {
        request: requestStream,
        response: responseStream,
      };
      if (callRes.streamMessageCount !== undefined) {
        baseMeta.streamMessageCount = callRes.streamMessageCount;
      }
      if (callRes.streamTruncated) {
        baseMeta.streamTruncated = true;
      }
    }
    if (callRes.success) {
      return {
        success: true,
        data: callRes.data,
        executionTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: baseMeta,
      };
    }
    return {
      success: false,
      error: `gRPC request failed: ${callRes.error}`,
      executionTime,
      cached: false,
      rateLimited: false,
      retryCount: 0,
      metadata: baseMeta,
    };
  }

  private success(data: any, startTime: number): ToolExecutionResult {
    return {
      success: true,
      data,
      executionTime: Date.now() - startTime,
      cached: false,
      rateLimited: false,
      retryCount: 0,
    };
  }

  private failure(message: string, startTime: number): ToolExecutionResult {
    return {
      success: false,
      error: message,
      executionTime: Date.now() - startTime,
      cached: false,
      rateLimited: false,
      retryCount: 0,
    };
  }

  private blocked(reason: string, startTime: number): ToolExecutionResult {
    return {
      success: false,
      error: `Blocked: ${reason}`,
      executionTime: Date.now() - startTime,
      cached: false,
      rateLimited: false,
      retryCount: 0,
    };
  }
}
