/**
 * GraphQL / SOAP / gRPC tool execution.
 *
 * Each of these protocols has two entry points: a structured
 * config shape (`graphqlConfig`, `soapConfig`, `grpcConfig`) for
 * tools made on the Create tool page, and an operation-based path
 * for tools generated from an imported API schema. Both paths share
 * the same auth / egress / size hygiene: the shared auth service,
 * and decideToolEgress (the SSRF gate plus the organization's egress
 * allowlist) for every outbound URL.
 *
 * The SOAP body template runs user-supplied parameter values
 * through escapeXml so a value containing `</soap:Body>` can't
 * break out of its containing element and inject additional XML.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Tool } from '../../../entities/tool.entity';
import { Api } from '../../../entities/api.entity';
import { Operation } from '../../../entities/operation.entity';
import { Organization } from '../../../entities/organization.entity';
import { sanitizeHeaders } from '../../../common/security/url-validator';
import { decideToolEgress } from './tool-egress';
import {
  decideToolRequest,
  effectiveMaxResponseBytes,
} from '../../../common/security/gateway-tool-policy';
import { ToolAuthService } from '../services/tool-auth.service';
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
  const base = (baseUrl || '').replace(/(?<!\/)\/+$/, '');
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (base.endsWith(path)) return base;
  return `${base}${path}`;
}

@Injectable()
export class ToolProtocolExecutor {
  private readonly logger = new Logger(ToolProtocolExecutor.name);

  constructor(
    private readonly authService: ToolAuthService,
    private readonly grpcExecutor: ToolGrpcExecutor,
    // The organization's egress allowlist; see decideToolEgress.
    @Optional()
    @InjectRepository(Organization)
    private readonly organizations?: Repository<Organization>,
  ) {}

  // ─── GraphQL (structured config) ───────────────────────────────

  /**
   * A GraphQL tool made on the Create tool page: an endpoint, one query or
   * mutation, and optionally a variables map. A variables value that is
   * exactly `{param}` takes the parameter as it came (a number stays a
   * number); `{param}` inside a longer string is substituted as text.
   * With no variables map, the tool's parameters are the variables.
   *
   * The result matches an imported GraphQL tool's: the `data` object on
   * success, a failure carrying the messages when the response has
   * `errors`. `responseMapping.dataPath` is read from the whole response
   * (`data.users`), as its name in the config says.
   */
  async executeGraphQLConfig(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const graphqlConfig = tool.graphqlConfig!;
    const api = tool.api ?? tool.operation?.api ?? null;
    const endpoint = graphqlConfig.endpoint || api?.baseUrl || '';
    if (!graphqlConfig.query?.trim()) {
      return this.failure(`GraphQL tool ${tool.name} has no query.`, startTime);
    }

    const egress = await decideToolEgress(endpoint, api?.organizationId ?? tool.organizationId, this.organizations);
    if (egress.error) {
      this.logger.warn(`SSRF blocked for GraphQL tool ${tool.name}: ${egress.error}`);
      return this.blocked(egress.error, startTime);
    }

    // Gateway-tool security policy. GraphQL and SOAP are POST-only over
    // HTTP, so allowed-methods is judged against POST; domains and
    // require-HTTPS apply exactly as they do to a plain HTTP tool.
    const gqlPolicy = decideToolRequest(options.securityPolicy, endpoint, 'POST');
    if (!gqlPolicy.allowed) {
      this.logger.warn(`Security policy blocked GraphQL tool ${tool.name}: ${gqlPolicy.reason}`);
      return this.blocked(gqlPolicy.reason!, startTime);
    }

    const variables: Record<string, any> = {};
    if (graphqlConfig.variables && Object.keys(graphqlConfig.variables).length > 0) {
      for (const [k, v] of Object.entries(graphqlConfig.variables)) {
        if (typeof v !== 'string') {
          variables[k] = v;
          continue;
        }
        const whole = /^\{(\w+)\}$/.exec(v);
        if (whole) {
          if (whole[1] in parameters) variables[k] = parameters[whole[1]];
          continue;
        }
        variables[k] = v.replace(/\{(\w+)\}/g, (_, n) =>
          n in parameters ? String(parameters[n]) : `{${n}}`,
        );
      }
    } else {
      Object.assign(variables, parameters);
    }

    const headers: Record<string, string> = sanitizeHeaders({
      'Content-Type': 'application/json',
      ...(api?.headers || {}),
      ...(graphqlConfig.headers || {}),
    });

    const axConfig: AxiosRequestConfig = {
      method: 'POST',
      url: endpoint,
      headers,
      data: { query: graphqlConfig.query, variables },
      timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
      maxContentLength: effectiveMaxResponseBytes(options.securityPolicy, MAX_CONTENT_LENGTH),
      maxBodyLength: MAX_BODY_LENGTH,
      maxRedirects: 0,
      httpAgent: egress.httpAgent,
      httpsAgent: egress.httpsAgent,
      signal: options.signal,
    };

    if (api) await this.authService.applyApiAuth(axConfig, api, options);
    else if (tool.authConfig) await this.authService.applyToolAuth(axConfig, tool, options);

    try {
      const response = await axios(axConfig);
      const body = response.data;
      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        return {
          ...this.failure(`GraphQL errors: ${body.errors.map((e: any) => e?.message).join(', ')}`, startTime),
          data: body,
          metadata: this.httpMeta(response),
        };
      }
      const data = graphqlConfig.responseMapping?.dataPath
        ? getByDotPath(body, graphqlConfig.responseMapping.dataPath)
        : body?.data ?? body;
      return { ...this.success(data, startTime), metadata: this.httpMeta(response) };
    } catch (error: any) {
      const message = error?.response?.data?.errors?.[0]?.message || error?.response?.data?.message || error.message;
      return this.failure(`GraphQL request failed: ${message}`, startTime);
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

    const urlCheck = await decideToolEgress(targetUrl, api.organizationId ?? tool.organizationId, this.organizations);
    if (urlCheck.error) {
      this.logger.warn(`SSRF blocked for GraphQL tool ${tool.name}: ${urlCheck.error}`);
      return this.blocked(urlCheck.error, startTime);
    }

    const gqlOpPolicy = decideToolRequest(options.securityPolicy, targetUrl, 'POST');
    if (!gqlOpPolicy.allowed) {
      this.logger.warn(`Security policy blocked GraphQL tool ${tool.name}: ${gqlOpPolicy.reason}`);
      return this.blocked(gqlOpPolicy.reason!, startTime);
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
      maxContentLength: effectiveMaxResponseBytes(options.securityPolicy, MAX_CONTENT_LENGTH),
      maxBodyLength: MAX_BODY_LENGTH,
      maxRedirects: 0,
      httpAgent: urlCheck.httpAgent,
      httpsAgent: urlCheck.httpsAgent,
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

  /**
   * A SOAP tool made on the Create tool page. It stores the service URL
   * (`endpoint`), the operation and its target namespace. With no
   * `bodyTemplate` the envelope is built the way an imported SOAP tool's
   * is: one element named after the operation, in the target namespace,
   * one child per parameter. A `bodyTemplate` replaces that element with
   * the author's own XML, `{param}` placeholders escaped.
   */
  async executeSOAPConfig(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const soapConfig = tool.soapConfig!;
    const api = tool.api ?? tool.operation?.api ?? null;
    const endpoint = soapConfig.endpoint || api?.baseUrl || '';
    if (!soapConfig.operation && !soapConfig.bodyTemplate) {
      return this.failure(`SOAP tool ${tool.name} names no operation.`, startTime);
    }

    const egress = await decideToolEgress(endpoint, api?.organizationId ?? tool.organizationId, this.organizations);
    if (egress.error) {
      this.logger.warn(`SSRF blocked for SOAP tool ${tool.name}: ${egress.error}`);
      return this.blocked(egress.error, startTime);
    }

    const soapPolicy = decideToolRequest(options.securityPolicy, endpoint, 'POST');
    if (!soapPolicy.allowed) {
      this.logger.warn(`Security policy blocked SOAP tool ${tool.name}: ${soapPolicy.reason}`);
      return this.blocked(soapPolicy.reason!, startTime);
    }

    const namespace = soapConfig.namespace || '';
    let envelope: string;
    if (soapConfig.bodyTemplate) {
      // XML-escape substituted parameter values. Without this, a value
      // containing `</soap:Body>` (or any `<`, `>`, `&`) breaks out of
      // its containing element and injects arbitrary XML into the
      // outbound SOAP request.
      const soapBody = soapConfig.bodyTemplate.replace(
        /\{(\w+)\}/g,
        (_, n) => (n in parameters ? escapeXml(String(parameters[n])) : `{${n}}`),
      );
      envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${escapeXml(namespace)}"><soap:Body>${soapBody}</soap:Body></soap:Envelope>`;
    } else {
      envelope = this.buildSoapEnvelope(soapConfig.operation, namespace, parameters || {});
    }

    const headers: Record<string, string> = sanitizeHeaders({
      'Content-Type': 'text/xml; charset=utf-8',
      ...(api?.headers || {}),
      ...(soapConfig.headers || {}),
    });
    // Same default as an imported SOAP tool: the namespace followed by the
    // operation name, sent bare (most .NET/WCF servers reject the quotes).
    headers['SOAPAction'] =
      soapConfig.soapAction || (namespace ? `${namespace}${soapConfig.operation}` : soapConfig.operation);

    const axConfig: AxiosRequestConfig = {
      method: 'POST',
      url: endpoint,
      headers,
      data: envelope,
      timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
      maxContentLength: effectiveMaxResponseBytes(options.securityPolicy, MAX_CONTENT_LENGTH),
      maxBodyLength: MAX_BODY_LENGTH,
      maxRedirects: 0,
      httpAgent: egress.httpAgent,
      httpsAgent: egress.httpsAgent,
      signal: options.signal,
    };

    if (api) await this.authService.applyApiAuth(axConfig, api, options);
    else if (tool.authConfig) await this.authService.applyToolAuth(axConfig, tool, options);

    try {
      const response = await axios(axConfig);
      let data = response.data;
      if (soapConfig.responseMapping?.dataPath) {
        data = getByDotPath(data, soapConfig.responseMapping.dataPath);
      }
      return { ...this.success(data, startTime), metadata: this.httpMeta(response) };
    } catch (error: any) {
      // A SOAP fault arrives as a 500 with the fault in the body; the body
      // says what went wrong, the status line does not.
      const body = error?.response?.data;
      const detail = typeof body === 'string' && body ? body.slice(0, 500) : error.message;
      return this.failure(`SOAP request failed: ${detail}`, startTime);
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

    const urlCheck = await decideToolEgress(targetUrl, api.organizationId ?? tool.organizationId, this.organizations);
    if (urlCheck.error) {
      this.logger.warn(`SSRF blocked for SOAP tool ${tool.name}: ${urlCheck.error}`);
      return this.blocked(urlCheck.error, startTime);
    }

    const soapOpPolicy = decideToolRequest(options.securityPolicy, targetUrl, 'POST');
    if (!soapOpPolicy.allowed) {
      this.logger.warn(`Security policy blocked SOAP tool ${tool.name}: ${soapOpPolicy.reason}`);
      return this.blocked(soapOpPolicy.reason!, startTime);
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
      maxContentLength: effectiveMaxResponseBytes(options.securityPolicy, MAX_CONTENT_LENGTH),
      maxBodyLength: MAX_BODY_LENGTH,
      maxRedirects: 0,
      httpAgent: urlCheck.httpAgent,
      httpsAgent: urlCheck.httpsAgent,
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

  // ─── SOAP envelope helpers ────────────────────────────────────

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
