/**
 * GraphQL / SOAP / gRPC tool execution.
 *
 * Each of these protocols has two entry points: a structured
 * config shape (`graphqlConfig`, `soapConfig`, `grpcConfig`) for
 * tools created manually via the tool builder, and a legacy
 * operation-based path for tools that were auto-generated from a
 * parsed API schema. Both paths share the same auth / SSRF / size
 * hygiene via the shared auth service and the URL validator.
 *
 * Extracted from the old tool-executor.service.ts monolith. The
 * SOAP body template now runs user-supplied parameter values
 * through escapeXml so a value containing `</soap:Body>` can't
 * break out of its containing element and inject additional XML.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Repository } from 'typeorm';
import { Tool } from '../../../entities/tool.entity';
import { Api } from '../../../entities/api.entity';
import { ApiSchema } from '../../../entities/api-schema.entity';
import { Operation } from '../../../entities/operation.entity';
import { validateUrl, sanitizeHeaders } from '../../../common/security/url-validator';
import { ToolAuthService } from '../services/tool-auth.service';
import { GrpcCallerService } from './grpc-caller.service';
import {
  ToolExecutionOptions,
  ToolExecutionResult,
  GraphQLRequest,
  SOAPRequest,
} from '../tool-execution.types';
import {
  getByDotPath,
  escapeXml,
  generateRequestId,
} from '../tool-execution-utils';

const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
const MAX_BODY_LENGTH = 5 * 1024 * 1024;

/**
 * Join an API baseUrl with an operation endpoint path, idempotently
 * — i.e. if the user already pasted the full path into baseUrl
 * (`https://countries.trevorblades.com/graphql`) and the operation
 * endpoint is also `/graphql`, don't end up with `/graphql/graphql`.
 *
 * Rules:
 *   - empty endpoint  → return baseUrl
 *   - baseUrl already ends with the endpoint path → return baseUrl
 *   - otherwise → strip trailing `/` from baseUrl, ensure exactly
 *     one `/` between, append endpoint
 */
function joinApiUrl(baseUrl: string, endpoint?: string): string {
  if (!endpoint) return baseUrl;
  const base = (baseUrl || '').replace(/\/+$/, '');
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (base.endsWith(path)) return base;
  return `${base}${path}`;
}

@Injectable()
export class ToolProtocolExecutor {
  private readonly logger = new Logger(ToolProtocolExecutor.name);

  constructor(
    private readonly authService: ToolAuthService,
    private readonly grpcCaller: GrpcCallerService,
    @InjectRepository(ApiSchema)
    private readonly apiSchemaRepo: Repository<ApiSchema>,
  ) {}

  // ─── GraphQL (structured config) ───────────────────────────────

  async executeGraphQLConfig(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const api = tool.api ?? tool.operation?.api ?? null;
    const endpoint = tool.graphqlConfig!.endpoint || api?.baseUrl || '';

    const urlCheck = validateUrl(endpoint);
    if (!urlCheck.valid) {
      this.logger.warn(`SSRF blocked for GraphQL tool ${tool.name}: ${urlCheck.error}`);
      return this.blocked(urlCheck.error!, startTime);
    }

    const variables: Record<string, any> = {};
    if (tool.graphqlConfig!.variables) {
      for (const [k, v] of Object.entries(tool.graphqlConfig!.variables)) {
        variables[k] =
          typeof v === 'string'
            ? v.replace(/\{(\w+)\}/g, (_, n) =>
                n in parameters ? String(parameters[n]) : `{${n}}`,
              )
            : v;
      }
    } else {
      Object.assign(variables, parameters);
    }

    const headers: Record<string, string> = sanitizeHeaders({
      'Content-Type': 'application/json',
      ...(api?.headers || {}),
      ...(tool.graphqlConfig!.headers || {}),
    });

    const axConfig: AxiosRequestConfig = {
      method: 'POST',
      url: endpoint,
      headers,
      data: { query: tool.graphqlConfig!.query, variables },
      timeout: tool.configuration?.timeout ?? 30000,
      maxContentLength: MAX_CONTENT_LENGTH,
      maxBodyLength: MAX_BODY_LENGTH,
      signal: options.signal,
    };

    if (api) await this.authService.applyApiAuth(axConfig, api, options);

    try {
      const response = await axios(axConfig);
      let data = response.data;
      if (tool.graphqlConfig!.responseMapping?.dataPath) {
        data = getByDotPath(data, tool.graphqlConfig!.responseMapping.dataPath);
      }
      return this.success(data, startTime);
    } catch (error: any) {
      return this.failure(error.message, startTime);
    }
  }

  // ─── GraphQL (legacy operation-based) ──────────────────────────

