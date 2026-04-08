/**
 * HTTP-family tool execution: structured `httpConfig` tools,
 * legacy spec-imported `operation` tools (REST), and the shared
 * pagination loop.
 *
 * Extracted from the old tool-executor.service.ts monolith. This
 * file absorbs all four audit findings that lived in the HTTP
 * paths:
 *
 *   - SSRF in the pagination next-URL flow (fixed via
 *     assertSafeNextPageUrl on every page transition).
 *   - JSON template injection in httpConfig.bodyTemplate (fixed
 *     via applyJsonBodyTemplate, which parses first and substitutes
 *     into the resulting value tree rather than into the raw
 *     source).
 *   - Header injection via CRLF in substituted parameter values
 *     (fixed via substituteHeaderValue, which throws at substitution
 *     time rather than relying on a post-hoc sanitize pass).
 *   - Cursor-as-URL SSRF in cursor pagination (same fix as the
 *     first one — every URL pulled out of the response body runs
 *     back through validateUrl).
 */
import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Tool } from '../../../entities/tool.entity';
import { Api } from '../../../entities/api.entity';
import { Operation } from '../../../entities/operation.entity';
import { validateUrl, sanitizeHeaders } from '../../../common/security/url-validator';
import { ToolAuthService } from '../services/tool-auth.service';
import {
  ToolExecutionOptions,
  ToolExecutionResult,
} from '../tool-execution.types';
import {
  getByDotPath,
  applyJsonBodyTemplate,
  substituteHeaderValue,
  assertSafeNextPageUrl,
  evaluateHttpSuccessCondition,
  encodeFormUrlencoded,
  generateRequestId,
} from '../tool-execution-utils';

/**
 * Truncation cap for error messages surfaced back to callers. Some
 * upstreams return megabyte HTML error pages; inlining those verbatim
 * bloats LLM context windows and our logs.
 */
const MAX_ERR_MESSAGE = 500;

/** Default per-response size cap. 10MB for success, 5MB for the body we send. */
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
const MAX_BODY_LENGTH = 10 * 1024 * 1024;

@Injectable()
export class ToolHttpExecutor {
  private readonly logger = new Logger(ToolHttpExecutor.name);

  constructor(private readonly authService: ToolAuthService) {}

  // ─── Structured httpConfig path ────────────────────────────────

