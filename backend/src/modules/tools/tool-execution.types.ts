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
import type { ExecutionPrincipal } from '../../common/authorization/execution-access.service';
import type { ApprovalGateHit } from './tool-approval-gate.service';
export { GatewayToolSecurityPolicy };

export interface ToolExecutionOptions {
  userId: string;
  organizationId: string;
  /**
   * Whose scope this call executes in: the user who started it, or the
   * gateway it came through, inherited unchanged by every nested call.
   * The executor refuses (as "not found") a team tool the principal is not
   * a member for and anyone's private tool but the owner's
   * (ExecutionAccessService). Every production caller passes it --
   * `execution-access-guard.spec.ts` enforces that; without one the call
   * is authorized as `userId`.
   */
  principal?: ExecutionPrincipal;
  /**
   * Label requirements for a runner-backed tool (`{ gpu: 'yes' }`), from
   * the agent's config. The call goes to an online runner the principal
   * may use whose labels include all of them, rather than only the runner
   * the tool was published for. Ignored by every other tool type.
   */
  runnerLabels?: Record<string, string>;
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
   * The agent whose run made this call (else the correlation scope's).
   * A runner-backed tool that needs a workspace and was given none gets
   * one for this run, attributed to this agent (RunWorkspaceService).
   */
  agentId?: string | null;
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
  /**
   * An approved request that covers this exact call (same tool, same
   * parameters), raised when an approval policy's amount rule held it.
   * The executor checks it against the rule before letting the call run.
   */
  approvedGate?: { approvalId: string };
  /**
   * Who asks a person when an approval policy's amount rule holds the
   * call. 'caller': the caller does (the autonomous runtime, which pauses
   * its run); the executor only reports the hit. Absent: the executor holds
   * the call itself and it runs once approved (ToolApprovalGateService).
   */
  holdForApproval?: 'caller';
  /**
   * The run_code script making this call (code_executions.id): recorded on
   * the tool_executions row, so a script's calls are its call tree.
   */
  codeExecutionId?: string | null;
  /**
   * The team of the agent making the call. A team's amount rule holds only
   * that team's agents; absent (no agent behind the call), every rule on
   * the tool applies.
   */
  agentTeamId?: string | null;
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
  /**
   * The tool does not exist in the caller's organization, or exists outside
   * the call's scope (a team tool for a non-member, someone else's private
   * tool). One flag for both, so an HTTP surface can answer 404 without
   * being able to tell them apart.
   */
  notFound?: boolean;
  /**
   * Set when an approval policy's amount rule held the call: it did not
   * run. The autonomous runtime asks a person and calls again with
   * `approvedGate`; every other caller reports the refusal.
   */
  approvalRequired?: ApprovalGateHit;
  /** A held call: the approval request it waits on (callers retry with it as `_approvalId`). */
  approvalId?: string;
  /** A held call: 'pending' while it waits, 'rejected' once refused. */
  approvalStatus?: 'pending' | 'rejected';
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
