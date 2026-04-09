/**
 * Shared types for the tool-execution pipeline.
 *
 * These used to live in `tool-executor.service.ts`. Extracted to a
 * dedicated module so the per-type executor services can import them
 * without creating a dependency cycle back to the orchestrator.
 *
 * Re-exported from `tool-executor.service.ts` so existing callers
 * that import from the old path keep working.
 */

export interface ToolExecutionOptions {
  userId: string;
  organizationId: string;
  timeout?: number;
  retries?: number;
  skipCache?: boolean;
  skipRateLimit?: boolean;
  /**
   * Cooperative cancellation signal. If the caller's context
   * (HTTP request, parent agent run, scheduled job) is cancelled,
   * pass the AbortSignal here and every outbound axios call inside
   * the executor will be aborted in-flight via axios's native
   * `signal` config. The orchestrator also checks `signal.aborted`
   * between the validation / rate-limit / cache / dispatch steps
   * so a cancellation that fires before the HTTP call still
   * short-circuits the pipeline.
   */
  signal?: AbortSignal;
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
