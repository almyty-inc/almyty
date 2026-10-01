/**
 * A held tool call (#886) over MCP 2026-07-28 multi round-trip requests.
 *
 * An approval policy's amount rule holds a call ("ask before issue_refund
 * when amount is over 500"). A legacy client is told it is waiting and gets
 * an `_approvalId` to call again with; that path is unchanged. A 2026 client
 * that declared elicitation, called by someone who could approve the
 * request in Approvals (owner decision 6), is asked instead: the call answers
 * `resultType: "input_required"` with an approve-or-reject form and a sealed
 * `requestState` naming the approval. The retry carries the decision; the
 * decision goes through ApprovalsService like one made on the Approvals
 * page, the approved call runs once (ToolApprovalGateService.runHeld), and
 * the retry returns its result when it is ready within MCP_HELD_CALL_WAIT_MS.
 *
 * Anyone else, and any client that did not declare elicitation, keeps the
 * "waiting for approval" answer.
 */
import { ApprovalRequest } from '../../../entities/approval-request.entity';
import { JsonRpcErrorCode } from '../types/mcp.types';
import { McpCallContext, McpPolymorphicResult, declaresElicitation, mcpError } from '../core/mcp-protocol-core';
import { REQUEST_STATE_REFUSAL_MESSAGE, openRequestState, sealRequestState } from '../core/mcp-request-state';
import { applyApprovalAnswer, approvalInputKey, approvalInputRequest, parseElicitAnswer } from './mcp-approval-input';

export const HELD_CALL_STATE_KIND = 'held_call';

export interface HeldCallApprovals {
  findInOrganization(id: string, organizationId: string): Promise<ApprovalRequest | null>;
  canDecide(row: ApprovalRequest, caller: { id: string } | null | undefined): Promise<boolean>;
  approve(id: string, d: { decidedBy: string; decisionReason?: string }, caller: { id: string }, org: string): Promise<ApprovalRequest>;
  reject(id: string, d: { decidedBy: string; decisionReason?: string }, caller: { id: string }, org: string): Promise<ApprovalRequest>;
}

/** The fields of a tool execution result that say a call was held. */
export interface HeldCallMarker {
  approvalRequired?: unknown;
  approvalStatus?: string;
  approvalId?: string;
}

function inputRequired(row: ApprovalRequest, userId: string, params: any): McpPolymorphicResult {
  return {
    resultType: 'input_required',
    inputRequests: { [approvalInputKey(row.id)]: approvalInputRequest(row) },
    requestState: sealRequestState(
      { kind: HELD_CALL_STATE_KIND, data: { approvalId: row.id } },
      { principal: userId, method: 'tools/call', params },
    ),
  };
}

/**
 * After a call ran: if it was held and this caller could approve it, ask
 * them (input_required). Otherwise null, and the legacy answer stands.
 */
export async function heldCallInputRequired(
  result: HeldCallMarker,
  params: any,
  ctx: McpCallContext | undefined,
  userId: string | null | undefined,
  organizationId: string,
  approvals: HeldCallApprovals | null,
): Promise<McpPolymorphicResult | null> {
  if (!approvals || !userId || !declaresElicitation(ctx)) return null;
  if (!result.approvalRequired || result.approvalStatus !== 'pending' || !result.approvalId) return null;
  const row = await approvals.findInOrganization(result.approvalId, organizationId);
  if (!row || !(await approvals.canDecide(row, { id: userId }))) return null;
  return inputRequired(row, userId, params);
}

/**
 * Before a call runs: a retry that carries `requestState`. Applies the
 * decision it carries and returns the approval id to call again with, or
 * the same question again when the answer is missing or the person closed
 * the form, as the MRTR page asks a server to do.
 */
export async function heldCallRetry(
  params: any,
  ctx: McpCallContext | undefined,
  userId: string | null | undefined,
  organizationId: string,
  approvals: HeldCallApprovals | null,
): Promise<{ approvalId: string; decided: boolean } | { again: McpPolymorphicResult }> {
  if (!ctx || ctx.era !== 'modern') {
    throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'requestState is only accepted from a 2026-07-28 request');
  }
  const opened = openRequestState(params?.requestState, { principal: userId ?? null, method: 'tools/call', params });
  if ('refusal' in opened) {
    throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, `Invalid requestState: ${REQUEST_STATE_REFUSAL_MESSAGE[opened.refusal]}`);
  }
  const approvalId = opened.payload.data.approvalId;
  if (opened.payload.kind !== HELD_CALL_STATE_KIND || typeof approvalId !== 'string' || !approvals) {
    throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'Invalid requestState: not for this request');
  }
  const responses = params?.inputResponses;
  if (responses !== undefined && (responses === null || typeof responses !== 'object' || Array.isArray(responses))) {
    throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'inputResponses must be an object');
  }
  const row = await approvals.findInOrganization(approvalId, organizationId);
  // Decided elsewhere meanwhile (or gone): the call itself says where it stands.
  if (!row || row.status !== 'pending') return { approvalId, decided: false };

  const raw = responses?.[approvalInputKey(approvalId)];
  if (raw === undefined) return { again: inputRequired(row, userId as string, params) };
  const answer = parseElicitAnswer(raw);
  if (!answer) {
    throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, `inputResponses["${approvalInputKey(approvalId)}"] is not an elicitation result`);
  }
  const outcome = await applyApprovalAnswer(approvals, row, answer, { id: userId as string });
  if (outcome === 'incomplete' || outcome === 'left') return { again: inputRequired(row, userId as string, params) };
  // 'not_allowed': their role changed since they were asked; the call says it is waiting.
  return { approvalId, decided: outcome === 'approved' || outcome === 'rejected' };
}