  async executeGraphQLOperation(
    tool: Tool,
    operation: Operation,
    api: Api,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const targetUrl = joinApiUrl(api.baseUrl, operation.endpoint);

    const urlCheck = validateUrl(targetUrl);
    if (!urlCheck.valid) {
      this.logger.warn(`SSRF blocked for GraphQL tool ${tool.name}: ${urlCheck.error}`);
      return this.blocked(urlCheck.error!, startTime);
    }

    // If the caller passed an explicit `variables` object, use it.
    // Otherwise, treat the remaining parameters as variables — but
    // strip the three meta keys so they don't leak into the GraphQL
    // variables payload alongside the operation that describes them.
    let graphqlVariables: Record<string, any> | undefined;
    if (parameters.variables !== undefined) {
      graphqlVariables = parameters.variables;
    } else {
      const { query: _q, variables: _v, operationName: _o, ...rest } = parameters;
      graphqlVariables = rest;
    }

    const graphqlRequest: GraphQLRequest = {
      query: parameters.query || operation.metadata?.query,
      variables: graphqlVariables,
      operationName: parameters.operationName,
    };

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: targetUrl,
      timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
      maxContentLength: MAX_CONTENT_LENGTH,
      maxBodyLength: MAX_BODY_LENGTH,
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LLM-Tool-Gateway/1.0',
      },
      data: graphqlRequest,
    };

    await this.authService.applyApiAuth(config, api, options);

    try {
      const response: AxiosResponse = await axios(config);

      if (response.data.errors && response.data.errors.length > 0) {
        return {
          success: false,
          error: `GraphQL errors: ${response.data.errors.map((e: any) => e.message).join(', ')}`,
          data: response.data,
          executionTime: Date.now() - startTime,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: this.httpMeta(response),
        };
      }

      return {
        success: true,
        data: response.data.data,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: this.httpMeta(response),
      };
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        return {
          success: false,
          error: `GraphQL request failed: ${error.response?.data?.message || error.message}`,
          executionTime: Date.now() - startTime,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: {
            httpStatus: error.response?.status,
            headers: error.response?.headers as Record<string, string>,
            requestId:
              (error.response?.headers?.['x-request-id'] as string) || generateRequestId(),
          },
        };
      }
      throw error;
    }
  }

  // ─── SOAP (structured config) ──────────────────────────────────

  async executeSOAPConfig(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const api = tool.api ?? tool.operation?.api ?? null;
    const endpoint = tool.soapConfig!.endpoint || api?.baseUrl || '';

    const urlCheck = validateUrl(endpoint);
    if (!urlCheck.valid) {
      this.logger.warn(`SSRF blocked for SOAP tool ${tool.name}: ${urlCheck.error}`);
      return this.blocked(urlCheck.error!, startTime);
    }

    // XML-escape substituted parameter values. Without this, a value
    // containing `</soap:Body>` (or any `<`, `>`, `&`) breaks out of
    // its containing element and injects arbitrary XML into the
    // outbound SOAP request.
    const soapBody = (tool.soapConfig!.bodyTemplate || '').replace(
      /\{(\w+)\}/g,
      (_, n) => (n in parameters ? escapeXml(String(parameters[n])) : `{${n}}`),
    );
    const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${tool.soapConfig!.namespace}"><soap:Body>${soapBody}</soap:Body></soap:Envelope>`;

    const headers: Record<string, string> = sanitizeHeaders({
      'Content-Type': 'text/xml;charset=UTF-8',
      ...(api?.headers || {}),
      ...(tool.soapConfig!.headers || {}),
    });
    if (tool.soapConfig!.soapAction) headers['SOAPAction'] = tool.soapConfig!.soapAction;

    const axConfig: AxiosRequestConfig = {
      method: 'POST',
      url: endpoint,
      headers,
      data: envelope,
      timeout: tool.configuration?.timeout ?? 30000,
      maxContentLength: MAX_CONTENT_LENGTH,
      maxBodyLength: MAX_BODY_LENGTH,
      signal: options.signal,
    };

    if (api) await this.authService.applyApiAuth(axConfig, api, options);

    try {
      const response = await axios(axConfig);
      let data = response.data;
      if (tool.soapConfig!.responseMapping?.dataPath) {
        data = getByDotPath(data, tool.soapConfig!.responseMapping.dataPath);
      }
      return this.success(data, startTime);
    } catch (error: any) {
      return this.failure(error.message, startTime);
    }
  }

  // ─── SOAP (legacy operation-based) ─────────────────────────────

  async executeSOAPOperation(
    tool: Tool,
    operation: Operation,
    api: Api,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const targetUrl = joinApiUrl(api.baseUrl, operation.endpoint);

    const urlCheck = validateUrl(targetUrl);
    if (!urlCheck.valid) {
      this.logger.warn(`SSRF blocked for SOAP tool ${tool.name}: ${urlCheck.error}`);
      return this.blocked(urlCheck.error!, startTime);
    }

    const soapRequest = parameters as SOAPRequest;
    const safeSoapHeaders = soapRequest.headers ? sanitizeHeaders(soapRequest.headers) : {};
    const targetNamespace =
      (api.metadata as any)?.targetNamespace ||
      (operation.metadata as any)?.targetNamespace ||
      '';

    // If the caller passed an explicit envelope, honor it. Otherwise
    // auto-build from operation.name + the parser-extracted target
    // namespace + the remaining flat `parameters` (each key becomes
    // a child element). Auto-build is what most callers want — most
    // agents shouldn't have to hand-write SOAP XML to use a SOAP
    // skill.
    const envelope = soapRequest.envelope
      ? soapRequest.envelope
      : this.buildSoapEnvelope(
          operation.name,
          targetNamespace,
          this.extractSoapBodyFields(soapRequest as any),
        );

    // SOAP 1.1 SOAPAction header convention: `"{targetNamespace}{op}"`
    // or `"{op}"` if no namespace is on file. Keep the surrounding
    // quotes — bare values are spec-violating and some servers
    // (TempConvert at w3schools) reject them with a SOAPFault.
    const defaultAction = targetNamespace
      ? `"${targetNamespace}${operation.name}"`
      : `"${operation.name}"`;

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: targetUrl,
      timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
      maxContentLength: MAX_CONTENT_LENGTH,
      maxBodyLength: MAX_BODY_LENGTH,
      signal: options.signal,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: soapRequest.action || defaultAction,
        'User-Agent': 'LLM-Tool-Gateway/1.0',
        ...safeSoapHeaders,
      },
      data: envelope,
    };

    await this.authService.applyApiAuth(config, api, options);

    try {
      const response: AxiosResponse = await axios(config);
      return {
        success: true,
        data: response.data,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: this.httpMeta(response),
      };
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        // Stringify the raw upstream body so we don't accidentally
        // echo undefined/object into the error string, and cap
        // length so large HTML error pages don't bloat the logs.
        const bodyText =
          typeof error.response?.data === 'string'
            ? error.response.data.slice(0, 500)
            : error.message;
        return {
          success: false,
          error: `SOAP request failed: ${bodyText}`,
          executionTime: Date.now() - startTime,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: {
            httpStatus: error.response?.status,
            headers: error.response?.headers as Record<string, string>,
            requestId:
              (error.response?.headers?.['x-request-id'] as string) || generateRequestId(),
          },
        };
      }
      throw error;
    }
  }

  // ─── gRPC (structured config, simulated over HTTP/2 JSON) ──────

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

    const callRes = await this.grpcCaller.call({
      protoSource: schemaRow.rawSchema,
      baseUrl: api.baseUrl,
      serviceName,
      methodName,
      request: parameters || {},
      metadata,
      timeoutMs: options.timeout ?? tool.configuration?.timeout ?? 30000,
    });

    const executionTime = Date.now() - startTime;
    if (callRes.success) {
      return {
        success: true,
        data: callRes.data,
        executionTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: { grpcStatus: callRes.code, requestId: generateRequestId() },
      };
    }
    return {
      success: false,
      error: `gRPC request failed: ${callRes.error}`,
      executionTime,
      cached: false,
      rateLimited: false,
      retryCount: 0,
      metadata: { grpcStatus: callRes.code, requestId: generateRequestId() },
    };
  }

  /**
   * Pull the user-supplied flat fields out of a SOAPRequest payload.
   * Drops the meta keys (envelope, action, headers) so they don't
   * end up as XML children of the operation element.
   */
  private extractSoapBodyFields(req: Record<string, any>): Record<string, any> {
    const { envelope: _e, action: _a, headers: _h, ...rest } = req || {};
    return rest;
  }

  /**
   * Build a minimal SOAP 1.1 envelope. Field values are passed
   * through escapeXml so a value containing `</...>` can't break out
   * of its element. Nested objects render as nested elements (one
   * level deep is the realistic case for parser-extracted SOAP ops).
   *
   *   <?xml version="1.0" encoding="utf-8"?>
   *   <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
   *     <soap:Body>
   *       <CelsiusToFahrenheit xmlns="https://www.w3schools.com/xml/">
   *         <Celsius>25</Celsius>
   *       </CelsiusToFahrenheit>
   *     </soap:Body>
   *   </soap:Envelope>
   */
  private buildSoapEnvelope(
    operationName: string,
    targetNamespace: string,
    fields: Record<string, any>,
  ): string {
    const ns = targetNamespace ? ` xmlns="${escapeXml(targetNamespace)}"` : '';
    const renderField = (key: string, value: any): string => {
      if (value === null || value === undefined) return `<${key}/>`;
      if (typeof value === 'object' && !Array.isArray(value)) {
        const inner = Object.entries(value)
          .map(([k, v]) => renderField(k, v))
          .join('');
        return `<${key}>${inner}</${key}>`;
      }
      if (Array.isArray(value)) {
        return value.map((v) => renderField(key, v)).join('');
      }
      return `<${key}>${escapeXml(String(value))}</${key}>`;
    };
    const body = Object.entries(fields)
      .map(([k, v]) => renderField(k, v))
      .join('');
    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
      `<soap:Body>` +
      `<${operationName}${ns}>${body}</${operationName}>` +
      `</soap:Body>` +
      `</soap:Envelope>`
    );
  }

  // ─── shared result shapers ─────────────────────────────────────

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

  private httpMeta(response: AxiosResponse): Record<string, any> {
    return {
      httpStatus: response.status,
      headers: response.headers as Record<string, string>,
      requestId:
        (response.headers['x-request-id'] as string) || generateRequestId(),
    };
  }
}
