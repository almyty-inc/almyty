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

import { GatewayToolSecurityPolicy } from '../../common/security/gateway-tool-policy';
import type { ToolInvocationBudget } from './executors/tool-invocation-budget';
export { GatewayToolSecurityPolicy };

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
  /**
   * Which gateway this call came through, and which agent run made it.
   * Both are normally taken from the correlation scope (see
   * `ToolStatsHelper.recordExecution`); these are for a caller that knows
   * better than the scope does. `tool_executions.gatewayId` existed with
   * nothing populating it, and there was no runId column at all.
   */
  gatewayId?: string | null;
  runId?: string | null;
  /**
   * The `gateway_tools.securityPolicy` row governing this call.
   *
   * Normally left undefined: `ToolExecutorService.executeTool` resolves it
   * from `gatewayId` + `toolId` before dispatch. Callers that already hold
   * the gateway_tool row may pass it (or explicit `null` for "no policy")
   * to skip that lookup. The executors enforce it at every outbound
   * request; see `common/security/gateway-tool-policy.ts`.
   */
  securityPolicy?: GatewayToolSecurityPolicy | null;
  /**
   * OAuth / API-key scopes the caller presented, checked against
   * `gateway_tools.permissions.requiredScopes` before dispatch.
   *
   * Absent means the caller presented none, and a tool that requires a
   * scope refuses — fail-closed, because the alternative for an access
   * control is to let an unproven caller through. The refusal names the
   * scopes it wanted, so the failure explains itself.
   *
   * Only the gateway-protocol path fills this today (it carries
   * `ProtocolRequest.scopes`). The MCP and UTCP handlers authenticate at
   * the gateway and do not thread the resulting scopes down to the
   * executor, so `requiredScopes` on a tool served over those surfaces
   * refuses everyone until that plumbing exists. Use allowedUsers /
   * allowedRoles / allowedOrganizations there, or do the plumbing.
   */
  scopes?: string[];
  /**
   * Set only on a call made by `tools.invoke` from inside a sandboxed
   * tool: the security policy that governed the tool that made it.
   *
   * A nested call re-resolves its own gateway_tools row from `gatewayId`
   * (so the nested tool's own access list and policy apply on that
   * gateway). When the nested tool has no row there, or its row carries
   * no policy, this is the policy it is held to instead -- otherwise an
   * allowed-domains restriction would stop applying one hop in.
   */
  inheritedSecurityPolicy?: GatewayToolSecurityPolicy | null;
  /**
   * Set only on a call made by `tools.invoke`: how deep in the nested
   * call tree it sits (1 = called by the root tool) and the budget the
   * whole tree shares. See `executors/tool-invocation-budget.ts`. Absent
   * means this is a root execution.
   */
  invocation?: ToolInvocationContext;
}

export interface ToolInvocationContext {
  depth: number;
  budget: ToolInvocationBudget;
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