  async executeHttpConfig(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const httpConfig = tool.httpConfig!;
    const startTime = Date.now();
    const api = tool.api ?? tool.operation?.api ?? null;

    try {
      // 1. URL construction — join api.baseUrl and httpConfig.path if the
      // latter is relative, collapsing the slash boundary.
      let url = httpConfig.path;
      if (api?.baseUrl && !url.startsWith('http')) {
        const base = api.baseUrl.replace(/\/+$/, '');
        const path = url.replace(/^\/+/, '');
        url = `${base}/${path}`;
      }

      // 2. Path param substitution. Encode values so `/` and `?` in a
      // parameter can't break out of the path segment.
      const pathParamNames: string[] = [];
      url = url.replace(/\{(\w+)\}/g, (match, name) => {
        pathParamNames.push(name);
        if (name in parameters) {
          return encodeURIComponent(String(parameters[name]));
        }
        return match;
      });

      // 3. SSRF validation on the fully-constructed URL.
      const urlCheck = validateUrl(url);
      if (!urlCheck.valid) {
        this.logger.warn(`SSRF blocked for HTTP tool ${tool.name}: ${urlCheck.error}`);
        return this.blockedResult(url, httpConfig.method, urlCheck.error!, startTime);
      }

      // 4. Query params. Start from httpConfig.queryParams (which can
      // reference {placeholders}) and, for GET/DELETE, fold in any
      // non-path parameters.
      const queryParams: Record<string, any> = {};
      if (httpConfig.queryParams) {
        for (const [key, val] of Object.entries(httpConfig.queryParams)) {
          queryParams[key] = String(val).replace(/\{(\w+)\}/g, (_, n) =>
            n in parameters ? String(parameters[n]) : `{${n}}`,
          );
        }
      }
      if (['GET', 'DELETE'].includes(httpConfig.method)) {
        for (const [key, value] of Object.entries(parameters)) {
          if (!pathParamNames.includes(key) && !(key in queryParams)) {
            queryParams[key] = value;
          }
        }
      }

      // 5. Body. For write methods with a bodyTemplate, parse-then-walk
      // the template so substituted values can't inject new JSON
      // fields. See applyJsonBodyTemplate for the full rationale.
      let body: any = undefined;
      const encoding = httpConfig.bodyEncoding ?? 'json';
      if (['POST', 'PUT', 'PATCH'].includes(httpConfig.method)) {
        if (httpConfig.bodyTemplate) {
          body = applyJsonBodyTemplate(httpConfig.bodyTemplate, parameters);
        } else {
          const bodyParams: Record<string, any> = {};
          for (const [k, v] of Object.entries(parameters)) {
            if (!pathParamNames.includes(k)) bodyParams[k] = v;
          }
          body = bodyParams;
        }
      }

      // 6. Headers. Substituted values go through substituteHeaderValue
      // which refuses CRLF at the per-value level, so a poisoned
      // parameter can't smuggle an extra header into the request.
      const headers: Record<string, string> = {};
      if (api?.headers) Object.assign(headers, api.headers);
      if (httpConfig.headers) {
        for (const [k, v] of Object.entries(httpConfig.headers)) {
          headers[k] = substituteHeaderValue(String(v), parameters, k);
        }
      }
      if (body !== undefined) {
        switch (encoding) {
          case 'json':
            headers['Content-Type'] = 'application/json';
            break;
          case 'form-urlencoded':
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            break;
          case 'raw':
            headers['Content-Type'] = headers['Content-Type'] ?? 'text/plain';
            break;
        }
      }
      const safeHeaders = sanitizeHeaders(headers);

      // 7. Axios config.
      const timeout = tool.configuration?.timeout ?? api?.timeoutMs ?? 30000;
      const axiosConfig: AxiosRequestConfig = {
        method: httpConfig.method as any,
        url,
        timeout,
        maxContentLength: MAX_CONTENT_LENGTH,
        maxBodyLength: MAX_BODY_LENGTH,
        headers: safeHeaders,
        params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
        paramsSerializer: (params: any) => {
          const sp = new URLSearchParams();
          for (const [k, v] of Object.entries(params)) {
            if (Array.isArray(v)) {
              (v as any[]).forEach(item => sp.append(`${k}[]`, String(item)));
            } else if (v !== undefined && v !== null) {
              sp.append(k, String(v));
            }
          }
          return sp.toString();
        },
      };

      // 8. Auth — delegate to the shared auth service so the same
      // credential-resolution path is used by REST/GraphQL/SOAP/gRPC.
      if (api) {
        await this.authService.applyApiAuth(axiosConfig, api, options);
      } else if (tool.authConfig) {
        this.authService.applyInlineToolAuth(axiosConfig, tool.authConfig);
      }

      // 9. Body encoding.
      if (body !== undefined) {
        switch (encoding) {
          case 'json':
            axiosConfig.data = body;
            break;
          case 'form-urlencoded':
            axiosConfig.data = encodeFormUrlencoded(body);
            break;
          case 'multipart': {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const FormData = require('form-data');
            const fd = new FormData();
            for (const [k, v] of Object.entries(body)) {
              fd.append(k, v);
            }
            axiosConfig.data = fd;
            Object.assign(axiosConfig.headers as Record<string, string>, fd.getHeaders());
            break;
          }
          case 'raw':
            axiosConfig.data = typeof body === 'string' ? body : JSON.stringify(body);
            break;
        }
      }

      // 10. Execute, optionally with pagination.
      let result: any;
      if (httpConfig.pagination?.type) {
        result = await this.executeWithPagination(axiosConfig, httpConfig);
      } else {
        const response = await axios(axiosConfig);
        result = this.processHttpResponse(response, httpConfig);
      }

      return {
        success: true,
        data: result,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: { url, method: httpConfig.method, httpStatus: 200 },
      };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      if (axios.isAxiosError(error) || error.isAxiosError) {
        const status = error.response?.status ?? 0;
        const errorData = error.response?.data;
        let errorMessage = error.message;
        if (httpConfig.responseMapping?.errorPath && errorData) {
          const extracted = getByDotPath(errorData, httpConfig.responseMapping.errorPath);
          if (extracted) errorMessage = String(extracted);
        }
        return {
          success: false,
          data: errorData ?? null,
          error: errorMessage,
          executionTime,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: { url: httpConfig.path, method: httpConfig.method, httpStatus: status },
        };
      }
      return {
        success: false,
        data: null,
        error: error.message,
        executionTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };
    }
  }

  // ─── Legacy REST operation path ────────────────────────────────
  // Still used for tools that were auto-generated from an OpenAPI
  // schema import (they have an `operation` relation but no
  // `httpConfig`). We keep the code path because real users have
  // these tools in production, but it shares the same auth and
  // hygiene treatment as the structured path above.

