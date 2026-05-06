import { ToolStatus, ToolType, ToolExecutionMethod } from '../../../entities/tool.entity';
export interface CreateToolDto {
  name: string;
  description: string;
  type: ToolType;
  parameters: Record<string, any>;
  code?: string; // Custom JavaScript code for custom tools
  httpConfig?: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
    bodyEncoding?: 'json' | 'form-urlencoded' | 'multipart' | 'raw';
    bodyTemplate?: string;
    responseMapping?: any;
    pagination?: any;
  };
  apiId?: string;
  configuration?: {
    timeout?: number;
    retries?: number;
    cache?: {
      enabled: boolean;
      ttl?: number;
    };
    rateLimit?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
  };
  categoryIds?: string[];
  operationId?: string;
  inputSchemaId?: string;
  outputSchemaId?: string;
  metadata?: Record<string, any>;

  /**
   * SDK tool fields. When set, the executor uses node-sandbox to
   * import the npm package, run the configured method, and return
   * the result — see executors/tool-script.executor.ts:executeSdk
   * + node-sandbox/sdk-code-assembler.service.ts.
   */
  sdkConfig?: any;
  dependencies?: Record<string, string>;
}

export interface UpdateToolDto {
  name?: string;
  description?: string;
  parameters?: Record<string, any>;
  code?: string;
  configuration?: {
    timeout?: number;
    retries?: number;
    cache?: {
      enabled: boolean;
      ttl?: number;
    };
    rateLimit?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
  };
  categoryIds?: string[];
  metadata?: Record<string, any>;
  sdkConfig?: any;
  dependencies?: Record<string, string>;
}

export interface ToolSearchFilters {
  search?: string;
  type?: ToolType;
  status?: ToolStatus;
  categoryIds?: string[];
  apiId?: string;
  tags?: string[];
  organizationId: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'usage';
  sortOrder?: 'ASC' | 'DESC';
}

export interface ToolUsageStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageExecutionTime: number;
  cacheHitRate: number;
  rateLimitedExecutions: number;
  uniqueUsers: number;
  executionTrend: Array<{
    date: string;
    executions: number;
    success: number;
    failed: number;
  }>;
}
