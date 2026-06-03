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

  // Non-HTTP protocol execution configs. Entity columns are typed via
  // GraphqlConfig / SoapConfig / GrpcConfig in tool.entity.ts; we keep
  // the service-side shape `any` because the executor validates
  // structure when it dispatches.
  llmConfig?: any;
  graphqlConfig?: any;
  soapConfig?: any;
  grpcConfig?: any;
  examples?: Array<{ name: string; description?: string; input: Record<string, any>; expectedOutput?: any }>;

  // Team-scoping fields from the dashboard VisibilityField.
  visibility?: 'org' | 'team';
  teamId?: string | null;
  executionMethod?: ToolExecutionMethod;
  authConfig?: any;
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

  // Non-HTTP protocol execution configs — same rationale as CreateToolDto.
  httpConfig?: any;
  llmConfig?: any;
  graphqlConfig?: any;
  soapConfig?: any;
  grpcConfig?: any;
  examples?: Array<{ name: string; description?: string; input: Record<string, any>; expectedOutput?: any }>;
  // Team-scoping fields from the dashboard VisibilityField.
  visibility?: 'org' | 'team';
  teamId?: string | null;
}

export interface ToolSearchFilters {
  search?: string;
  type?: ToolType;
  status?: ToolStatus;
  categoryIds?: string[];
  apiId?: string;
  tags?: string[];
  organizationId: string;
  // The caller is required so getTools applies the team-scope
  // visibility filter via AccessPolicyService.applyListFilter.
  // System contexts that legitimately need the unscoped org-wide
  // listing (gateway tool resolution, MCP tools/list, audit jobs)
  // set bypassTeamFilter=true instead — making the bypass loud at
  // the callsite rather than silent like the old org-only filter.
  caller?: { id: string };
  bypassTeamFilter?: boolean;
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