  async executeRestOperation(
    tool: Tool,
    operation: Operation,
    api: Api,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    try {
      const baseUrlCheck = validateUrl(api.baseUrl);
      if (!baseUrlCheck.valid) {
        this.logger.warn(`SSRF blocked for tool ${tool.name}: ${baseUrlCheck.error}`);
        return this.blockedResult(api.baseUrl, operation.method, baseUrlCheck.error!, Date.now());
      }

      let url = `${api.baseUrl}${operation.endpoint}`;
      let pathParams: Record<string, any> = {};
      let queryParams: Record<string, any> = {};
      let headerParams: Record<string, any> = {};
      let bodyData: any = null;

      if (
        parameters.path ||
        parameters.query ||
        parameters.header ||
        parameters.body !== undefined
      ) {
        // Grouped shape
        pathParams = parameters.path || {};
        queryParams = parameters.query || {};
        headerParams = parameters.header || {};
        bodyData = parameters.body;
      } else {
        // Flattened — figure out where each key goes based on method + endpoint shape
        if (
          ['POST', 'PUT', 'PATCH'].includes(operation.method) &&
          operation.parameters?.body
        ) {
          bodyData = parameters;
        } else {
          const pathParamNames = (operation.endpoint.match(/\{([^}]+)\}/g) || []).map(p =>
            p.slice(1, -1),
          );
          pathParamNames.forEach(name => {
            if (parameters[name] !== undefined) {
              pathParams[name] = parameters[name];
            }
          });
          Object.keys(parameters).forEach(key => {
            if (!pathParamNames.includes(key)) {
              queryParams[key] = parameters[key];
            }
          });
        }
      }

      // Path substitution with /g regex so templates that reference the
      // same parameter twice (e.g. `/orgs/{org}/repos/{org}-archive`)
      // substitute all occurrences, and with the literal key escaped so
      // a regex metacharacter in a key can't break the pattern.
      for (const [key, value] of Object.entries(pathParams)) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        url = url.replace(new RegExp(`\\{${escaped}\\}`, 'g'), encodeURIComponent(String(value)));
      }

      const fullUrlCheck = validateUrl(url);
      if (!fullUrlCheck.valid) {
        this.logger.warn(
          `SSRF blocked for constructed URL (tool ${tool.name}): ${fullUrlCheck.error}`,
        );
        return this.blockedResult(url, operation.method, fullUrlCheck.error!, Date.now());
      }

      const safeHeaders = sanitizeHeaders(headerParams as Record<string, string>);

