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
import { ToolGrpcExecutor } from './tool-grpc.executor';
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
    @InjectRepository(ApiSchema)
    private readonly apiSchemaRepo: Repository<ApiSchema>,
    private readonly grpcExecutor: ToolGrpcExecutor,
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
      maxRedirects: 0,
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
      maxRedirects: 0,
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
      maxRedirects: 0,
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
    // SOAP is single-endpoint by spec — one URL (the .asmx / WSDL
    // service URL) handles every operation, the SOAPAction header
    // and envelope body name pick the operation. The parser emits
    // a placeholder `/soap` for operation.endpoint that mustn't be
    // joined to baseUrl, or we end up POSTing to
    // `.../tempconvert.asmx/soap` which the server 500s as
    // "method name is not valid". Use baseUrl as-is.
    const targetUrl = api.baseUrl;

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

    // SOAPAction header. Spec says it should be a quoted-string,
    // but in practice .NET-style servers (w3schools TempConvert,
    // many WCF endpoints) reject the literal quote characters and
    // expect a bare URI. Send bare; quoted variant is the rare
    // exception that callers can override via `--action`.
    const defaultAction = targetNamespace
      ? `${targetNamespace}${operation.name}`
      : operation.name;

    const config: AxiosRequestConfig = {
      method: 'POST',
      url: targetUrl,
      timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
      maxContentLength: MAX_CONTENT_LENGTH,
      maxBodyLength: MAX_BODY_LENGTH,
      maxRedirects: 0,
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

  // ─── Delegations to ToolGrpcExecutor ──────────────────────────
  executeGrpcConfig(...args: Parameters<ToolGrpcExecutor['executeGrpcConfig']>) {
    return this.grpcExecutor.executeGrpcConfig(...args);
  }
  executeProtobufOperation(...args: Parameters<ToolGrpcExecutor['executeProtobufOperation']>) {
    return this.grpcExecutor.executeProtobufOperation(...args);
  }

  // ─── gRPC (structured config, simulated over HTTP/2 JSON) ──────

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
