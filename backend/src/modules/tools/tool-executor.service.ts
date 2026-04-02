import { Injectable, Logger, BadRequestException, Inject } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as Redis from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';

import { Tool, ToolStatus } from '../../entities/tool.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { Operation } from '../../entities/operation.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { User } from '../../entities/user.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { CustomCodeExecutorService } from './custom-code-executor.service';
import { validateUrl, sanitizeHeaders, validateResponseSize } from '../../common/security/url-validator';
import { sanitizeToolParameters } from '../../common/security/input-sanitizer';
import { verifyToolIntegrity } from '../../common/security/tool-integrity';
import { AuditLogService } from '../audit-log/audit-log.service';

export interface ToolExecutionOptions {
  userId: string;
  organizationId: string;
  timeout?: number;
  retries?: number;
  skipCache?: boolean;
  skipRateLimit?: boolean;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
  executionTime: number;
  cached: boolean;
  rateLimited: boolean;
  retryCount: number;
  metadata?: Record<string, any>;
}

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, any>;
  operationName?: string;
}

export interface SOAPRequest {
  action: string;
  envelope: string;
  headers?: Record<string, string>;
}

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Api)
    private apiRepository: Repository<Api>,
    @InjectRepository(Operation)
    private operationRepository: Repository<Operation>,
    @InjectRepository(ToolExecution)
    private toolExecutionRepository: Repository<ToolExecution>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Credential)
    private credentialRepository: Repository<Credential>,
    @InjectRedis() private readonly redis: Redis.Redis,
    private customCodeExecutor: CustomCodeExecutorService,
    private moduleRef: ModuleRef,
    private readonly auditLogService: AuditLogService,
  ) {}

  async executeTool(
    toolId: string,
    parameters: Record<string, any>,
    options: ToolExecutionOptions
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    let retryCount = 0;
    let cached = false;
    let rateLimited = false;

    try {
      // Get tool with relations
      const tool = await this.toolRepository.findOne({
        where: { id: toolId },
        relations: ['operation', 'operation.api', 'api', 'inputSchema', 'outputSchema'],
      });

      if (!tool) {
        throw new Error('Tool not found');
      }

      if (tool.status !== ToolStatus.ACTIVE) {
        throw new Error(`Tool is ${tool.status}, cannot execute`);
      }

      // Validate user has access (skip for MCP sessions without user auth)
      if (options.userId) {
        const user = await this.userRepository.findOne({
          where: { id: options.userId },
          relations: ['organizationMemberships'],
        });

        if (!user?.hasPermissionInOrganization(options.organizationId, 'use_tools')) {
          throw new Error('User does not have permission to use tools in this organization');
        }
      }
      // Note: When userId is null (MCP unauthenticated sessions), we allow tool execution
      // The gateway-level authentication should handle security

      // Validate parameters
      const validation = await this.validateParameters(tool, parameters);
      if (!validation.isValid) {
        throw new BadRequestException(`Invalid parameters: ${validation.errors.join(', ')}`);
      }

      // Security: Sanitize parameters against injection attacks
      const sanitization = sanitizeToolParameters(parameters);
      if (!sanitization.safe) {
        this.logger.warn(`Blocked dangerous parameters for tool ${tool.name}: ${sanitization.warnings.join('; ')}`);
        throw new BadRequestException(`Parameter security violation: ${sanitization.warnings.filter(w => w.startsWith('[block]')).join('; ')}`);
      }
      if (sanitization.warnings.length > 0) {
        this.logger.warn(`Parameter warnings for tool ${tool.name}: ${sanitization.warnings.join('; ')}`);
      }

      // Security: Verify tool integrity if hash is stored
      if (tool.definitionHash) {
        const integrity = verifyToolIntegrity(tool, tool.definitionHash);
        if (!integrity.valid) {
          this.logger.error(`Tool integrity check FAILED for ${tool.name} (${tool.id}). Stored hash does not match current definition.`);
          throw new BadRequestException('Tool integrity verification failed. The tool definition may have been tampered with.');
        }
      }

      // Check rate limits
      if (!options.skipRateLimit) {
        const rateLimitResult = await this.checkRateLimit(tool, options);
        if (rateLimitResult.limited) {
          rateLimited = true;
          return {
            success: false,
            error: `Rate limit exceeded: ${rateLimitResult.message}`,
            executionTime: Date.now() - startTime,
            cached,
            rateLimited,
            retryCount,
          };
        }
      }

      // Check cache
      if (!options.skipCache && tool.configuration?.cache?.enabled) {
        const cachedResult = await this.getCachedResult(tool, parameters);
        if (cachedResult) {
          cached = true;
          await this.recordExecution(tool, parameters, cachedResult, options, {
            cached: true,
            executionTime: Date.now() - startTime,
            retryCount: 0,
          });
          
          return {
            ...cachedResult,
            cached: true,
            rateLimited: false,
            retryCount: 0,
            executionTime: Date.now() - startTime,
          };
        }
      }

      // Check if this is an LLM tool
      if (tool.llmConfig?.providerId && tool.llmConfig?.promptTemplate) {
        try {
          // Interpolate prompt template with parameters
          let prompt = tool.llmConfig.promptTemplate;
          for (const [key, value] of Object.entries(parameters)) {
            prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
          }

          const messages: any[] = [];
          if (tool.llmConfig.systemPrompt) {
            let sysPrompt = tool.llmConfig.systemPrompt;
            if (tool.llmConfig.outputMode === 'json' && tool.llmConfig.outputSchema) {
              sysPrompt += `\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(tool.llmConfig.outputSchema, null, 2)}`;
            }
            messages.push({ role: 'system', content: sysPrompt });
          } else if (tool.llmConfig.outputMode === 'json' && tool.llmConfig.outputSchema) {
            messages.push({ role: 'system', content: `Respond with valid JSON matching this schema:\n${JSON.stringify(tool.llmConfig.outputSchema, null, 2)}` });
          }
          messages.push({ role: 'user', content: prompt });

          // Dynamic import to avoid circular dependency
          const { LlmProvidersService } = await import('../llm-providers/llm-providers.service');
          const llmService = this.moduleRef?.get(LlmProvidersService, { strict: false });

          if (!llmService) {
            throw new Error('LLM providers service not available');
          }

          const chatResponse = await llmService.chat(
            tool.llmConfig.providerId,
            {
              messages,
              model: tool.llmConfig.model,
              maxTokens: tool.llmConfig.maxTokens,
              temperature: tool.llmConfig.temperature,
            },
            options.organizationId,
            options.userId,
          );

          let responseData: any = chatResponse.message?.content || '';

          // Parse JSON if output mode is json
          if (tool.llmConfig.outputMode === 'json' && typeof responseData === 'string') {
            try {
              // Try to extract JSON from response
              const jsonMatch = responseData.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
              if (jsonMatch) {
                responseData = JSON.parse(jsonMatch[0]);
              }
            } catch {
              // If parse fails, return raw text with a note
              responseData = { raw: responseData, parseError: 'Could not parse as JSON' };
            }
          }

          const executionResult = {
            success: true,
            data: responseData,
            executionTime: Date.now() - startTime,
            cached,
            rateLimited,
            retryCount: 0,
            metadata: {
              outputMode: tool.llmConfig.outputMode,
              provider: tool.llmConfig.providerId,
              model: tool.llmConfig.model,
              usage: chatResponse.usage,
            },
          };

          await this.recordExecution(tool, parameters, executionResult, options, {
            executionTime: Date.now() - startTime,
            cached,
            retryCount: 0,
          });

          return executionResult;
        } catch (error) {
          const executionResult = {
            success: false,
            error: error.message || 'LLM execution failed',
            executionTime: Date.now() - startTime,
            cached,
            rateLimited,
            retryCount: 0,
          };

          await this.recordExecution(tool, parameters, executionResult, options, {
            executionTime: Date.now() - startTime,
            cached,
            retryCount: 0,
          });

          return executionResult;
        }
      }

      // Check if this is a custom code tool
      if (tool.code) {
        // Execute custom code
        try {
          const codeResult = await this.customCodeExecutor.executeCode(
            tool.code,
            parameters,
            {
              timeout: options.timeout || tool.configuration?.timeout,
            }
          );

          const executionResult = {
            success: codeResult.success,
            data: codeResult.data,
            error: codeResult.error,
            executionTime: codeResult.executionTime,
            cached,
            rateLimited,
            retryCount: 0,
          };

          await this.recordExecution(tool, parameters, executionResult, options, {
            executionTime: codeResult.executionTime,
            cached,
            retryCount: 0,
          });

          return executionResult;
        } catch (error) {
          const executionResult = {
            success: false,
            error: error.message,
            executionTime: Date.now() - startTime,
            cached,
            rateLimited,
            retryCount: 0,
          };

          await this.recordExecution(tool, parameters, executionResult, options, {
            executionTime: Date.now() - startTime,
            cached,
            retryCount: 0,
          });

          return executionResult;
        }
      }

      // HTTP config-based execution (structured HTTP tools)
      if (tool.httpConfig) {
        try {
          const httpResult = await this.executeHttpTool(tool, parameters, {
            organizationId: options.organizationId,
            userId: options.userId,
          });

          const executionResult: ToolExecutionResult = {
            success: httpResult.success,
            data: httpResult.data,
            error: httpResult.error,
            executionTime: httpResult.executionTime,
            cached,
            rateLimited,
            retryCount: 0,
            metadata: httpResult.metadata,
          };

          await this.recordExecution(tool, parameters, executionResult, options, {
            executionTime: httpResult.executionTime,
            cached,
            retryCount: 0,
          });

          // Cache result if enabled
          if (tool.configuration?.cache?.enabled && executionResult.success) {
            await this.cacheResult(tool, parameters, executionResult);
          }

          return executionResult;
        } catch (error) {
          const executionResult: ToolExecutionResult = {
            success: false,
            error: error.message || 'HTTP tool execution failed',
            executionTime: Date.now() - startTime,
            cached,
            rateLimited,
            retryCount: 0,
          };

          await this.recordExecution(tool, parameters, executionResult, options, {
            executionTime: Date.now() - startTime,
            cached,
            retryCount: 0,
          });

          return executionResult;
        }
      }

      // GraphQL config-based execution
      if (tool.graphqlConfig) {
        try {
          const api = tool.api ?? tool.operation?.api ?? null;
          const endpoint = tool.graphqlConfig.endpoint || (api?.baseUrl ?? '');
          const variables: Record<string, any> = {};
          if (tool.graphqlConfig.variables) {
            for (const [k, v] of Object.entries(tool.graphqlConfig.variables)) {
              variables[k] = typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (_, n) => n in parameters ? parameters[n] : `{${n}}`) : v;
            }
          } else {
            Object.assign(variables, parameters);
          }
          const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(api?.headers || {}), ...(tool.graphqlConfig.headers || {}) };
          const axConfig: any = { method: 'POST', url: endpoint, headers, data: { query: tool.graphqlConfig.query, variables }, timeout: tool.configuration?.timeout ?? 30000 };
          if (api) await this.addAuthentication(axConfig, api, options);
          const response = await axios(axConfig);
          let data = response.data;
          if (tool.graphqlConfig.responseMapping?.dataPath) data = this.getByDotPath(data, tool.graphqlConfig.responseMapping.dataPath);
          const result: ToolExecutionResult = { success: true, data, executionTime: Date.now() - startTime, cached, rateLimited, retryCount: 0 };
          await this.recordExecution(tool, parameters, result, options, { executionTime: result.executionTime, cached, retryCount: 0 });
          return result;
        } catch (error) {
          const result: ToolExecutionResult = { success: false, error: error.message, executionTime: Date.now() - startTime, cached, rateLimited, retryCount: 0 };
          await this.recordExecution(tool, parameters, result, options, { executionTime: result.executionTime, cached, retryCount: 0 });
          return result;
        }
      }

      // SOAP config-based execution
      if (tool.soapConfig) {
        try {
          const api = tool.api ?? tool.operation?.api ?? null;
          const endpoint = tool.soapConfig.endpoint || (api?.baseUrl ?? '');
          let soapBody = tool.soapConfig.bodyTemplate || '';
          soapBody = soapBody.replace(/\{(\w+)\}/g, (_, n) => n in parameters ? String(parameters[n]) : `{${n}}`);
          const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${tool.soapConfig.namespace}"><soap:Body>${soapBody}</soap:Body></soap:Envelope>`;
          const headers: Record<string, string> = { 'Content-Type': 'text/xml;charset=UTF-8', ...(api?.headers || {}), ...(tool.soapConfig.headers || {}) };
          if (tool.soapConfig.soapAction) headers['SOAPAction'] = tool.soapConfig.soapAction;
          const axConfig: any = { method: 'POST', url: endpoint, headers, data: envelope, timeout: tool.configuration?.timeout ?? 30000 };
          if (api) await this.addAuthentication(axConfig, api, options);
          const response = await axios(axConfig);
          let data = response.data;
          if (tool.soapConfig.responseMapping?.dataPath) data = this.getByDotPath(data, tool.soapConfig.responseMapping.dataPath);
          const result: ToolExecutionResult = { success: true, data, executionTime: Date.now() - startTime, cached, rateLimited, retryCount: 0 };
          await this.recordExecution(tool, parameters, result, options, { executionTime: result.executionTime, cached, retryCount: 0 });
          return result;
        } catch (error) {
          const result: ToolExecutionResult = { success: false, error: error.message, executionTime: Date.now() - startTime, cached, rateLimited, retryCount: 0 };
          await this.recordExecution(tool, parameters, result, options, { executionTime: result.executionTime, cached, retryCount: 0 });
          return result;
        }
      }

      // gRPC config-based execution
      if (tool.grpcConfig) {
        try {
          // gRPC requires the grpc library — for now, return a descriptive error if not available
          // Full gRPC execution needs @grpc/grpc-js + @grpc/proto-loader
          const api = tool.api ?? tool.operation?.api ?? null;
          const endpoint = tool.grpcConfig.endpoint || (api?.baseUrl ?? '');
          // Map parameters to request fields
          const requestData: Record<string, any> = {};
          if (tool.grpcConfig.requestMapping) {
            for (const [k, v] of Object.entries(tool.grpcConfig.requestMapping)) {
              requestData[k] = typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (_, n) => n in parameters ? parameters[n] : `{${n}}`) : v;
            }
          } else {
            Object.assign(requestData, parameters);
          }
          // For now, make an HTTP/2 JSON call (gRPC-Web compatible)
          const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(api?.headers || {}) };
          const url = `${endpoint}/${tool.grpcConfig.serviceName}/${tool.grpcConfig.methodName}`;
          const axConfig: any = { method: 'POST', url, headers, data: requestData, timeout: tool.configuration?.timeout ?? 30000 };
          if (api) await this.addAuthentication(axConfig, api, options);
          const response = await axios(axConfig);
          let data = response.data;
          if (tool.grpcConfig.responseMapping?.dataPath) data = this.getByDotPath(data, tool.grpcConfig.responseMapping.dataPath);
          const result: ToolExecutionResult = { success: true, data, executionTime: Date.now() - startTime, cached, rateLimited, retryCount: 0 };
          await this.recordExecution(tool, parameters, result, options, { executionTime: result.executionTime, cached, retryCount: 0 });
          return result;
        } catch (error) {
          const result: ToolExecutionResult = { success: false, error: error.message, executionTime: Date.now() - startTime, cached, rateLimited, retryCount: 0 };
          await this.recordExecution(tool, parameters, result, options, { executionTime: result.executionTime, cached, retryCount: 0 });
          return result;
        }
      }

      // Execute API-based tool with retries (legacy path for spec-imported tools)
      const maxRetries = options.retries ?? tool.configuration?.retries ?? 3;
      let lastError: Error;

      while (retryCount <= maxRetries) {
        try {
          const result = await this.executeOperation(tool, parameters, options);
          
          // Cache result if enabled
          if (tool.configuration?.cache?.enabled && result.success) {
            await this.cacheResult(tool, parameters, result);
          }

          // Record execution
          await this.recordExecution(tool, parameters, result, options, {
            cached: false,
            executionTime: Date.now() - startTime,
            retryCount,
          });

          return {
            ...result,
            executionTime: Date.now() - startTime,
            cached,
            rateLimited,
            retryCount,
          };

        } catch (error) {
          lastError = error;
          retryCount++;
          
          if (retryCount <= maxRetries) {
            const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff
            await this.sleep(delay);
            this.logger.warn(`Tool execution failed, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries}): ${error.message}`);
          }
        }
      }

      // All retries failed
      const failureResult = {
        success: false,
        error: `Execution failed after ${retryCount} attempts: ${lastError.message}`,
        executionTime: Date.now() - startTime,
        cached,
        rateLimited,
        retryCount,
      };

      await this.recordExecution(tool, parameters, failureResult, options, {
        cached: false,
        executionTime: Date.now() - startTime,
        retryCount,
      });

      return failureResult;

    } catch (error) {
      this.logger.error(`Tool execution error: ${error.message}`, error.stack);
      
      const errorResult = {
        success: false,
        error: error.message,
        executionTime: Date.now() - startTime,
        cached,
        rateLimited,
        retryCount,
      };

      try {
        const tool = await this.toolRepository.findOne({ where: { id: toolId } });
        if (tool) {
          await this.recordExecution(tool, parameters, errorResult, options, {
            cached: false,
            executionTime: Date.now() - startTime,
            retryCount,
          });
        }
      } catch (recordError) {
        this.logger.error(`Failed to record failed execution: ${recordError.message}`);
      }

      return errorResult;
    }
  }

  private async executeOperation(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions
  ): Promise<ToolExecutionResult> {
    const operation = tool.operation;
    const api = operation.api;

    switch (api.type) {
      case ApiType.OPENAPI:
        return this.executeRestOperation(tool, operation, api, parameters, options);
      case ApiType.GRAPHQL:
        return this.executeGraphQLOperation(tool, operation, api, parameters, options);
      case ApiType.SOAP:
        return this.executeSOAPOperation(tool, operation, api, parameters, options);
      case ApiType.GRPC:
        return this.executeProtobufOperation(tool, operation, api, parameters, options);
      default:
        throw new Error(`Unsupported API type: ${api.type}`);
    }
  }

  private async executeRestOperation(
    tool: Tool,
    operation: Operation,
    api: Api,
    parameters: Record<string, any>,
    options: ToolExecutionOptions
  ): Promise<ToolExecutionResult> {
    try {
      // Security: Validate base URL against SSRF
      const baseUrlCheck = validateUrl(api.baseUrl);
      if (!baseUrlCheck.valid) {
        this.logger.warn(`SSRF blocked for tool ${tool.name}: ${baseUrlCheck.error}`);
        return {
          success: false,
          error: `Blocked: ${baseUrlCheck.error}`,
          executionTime: 0,
          cached: false,
          rateLimited: false,
          retryCount: 0,
        };
      }

      // Build URL
      let url = `${api.baseUrl}${operation.endpoint}`;

      // Handle both flattened and grouped parameters
      let pathParams = {};
      let queryParams = {};
      let headerParams = {};
      let bodyData = null;

      if (parameters.path || parameters.query || parameters.header || parameters.body !== undefined) {
        // Parameters are already grouped by type
        pathParams = parameters.path || {};
        queryParams = parameters.query || {};
        headerParams = parameters.header || {};
        bodyData = parameters.body;
      } else {
        // Parameters are flattened - need to determine which go where based on operation schema
        // For POST/PUT/PATCH with body schema, all params go to body
        if (['POST', 'PUT', 'PATCH'].includes(operation.method) && operation.parameters?.body) {
          bodyData = parameters;
        }
        // For GET, params go to query or path based on endpoint
        else {
          // Extract path params from URL template
          const pathParamNames = (operation.endpoint.match(/\{([^}]+)\}/g) || []).map(p => p.slice(1, -1));
          pathParamNames.forEach(name => {
            if (parameters[name] !== undefined) {
              pathParams[name] = parameters[name];
            }
          });
          // Rest go to query
          Object.keys(parameters).forEach(key => {
            if (!pathParamNames.includes(key)) {
              queryParams[key] = parameters[key];
            }
          });
        }
      }

      // Replace path parameters
      for (const [key, value] of Object.entries(pathParams)) {
        url = url.replace(`{${key}}`, encodeURIComponent(String(value)));
      }

      // Security: Validate fully-constructed URL
      const fullUrlCheck = validateUrl(url);
      if (!fullUrlCheck.valid) {
        this.logger.warn(`SSRF blocked for constructed URL (tool ${tool.name}): ${fullUrlCheck.error}`);
        return {
          success: false,
          error: `Blocked: ${fullUrlCheck.error}`,
          executionTime: 0,
          cached: false,
          rateLimited: false,
          retryCount: 0,
        };
      }

      // Security: Sanitize user-provided headers
      const safeHeaders = sanitizeHeaders(headerParams as Record<string, string>);

      // Build request config
      const config: AxiosRequestConfig = {
        method: operation.method.toLowerCase() as any,
        url,
        timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
        maxContentLength: 10 * 1024 * 1024, // 10MB response limit
        maxBodyLength: 10 * 1024 * 1024,
        params: queryParams,
        paramsSerializer: (params) => {
          const parts: string[] = [];
          for (const [key, value] of Object.entries(params)) {
            if (Array.isArray(value)) {
              value.forEach(v => parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`));
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

      // Add authentication
      await this.addAuthentication(config, api, options);

      // Add body if needed
      if (bodyData && ['post', 'put', 'patch'].includes(operation.method.toLowerCase())) {
        config.data = bodyData;
      }

      // Execute request
      const response: AxiosResponse = await axios(config);

      return {
        success: true,
        data: response.data,
        executionTime: 0, // Will be set by caller
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: {
          httpStatus: response.status,
          headers: response.headers as Record<string, string>,
          requestId: response.headers['x-request-id'] || this.generateRequestId(),
        },
      };

    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const errorData = error.response?.data;
        
        return {
          success: false,
          data: errorData,
          error: `HTTP ${status}: ${typeof errorData === 'string' ? errorData : errorData?.message || error.message}`,
          executionTime: 0,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: {
            httpStatus: status,
            headers: error.response?.headers as Record<string, string>,
            requestId: error.response?.headers?.['x-request-id'] || this.generateRequestId(),
          },
        };
      }
      
      throw error;
    }
  }

  private async executeGraphQLOperation(
    tool: Tool,
    operation: Operation,
    api: Api,
    parameters: Record<string, any>,
    options: ToolExecutionOptions
  ): Promise<ToolExecutionResult> {
    try {
      // Security: Validate GraphQL endpoint URL
      const urlCheck = validateUrl(api.baseUrl);
      if (!urlCheck.valid) {
        this.logger.warn(`SSRF blocked for GraphQL tool ${tool.name}: ${urlCheck.error}`);
        return { success: false, error: `Blocked: ${urlCheck.error}`, executionTime: 0, cached: false, rateLimited: false, retryCount: 0 };
      }

      const graphqlRequest: GraphQLRequest = {
        query: parameters.query || operation.metadata?.query,
        variables: parameters.variables || parameters,
        operationName: parameters.operationName,
      };

      const config: AxiosRequestConfig = {
        method: 'POST',
        url: api.baseUrl,
        timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'LLM-Tool-Gateway/1.0',
        },
        data: graphqlRequest,
      };

      await this.addAuthentication(config, api, options);

      const response: AxiosResponse = await axios(config);

      // Check for GraphQL errors
      if (response.data.errors && response.data.errors.length > 0) {
        return {
          success: false,
          error: `GraphQL errors: ${response.data.errors.map(e => e.message).join(', ')}`,
          data: response.data,
          executionTime: 0,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: {
            httpStatus: response.status,
            headers: response.headers as Record<string, string>,
            requestId: response.headers['x-request-id'] || this.generateRequestId(),
          },
        };
      }

      return {
        success: true,
        data: response.data.data,
        executionTime: 0,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: {
          httpStatus: response.status,
          headers: response.headers as Record<string, string>,
          requestId: response.headers['x-request-id'] || this.generateRequestId(),
        },
      };

    } catch (error) {
      if (axios.isAxiosError(error)) {
        return {
          success: false,
          error: `GraphQL request failed: ${error.response?.data?.message || error.message}`,
          executionTime: 0,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: {
            httpStatus: error.response?.status,
            headers: error.response?.headers as Record<string, string>,
            requestId: error.response?.headers?.['x-request-id'] || this.generateRequestId(),
          },
        };
      }
      
      throw error;
    }
  }

  private async executeSOAPOperation(
    tool: Tool,
    operation: Operation,
    api: Api,
    parameters: Record<string, any>,
    options: ToolExecutionOptions
  ): Promise<ToolExecutionResult> {
    try {
      // Security: Validate SOAP endpoint URL
      const urlCheck = validateUrl(api.baseUrl);
      if (!urlCheck.valid) {
        this.logger.warn(`SSRF blocked for SOAP tool ${tool.name}: ${urlCheck.error}`);
        return { success: false, error: `Blocked: ${urlCheck.error}`, executionTime: 0, cached: false, rateLimited: false, retryCount: 0 };
      }

      const soapRequest: SOAPRequest = parameters as SOAPRequest;

      // Security: Sanitize SOAP user-provided headers
      const safeSoapHeaders = soapRequest.headers ? sanitizeHeaders(soapRequest.headers) : {};

      const config: AxiosRequestConfig = {
        method: 'POST',
        url: api.baseUrl,
        timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': soapRequest.action || `"${operation.name}"`,
          'User-Agent': 'LLM-Tool-Gateway/1.0',
          ...safeSoapHeaders,
        },
        data: soapRequest.envelope,
      };

      await this.addAuthentication(config, api, options);

      const response: AxiosResponse = await axios(config);

      // Parse SOAP response (basic parsing)
      const responseData = response.data;
      
      return {
        success: true,
        data: responseData,
        executionTime: 0,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: {
          httpStatus: response.status,
          headers: response.headers as Record<string, string>,
          requestId: response.headers['x-request-id'] || this.generateRequestId(),
        },
      };

    } catch (error) {
      if (axios.isAxiosError(error)) {
        return {
          success: false,
          error: `SOAP request failed: ${error.response?.data || error.message}`,
          executionTime: 0,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: {
            httpStatus: error.response?.status,
            headers: error.response?.headers as Record<string, string>,
            requestId: error.response?.headers?.['x-request-id'] || this.generateRequestId(),
          },
        };
      }
      
      throw error;
    }
  }

  private async executeProtobufOperation(
    tool: Tool,
    operation: Operation,
    api: Api,
    parameters: Record<string, any>,
    options: ToolExecutionOptions
  ): Promise<ToolExecutionResult> {
    try {
      // Security: Validate gRPC endpoint URL
      const grpcUrl = `${api.baseUrl}${operation.endpoint}`;
      const urlCheck = validateUrl(grpcUrl);
      if (!urlCheck.valid) {
        this.logger.warn(`SSRF blocked for gRPC tool ${tool.name}: ${urlCheck.error}`);
        return { success: false, error: `Blocked: ${urlCheck.error}`, executionTime: 0, cached: false, rateLimited: false, retryCount: 0 };
      }

      // For gRPC calls, we'd need grpc library, but for now simulate with HTTP/2
      const config: AxiosRequestConfig = {
        method: 'POST',
        url: grpcUrl,
        timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
        headers: {
          'Content-Type': 'application/grpc+proto',
          'User-Agent': 'LLM-Tool-Gateway/1.0',
        },
        data: parameters,
      };

      await this.addAuthentication(config, api, options);

      const response: AxiosResponse = await axios(config);

      return {
        success: true,
        data: response.data,
        executionTime: 0,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: {
          httpStatus: response.status,
          headers: response.headers as Record<string, string>,
          requestId: response.headers['x-request-id'] || this.generateRequestId(),
        },
      };

    } catch (error) {
      if (axios.isAxiosError(error)) {
        return {
          success: false,
          error: `gRPC request failed: ${error.response?.data || error.message}`,
          executionTime: 0,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: {
            httpStatus: error.response?.status,
            headers: error.response?.headers as Record<string, string>,
            requestId: error.response?.headers?.['x-request-id'] || this.generateRequestId(),
          },
        };
      }
      
      throw error;
    }
  }

  private async addAuthentication(
    config: AxiosRequestConfig,
    api: Api,
    options: ToolExecutionOptions
  ): Promise<void> {
    // 1. Try Credential entity (proper credential management)
    const credential = await this.credentialRepository.findOne({
      where: {
        apiId: api.id,
        organizationId: options.organizationId,
        isActive: true,
      },
      order: { createdAt: 'DESC' },
    });

    if (credential) {
      await this.applyCredential(config, credential);
      return;
    }

    // 2. Fallback to legacy api.authentication field
    if (!api.authentication) {
      return;
    }

    const authConfig = api.authentication;

    switch (authConfig.type) {
      case 'bearer':
        config.headers.Authorization = `Bearer ${authConfig.config.token}`;
        break;

      case 'basic':
        const basicCreds = Buffer.from(`${authConfig.config.username}:${authConfig.config.password}`).toString('base64');
        config.headers.Authorization = `Basic ${basicCreds}`;
        break;

      case 'api_key':
        if (authConfig.config.location === 'header') {
          config.headers[authConfig.config.name] = authConfig.config.value;
        } else if (authConfig.config.location === 'query') {
          config.params = config.params || {};
          config.params[authConfig.config.name] = authConfig.config.value;
        }
        break;

      case 'oauth2':
        if (authConfig.config.accessToken) {
          config.headers.Authorization = `Bearer ${authConfig.config.accessToken}`;
        }
        break;
    }
  }

  private async applyCredential(config: AxiosRequestConfig, credential: Credential): Promise<void> {
    // Check if OAuth2 token needs refresh
    if (credential.type === CredentialType.OAUTH2 && credential.isExpired()) {
      try {
        const { CredentialService } = await import('../apis/credential.service');
        const credService = this.moduleRef?.get(CredentialService, { strict: false });
        if (credService) {
          await credService.refreshOAuthToken(credential);
        }
      } catch (e) {
        this.logger.warn(`OAuth2 token refresh failed for credential ${credential.id}: ${e.message}`);
      }
    }

    // Apply auth headers from credential
    const authHeaders = credential.getAuthHeaders();
    Object.assign(config.headers, authHeaders);

    // Apply query params from credential
    const queryParams = credential.getQueryParams();
    if (Object.keys(queryParams).length > 0) {
      config.params = { ...config.params, ...queryParams };
    }

    // Mark as used (fire-and-forget)
    this.credentialRepository.update(credential.id, { lastUsedAt: new Date() }).catch(() => {});
  }

  private async executeHttpTool(
    tool: Tool,
    parameters: Record<string, any>,
    options: { organizationId: string; userId?: string },
  ): Promise<any> {
    const httpConfig = tool.httpConfig!;
    const startTime = Date.now();
    const api = tool.api ?? tool.operation?.api ?? null;

    try {
      // 1. URL construction
      let url = httpConfig.path;
      if (api?.baseUrl && !url.startsWith('http')) {
        const base = api.baseUrl.replace(/\/+$/, '');
        const path = url.replace(/^\/+/, '');
        url = `${base}/${path}`;
      }

      // 2. Path param substitution
      const pathParamNames: string[] = [];
      url = url.replace(/\{(\w+)\}/g, (match, name) => {
        pathParamNames.push(name);
        if (name in parameters) {
          return encodeURIComponent(String(parameters[name]));
        }
        return match;
      });

      // 3. SSRF validation
      const urlCheck = validateUrl(url);
      if (!urlCheck.valid) {
        this.logger.warn(`SSRF blocked for HTTP tool ${tool.name}: ${urlCheck.error}`);
        return {
          success: false,
          data: null,
          error: `Blocked: ${urlCheck.error}`,
          executionTime: Date.now() - startTime,
          cached: false,
          metadata: { url, method: httpConfig.method },
        };
      }

      // 4. Query params
      const queryParams: Record<string, any> = {};
      if (httpConfig.queryParams) {
        for (const [key, val] of Object.entries(httpConfig.queryParams)) {
          queryParams[key] = String(val).replace(/\{(\w+)\}/g, (_, n) =>
            n in parameters ? String(parameters[n]) : `{${n}}`
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

      // 5. Body
      let body: any = undefined;
      const encoding = httpConfig.bodyEncoding ?? 'json';
      if (['POST', 'PUT', 'PATCH'].includes(httpConfig.method)) {
        if (httpConfig.bodyTemplate) {
          try {
            let templated = httpConfig.bodyTemplate;
            templated = templated.replace(/\{(\w+)\}/g, (match, name) => {
              if (name in parameters) {
                const v = parameters[name];
                return typeof v === 'string' ? v : JSON.stringify(v);
              }
              return match;
            });
            body = JSON.parse(templated);
          } catch {
            body = httpConfig.bodyTemplate.replace(/\{(\w+)\}/g, (_, n) =>
              n in parameters ? String(parameters[n]) : `{${n}}`
            );
          }
        } else {
          const bodyParams: Record<string, any> = {};
          for (const [k, v] of Object.entries(parameters)) {
            if (!pathParamNames.includes(k)) bodyParams[k] = v;
          }
          body = bodyParams;
        }
      }

      // 6. Headers
      const headers: Record<string, string> = {};
      if (api?.headers) Object.assign(headers, api.headers);
      if (httpConfig.headers) {
        for (const [k, v] of Object.entries(httpConfig.headers)) {
          headers[k] = String(v).replace(/\{(\w+)\}/g, (_, n) =>
            n in parameters ? String(parameters[n]) : `{${n}}`
          );
        }
      }
      if (body !== undefined) {
        switch (encoding) {
          case 'json': headers['Content-Type'] = 'application/json'; break;
          case 'form-urlencoded': headers['Content-Type'] = 'application/x-www-form-urlencoded'; break;
          case 'raw': headers['Content-Type'] = headers['Content-Type'] ?? 'text/plain'; break;
        }
      }
      const safeHeaders = sanitizeHeaders(headers);

      // 7. Axios config
      const timeout = tool.configuration?.timeout ?? api?.timeoutMs ?? 30000;
      const axiosConfig: any = {
        method: httpConfig.method,
        url,
        timeout,
        maxContentLength: 10 * 1024 * 1024,
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

      // 8. Auth
      if (api) {
        await this.addAuthentication(axiosConfig, api, {
          organizationId: options.organizationId,
          userId: options.userId,
        } as ToolExecutionOptions);
      } else if (tool.authConfig) {
        // Inline auth for standalone tools
        if (tool.authConfig.type === 'bearer' && tool.authConfig.config?.token) {
          axiosConfig.headers['Authorization'] = `Bearer ${tool.authConfig.config.token}`;
        } else if (tool.authConfig.type === 'apiKey' && tool.authConfig.config?.key) {
          axiosConfig.headers[tool.authConfig.config.headerName || 'X-API-Key'] = tool.authConfig.config.key;
        }
      }

      // 9. Body data encoding
      if (body !== undefined) {
        switch (encoding) {
          case 'json':
            axiosConfig.data = body;
            break;
          case 'form-urlencoded':
            axiosConfig.data = this.encodeFormUrlencoded(body);
            break;
          case 'multipart': {
            const FormData = require('form-data');
            const fd = new FormData();
            for (const [k, v] of Object.entries(body)) {
              fd.append(k, v);
            }
            axiosConfig.data = fd;
            Object.assign(axiosConfig.headers, fd.getHeaders());
            break;
          }
          case 'raw':
            axiosConfig.data = typeof body === 'string' ? body : JSON.stringify(body);
            break;
        }
      }

      // 10. Execute (with or without pagination)
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
        metadata: { url, method: httpConfig.method, httpStatus: 200 },
      };

    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      if (axios.isAxiosError(error) || error.isAxiosError) {
        const status = error.response?.status ?? 0;
        const errorData = error.response?.data;
        let errorMessage = error.message;
        if (httpConfig.responseMapping?.errorPath && errorData) {
          const extracted = this.getByDotPath(errorData, httpConfig.responseMapping.errorPath);
          if (extracted) errorMessage = String(extracted);
        }
        return {
          success: false,
          data: errorData ?? null,
          error: errorMessage,
          executionTime,
          cached: false,
          metadata: { url: httpConfig.path, method: httpConfig.method, httpStatus: status },
        };
      }
      return {
        success: false,
        data: null,
        error: error.message,
        executionTime,
        cached: false,
      };
    }
  }

  private encodeFormUrlencoded(body: Record<string, any>): string {
    const params = new URLSearchParams();
    const flatten = (obj: any, prefix = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}[${key}]` : key;
        if (Array.isArray(value)) {
          value.forEach(v => params.append(`${fullKey}[]`, String(v)));
        } else if (typeof value === 'object' && value !== null) {
          flatten(value, fullKey);
        } else if (value !== undefined && value !== null) {
          params.append(fullKey, String(value));
        }
      }
    };
    flatten(body);
    return params.toString();
  }

  private processHttpResponse(response: any, httpConfig: any): any {
    const mapping = httpConfig.responseMapping;
    let data = response.data;

    if (mapping?.successCondition) {
      const success = this.evaluateHttpSuccessCondition(mapping.successCondition, response.status, data);
      if (!success) {
        const errorMsg = mapping.errorPath ? this.getByDotPath(data, mapping.errorPath) : 'Request failed';
        const err: any = new Error(String(errorMsg));
        err.response = response;
        err.isAxiosError = true;
        throw err;
      }
    }

    if (mapping?.dataPath) {
      data = this.getByDotPath(data, mapping.dataPath);
    }

    return data;
  }

  private getByDotPath(obj: any, path: string): any {
    return path.split('.').reduce((curr, key) => {
      if (curr === null || curr === undefined) return undefined;
      return curr[key];
    }, obj);
  }

  private evaluateHttpSuccessCondition(condition: string, status: number, data: any): boolean {
    const trimmed = condition.trim();

    // "status < 400"
    const statusMatch = trimmed.match(/^status\s*(===?|!==?|<|>|<=|>=)\s*(\d+)$/);
    if (statusMatch) {
      const [, op, val] = statusMatch;
      return this.compareConditionValues(status, op, Number(val));
    }

    // "data.ok === true"
    const dataMatch = trimmed.match(/^data\.(.+?)\s*(===?|!==?)\s*(.+)$/);
    if (dataMatch) {
      const [, path, op, rawVal] = dataMatch;
      const actual = this.getByDotPath(data, path);
      let expected: any = rawVal.trim();
      if (expected === 'true') expected = true;
      else if (expected === 'false') expected = false;
      else if (expected === 'null') expected = null;
      else if (expected === 'undefined') expected = undefined;
      else if (/^\d+$/.test(expected)) expected = Number(expected);
      else expected = expected.replace(/^['"]|['"]$/g, '');
      return this.compareConditionValues(actual, op, expected);
    }

    return status >= 200 && status < 400;
  }

  private compareConditionValues(a: any, op: string, b: any): boolean {
    switch (op) {
      case '==': case '===': return a === b;
      case '!=': case '!==': return a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
      default: return false;
    }
  }

  private async executeWithPagination(baseConfig: any, httpConfig: any): Promise<any[]> {
    const pagination = httpConfig.pagination;
    const maxPages = pagination.maxPages ?? 5;
    const allResults: any[] = [];
    let pageCount = 0;
    let nextCursor: string | null = null;
    let nextUrl: string | null = null;
    let offset = 0;

    while (pageCount < maxPages) {
      const pageConfig = { ...baseConfig, params: { ...baseConfig.params }, headers: { ...baseConfig.headers } };

      switch (pagination.type) {
        case 'cursor':
          if (nextUrl) {
            pageConfig.url = nextUrl.startsWith('http') ? nextUrl : `${baseConfig.url}${nextUrl}`;
            if (nextUrl.startsWith('http')) pageConfig.params = undefined;
          } else if (nextCursor && pagination.cursorParam) {
            pageConfig.params = pageConfig.params || {};
            pageConfig.params[pagination.cursorParam] = nextCursor;
          }
          break;
        case 'offset':
          pageConfig.params = pageConfig.params || {};
          if (pagination.offsetParam) pageConfig.params[pagination.offsetParam] = offset;
          if (pagination.limitParam && pagination.defaultLimit) pageConfig.params[pagination.limitParam] = pagination.defaultLimit;
          break;
        case 'link-header':
          if (nextUrl) { pageConfig.url = nextUrl; pageConfig.params = undefined; }
          break;
      }

      const response = await axios(pageConfig);
      const processed = this.processHttpResponse(response, httpConfig);

      const results = pagination.resultsPath
        ? this.getByDotPath(response.data, pagination.resultsPath)
        : processed;

      if (Array.isArray(results)) allResults.push(...results);
      else if (results !== undefined && results !== null) allResults.push(results);

      pageCount++;
      let hasNext = false;

      switch (pagination.type) {
        case 'cursor':
          if (pagination.cursorPath) {
            const cursor = this.getByDotPath(response.data, pagination.cursorPath);
            if (cursor) {
              if (typeof cursor === 'string' && (cursor.startsWith('http') || cursor.startsWith('/'))) {
                nextUrl = cursor; nextCursor = null;
              } else {
                nextCursor = String(cursor); nextUrl = null;
              }
              hasNext = true;
            }
          }
          break;
        case 'offset': {
          const limit = pagination.defaultLimit ?? 20;
          if (Array.isArray(results) && results.length >= limit) { offset += limit; hasNext = true; }
          break;
        }
        case 'link-header': {
          const linkHeader = response.headers?.link || response.headers?.Link;
          if (linkHeader) {
            const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            if (m) { nextUrl = m[1]; hasNext = true; }
          }
          break;
        }
      }

      if (!hasNext) break;
    }

    return allResults;
  }

  private async validateParameters(
    tool: Tool,
    parameters: Record<string, any>
  ): Promise<{ isValid: boolean; errors: string[] }> {
    try {
      if (tool.inputSchema) {
        // Use the JSON schema validation
        return tool.inputSchema.validate(parameters);
      }

      // Fallback to basic validation using tool parameters
      const errors: string[] = [];
      const toolParams = tool.parameters;

      if (toolParams?.required) {
        for (const requiredParam of toolParams.required) {
          if (!(requiredParam in parameters)) {
            errors.push(`Missing required parameter: ${requiredParam}`);
          }
        }
      }

      return {
        isValid: errors.length === 0,
        errors,
      };

    } catch (error) {
      return {
        isValid: false,
        errors: [`Parameter validation error: ${error.message}`],
      };
    }
  }

  private async checkRateLimit(
    tool: Tool,
    options: ToolExecutionOptions
  ): Promise<{ limited: boolean; message?: string }> {
    try {
      const rateLimitConfig = tool.configuration?.rateLimit;
      if (!rateLimitConfig) {
        return { limited: false };
      }

      const userId = options.userId;
      const toolId = tool.id;

      // Check per-minute limit
      if (rateLimitConfig.requestsPerMinute) {
        const minuteKey = `rate_limit:${toolId}:${userId}:minute:${Math.floor(Date.now() / 60000)}`;
        const currentMinuteCount = await this.redis.incr(minuteKey);
        await this.redis.expire(minuteKey, 60);

        if (currentMinuteCount > rateLimitConfig.requestsPerMinute) {
          return {
            limited: true,
            message: `Exceeded ${rateLimitConfig.requestsPerMinute} requests per minute`
          };
        }
      }

      // Check per-hour limit
      if (rateLimitConfig.requestsPerHour) {
        const hourKey = `rate_limit:${toolId}:${userId}:hour:${Math.floor(Date.now() / 3600000)}`;
        const currentHourCount = await this.redis.incr(hourKey);
        await this.redis.expire(hourKey, 3600);

        if (currentHourCount > rateLimitConfig.requestsPerHour) {
          return {
            limited: true,
            message: `Exceeded ${rateLimitConfig.requestsPerHour} requests per hour`
          };
        }
      }

      return { limited: false };
    } catch (error) {
      // Fail open: allow requests when Redis is unavailable
      this.logger.warn(`Rate limiting check failed, allowing request: ${error.message}`);
      return { limited: false };
    }
  }

  private async getCachedResult(
    tool: Tool,
    parameters: Record<string, any>
  ): Promise<ToolExecutionResult | null> {
    try {
      const cacheKey = this.generateCacheKey(tool.id, parameters);
      const cached = await this.redis.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }
      
      return null;
    } catch (error) {
      this.logger.warn(`Cache retrieval failed: ${error.message}`);
      return null;
    }
  }

  private async cacheResult(
    tool: Tool,
    parameters: Record<string, any>,
    result: ToolExecutionResult
  ): Promise<void> {
    try {
      const cacheConfig = tool.configuration?.cache;
      if (!cacheConfig?.enabled) {
        return;
      }

      const cacheKey = this.generateCacheKey(tool.id, parameters);
      const ttl = cacheConfig.ttl || 300; // 5 minutes default
      
      await this.redis.setex(cacheKey, ttl, JSON.stringify(result));
    } catch (error) {
      this.logger.warn(`Cache storage failed: ${error.message}`);
    }
  }

  private generateCacheKey(toolId: string, parameters: Record<string, any>): string {
    const paramHash = this.hashObject(parameters);
    return `tool_cache:${toolId}:${paramHash}`;
  }

  private hashObject(obj: any): string {
    const crypto = require('crypto');
    const str = JSON.stringify(obj, Object.keys(obj).sort());
    return crypto.createHash('md5').update(str).digest('hex');
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private async recordExecution(
    tool: Tool,
    parameters: Record<string, any>,
    result: ToolExecutionResult,
    options: ToolExecutionOptions,
    metadata: {
      cached: boolean;
      executionTime: number;
      retryCount: number;
    }
  ): Promise<void> {
    try {
      const execution = this.toolExecutionRepository.create({
        toolId: tool.id,
        userId: options.userId,
        organizationId: options.organizationId,
        parameters,
        result: result.data,
        success: result.success,
        error: result.error,
        executionTime: metadata.executionTime,
        cached: metadata.cached,
        retryCount: metadata.retryCount,
        metadata: {
          httpStatus: result.metadata?.httpStatus,
          requestId: result.metadata?.requestId,
          rateLimited: result.rateLimited,
        },
      });

      await this.toolExecutionRepository.save(execution);

      // Audit log (fire-and-forget)
      this.auditLogService.logToolExecution(
        options.organizationId,
        options.userId,
        tool.id,
        tool.name,
        { success: result.success, executionTime: metadata.executionTime, parameters },
      );

      // Update tool stats (usageCount, lastUsedAt, successRate, averageResponseTime)
      try {
        tool.incrementUsage();
        tool.updateMetrics(metadata.executionTime, result.success);
        await this.toolRepository.save(tool);
      } catch (statsError) {
        this.logger.error(`Failed to update tool stats: ${statsError.message}`);
      }
    } catch (error) {
      this.logger.error(`Failed to record tool execution: ${error.message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getToolExecutionStats(
    toolId: string,
    organizationId: string,
    timeframe: 'hour' | 'day' | 'week' | 'month' = 'day'
  ): Promise<{
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    averageExecutionTime: number;
    cacheHitRate: number;
    rateLimitedExecutions: number;
  }> {
    const timeframeDurations = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
    };

    const since = new Date(Date.now() - timeframeDurations[timeframe]);

    const executions = await this.toolExecutionRepository.find({
      where: {
        toolId,
        organizationId,
        createdAt: { $gte: since } as any,
      },
    });

    const total = executions.length;
    const successful = executions.filter(e => e.success).length;
    const failed = total - successful;
    const avgTime = total > 0 ? executions.reduce((sum, e) => sum + e.executionTime, 0) / total : 0;
    const cached = executions.filter(e => e.cached).length;
    const cacheHitRate = total > 0 ? (cached / total) * 100 : 0;
    const rateLimited = executions.filter(e => e.metadata?.rateLimited).length;

    return {
      totalExecutions: total,
      successfulExecutions: successful,
      failedExecutions: failed,
      averageExecutionTime: Math.round(avgTime),
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      rateLimitedExecutions: rateLimited,
    };
  }
}