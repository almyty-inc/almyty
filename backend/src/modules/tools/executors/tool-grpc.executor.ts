import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosRequestConfig } from 'axios';
import { Repository } from 'typeorm';

import { Tool } from '../../../entities/tool.entity';
import { Api } from '../../../entities/api.entity';
import { ApiSchema } from '../../../entities/api-schema.entity';
import { Operation } from '../../../entities/operation.entity';
import { validateUrl, sanitizeHeaders } from '../../../common/security/url-validator';
import { ToolAuthService } from '../services/tool-auth.service';
import { GrpcCallerService } from './grpc-caller.service';
import { ToolExecutionOptions, ToolExecutionResult } from '../tool-execution.types';
import { getByDotPath, generateRequestId } from '../tool-execution-utils';

const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
const MAX_BODY_LENGTH = 5 * 1024 * 1024;

/**
 * gRPC / Protobuf execution paths split out of ToolProtocolExecutor.
 * Covers the structured `grpcConfig` shape (manual tool builder) and
 * the legacy operation-based path (auto-generated tools from a
 * parsed proto schema). Both share auth + SSRF hygiene via the
 * passed-in services.
 */
@Injectable()
export class ToolGrpcExecutor {
  private readonly logger = new Logger(ToolGrpcExecutor.name);

  constructor(
    private readonly authService: ToolAuthService,
    private readonly grpcCaller: GrpcCallerService,
    @InjectRepository(ApiSchema)
    private readonly apiSchemaRepo: Repository<ApiSchema>,
  ) {}


  async executeGrpcConfig(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const api = tool.api ?? tool.operation?.api ?? null;
    const endpoint = tool.grpcConfig!.endpoint || api?.baseUrl || '';
    const url = `${endpoint}/${tool.grpcConfig!.serviceName}/${tool.grpcConfig!.methodName}`;

    const urlCheck = validateUrl(url);
    if (!urlCheck.valid) {
      this.logger.warn(`SSRF blocked for gRPC tool ${tool.name}: ${urlCheck.error}`);
      return this.blocked(urlCheck.error!, startTime);
    }

    const requestData: Record<string, any> = {};
    if (tool.grpcConfig!.requestMapping) {
      for (const [k, v] of Object.entries(tool.grpcConfig!.requestMapping)) {
        requestData[k] =
          typeof v === 'string'
            ? v.replace(/\{(\w+)\}/g, (_, n) =>
                n in parameters ? String(parameters[n]) : `{${n}}`,
              )
            : v;
      }
    } else {
      Object.assign(requestData, parameters);
    }

    const axConfig: AxiosRequestConfig = {
      method: 'POST',
      url,
      headers: sanitizeHeaders({
        'Content-Type': 'application/json',
        ...(api?.headers || {}),
      }),
      data: requestData,
      timeout: tool.configuration?.timeout ?? 30000,
      maxContentLength: MAX_CONTENT_LENGTH,
      maxBodyLength: MAX_BODY_LENGTH,
      signal: options.signal,
    };

    if (api) await this.authService.applyApiAuth(axConfig, api, options);

    try {
      const response = await axios(axConfig);
      let data = response.data;
      if (tool.grpcConfig!.responseMapping?.dataPath) {
        data = getByDotPath(data, tool.grpcConfig!.responseMapping.dataPath);
      }
      return this.success(data, startTime);
    } catch (error: any) {
      return this.failure(error.message, startTime);
    }
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
    const baseValidation = validateUrl(api.baseUrl);
    if (!baseValidation.valid) {
      this.logger.warn(`SSRF blocked for gRPC tool ${tool.name}: ${baseValidation.error}`);
      return this.blocked(baseValidation.error!, startTime);
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
    const fakeConfig: AxiosRequestConfig = { headers: {} };
    await this.authService.applyApiAuth(fakeConfig, api, options);
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries((fakeConfig.headers || {}) as Record<string, any>)) {
      if (typeof v === 'string') metadata[k.toLowerCase()] = v;
    }

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
