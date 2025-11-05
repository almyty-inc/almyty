import { Injectable, Logger, BadRequestException } from '@nestjs/common';
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
    @InjectRedis() private readonly redis: Redis.Redis,
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
        relations: ['operation', 'operation.api', 'inputSchema', 'outputSchema'],
      });

      if (!tool) {
        throw new Error('Tool not found');
      }

      if (tool.status !== ToolStatus.ACTIVE) {
        throw new Error(`Tool is ${tool.status}, cannot execute`);
      }

      // Validate user has access
      const user = await this.userRepository.findOne({
        where: { id: options.userId },
        relations: ['organizationMemberships'],
      });

      if (!user?.hasPermissionInOrganization(options.organizationId, 'use_tools')) {
        throw new Error('User does not have permission to use tools in this organization');
      }

      // Validate parameters
      const validation = await this.validateParameters(tool, parameters);
      if (!validation.isValid) {
        throw new BadRequestException(`Invalid parameters: ${validation.errors.join(', ')}`);
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

      // Execute with retries
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
      // Build URL
      let url = `${api.baseUrl}${operation.endpoint}`;
      const pathParams = parameters.path || {};
      const queryParams = parameters.query || {};
      const headerParams = parameters.header || {};
      const bodyData = parameters.body;

      // Replace path parameters
      for (const [key, value] of Object.entries(pathParams)) {
        url = url.replace(`{${key}}`, encodeURIComponent(String(value)));
      }

      // Build request config
      const config: AxiosRequestConfig = {
        method: operation.method.toLowerCase() as any,
        url,
        timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
        params: queryParams,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'LLM-Tool-Gateway/1.0',
          ...headerParams,
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
          error: `HTTP ${status}: ${errorData?.message || error.message}`,
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
      const soapRequest: SOAPRequest = parameters as SOAPRequest;
      
      const config: AxiosRequestConfig = {
        method: 'POST',
        url: api.baseUrl,
        timeout: options.timeout ?? tool.configuration?.timeout ?? 30000,
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': soapRequest.action || `"${operation.name}"`,
          'User-Agent': 'LLM-Tool-Gateway/1.0',
          ...soapRequest.headers,
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
      // For gRPC calls, we'd need grpc library, but for now simulate with HTTP/2
      const config: AxiosRequestConfig = {
        method: 'POST',
        url: `${api.baseUrl}${operation.endpoint}`,
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
    if (!api.authentication) {
      return;
    }

    const authConfig = api.authentication;

    switch (authConfig.type) {
      case 'bearer':
        config.headers.Authorization = `Bearer ${authConfig.config.token}`;
        break;
      
      case 'basic':
        const credentials = Buffer.from(`${authConfig.config.username}:${authConfig.config.password}`).toString('base64');
        config.headers.Authorization = `Basic ${credentials}`;
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
        // In a real implementation, we'd handle OAuth2 flow here
        if (authConfig.config.accessToken) {
          config.headers.Authorization = `Bearer ${authConfig.config.accessToken}`;
        }
        break;
    }
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