      const config: AxiosRequestConfig = {
        method: operation.method.toLowerCase() as any,
        url,
        timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
        maxContentLength: MAX_CONTENT_LENGTH,
        maxBodyLength: MAX_BODY_LENGTH,
        params: queryParams,
        paramsSerializer: (params: any) => {
          const parts: string[] = [];
          for (const [key, value] of Object.entries(params)) {
            if (Array.isArray(value)) {
              value.forEach(v =>
                parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`),
              );
            } else if (value !== undefined && value !== null) {
              parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
            }
          }
          return parts.join('&');
        },
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'LLM-Tool-Gateway/1.0',
          ...safeHeaders,
        },
      };

      await this.authService.applyApiAuth(config, api, options);

      if (bodyData && ['post', 'put', 'patch'].includes(operation.method.toLowerCase())) {
        config.data = bodyData;
      }

      const response: AxiosResponse = await axios(config);

      return {
        success: true,
        data: response.data,
        executionTime: 0, // filled in by caller
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: {
          httpStatus: response.status,
          headers: response.headers as Record<string, string>,
          requestId: (response.headers['x-request-id'] as string) || generateRequestId(),
        },
      };
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const errorData = error.response?.data;

        let rawMsg: string;
        if (typeof errorData === 'string') {
          rawMsg = errorData;
        } else if (errorData?.message) {
          rawMsg = String(errorData.message);
        } else {
          rawMsg = error.message;
        }
        const truncated =
          rawMsg.length > MAX_ERR_MESSAGE
            ? rawMsg.slice(0, MAX_ERR_MESSAGE) + `… (truncated, ${rawMsg.length} bytes total)`
            : rawMsg;

        return {
          success: false,
          data: errorData,
          error: `HTTP ${status}: ${truncated}`,
          executionTime: 0,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: {
            httpStatus: status,
            headers: error.response?.headers as Record<string, string>,
            requestId:
              (error.response?.headers?.['x-request-id'] as string) || generateRequestId(),
          },
        };
      }

      throw error;
    }
  }

  // ─── Pagination loop ───────────────────────────────────────────

  private async executeWithPagination(
    baseConfig: AxiosRequestConfig,
    httpConfig: any,
  ): Promise<any[]> {
    const pagination = httpConfig.pagination;
    const maxPages = pagination.maxPages ?? 5;
    const allResults: any[] = [];
    let pageCount = 0;
    let nextCursor: string | null = null;
    let nextUrl: string | null = null;
    let offset = 0;

    while (pageCount < maxPages) {
      const pageConfig: AxiosRequestConfig = {
        ...baseConfig,
        params: { ...(baseConfig.params as Record<string, any>) },
        headers: { ...(baseConfig.headers as Record<string, string>) },
      };

      switch (pagination.type) {
        case 'cursor':
          if (nextUrl) {
            // SSRF fix: every URL pulled from an upstream response —
            // whether it arrived via `cursorPath`, a Link header, or
            // any future mechanism — runs back through validateUrl
            // before we fetch it. A compliant API will hand us a
            // real public URL; a malicious one can't redirect us
            // into 169.254.169.254, localhost, etc.
            pageConfig.url = assertSafeNextPageUrl(nextUrl, baseConfig.url);
            pageConfig.params = undefined;
          } else if (nextCursor && pagination.cursorParam) {
            pageConfig.params = pageConfig.params || {};
            (pageConfig.params as Record<string, any>)[pagination.cursorParam] = nextCursor;
          }
          break;
        case 'offset':
          pageConfig.params = pageConfig.params || {};
          if (pagination.offsetParam)
            (pageConfig.params as Record<string, any>)[pagination.offsetParam] = offset;
          if (pagination.limitParam && pagination.defaultLimit)
            (pageConfig.params as Record<string, any>)[pagination.limitParam] =
              pagination.defaultLimit;
          break;
        case 'link-header':
          if (nextUrl) {
            pageConfig.url = assertSafeNextPageUrl(nextUrl, baseConfig.url);
            pageConfig.params = undefined;
          }
          break;
      }

      const response = await axios(pageConfig);
      const processed = this.processHttpResponse(response, httpConfig);

      const results = pagination.resultsPath
        ? getByDotPath(response.data, pagination.resultsPath)
        : processed;

      if (Array.isArray(results)) allResults.push(...results);
      else if (results !== undefined && results !== null) allResults.push(results);

      pageCount++;
      let hasNext = false;

      switch (pagination.type) {
        case 'cursor':
          if (pagination.cursorPath) {
            const cursor = getByDotPath(response.data, pagination.cursorPath);
            if (cursor) {
              if (
                typeof cursor === 'string' &&
                (cursor.startsWith('http') || cursor.startsWith('/'))
              ) {
                nextUrl = cursor;
                nextCursor = null;
              } else {
                nextCursor = String(cursor);
                nextUrl = null;
              }
              hasNext = true;
            }
          }
          break;
        case 'offset': {
          const limit = pagination.defaultLimit ?? 20;
          if (Array.isArray(results) && results.length >= limit) {
            offset += limit;
            hasNext = true;
          }
          break;
        }
        case 'link-header': {
          const linkHeader = response.headers?.link || response.headers?.Link;
          if (linkHeader) {
            const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            if (m) {
              nextUrl = m[1];
              hasNext = true;
            }
          }
          break;
        }
      }

      if (!hasNext) break;
    }

    return allResults;
  }

  // ─── Response shaping + common helpers ─────────────────────────

  processHttpResponse(response: any, httpConfig: any): any {
    const mapping = httpConfig.responseMapping;
    let data = response.data;

    if (mapping?.successCondition) {
      const success = evaluateHttpSuccessCondition(
        mapping.successCondition,
        response.status,
        data,
      );
      if (!success) {
        const errorMsg = mapping.errorPath
          ? getByDotPath(data, mapping.errorPath)
          : 'Request failed';
        const err: any = new Error(String(errorMsg));
        err.response = response;
        err.isAxiosError = true;
        throw err;
      }
    }

    if (mapping?.dataPath) {
      data = getByDotPath(data, mapping.dataPath);
    }

    return data;
  }

  private blockedResult(
    url: string,
    method: string,
    reason: string,
    startTime: number,
  ): ToolExecutionResult {
    return {
      success: false,
      data: null,
      error: `Blocked: ${reason}`,
      executionTime: Date.now() - startTime,
      cached: false,
      rateLimited: false,
      retryCount: 0,
      metadata: { url, method },
    };
  }
}
