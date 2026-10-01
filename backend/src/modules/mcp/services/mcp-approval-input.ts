/**
 * An approval asked for over MCP (2026-07-28 multi round-trip requests and
 * the Tasks extension), as an `elicitation/create` form, and the answer to
 * it applied through ApprovalsService -- the same decide path the Approvals
 * page uses, so its checks (who may decide, a request decided once, the EE
 * approval policies) hold here too.
 *
 * Only a person who could decide the request in Approvals is asked (owner
 * decision 6, ApprovalsService.canDecide). Everyone else keeps the
 * "waiting for approval" answer, and the decision is made in the dashboard.
 */
import { ApprovalRequest } from '../../../entities/approval-request.entity';
import type { ApprovalsService } from '../../approvals/approvals.service';

/** One `elicitation/create` input request (MRTR `InputRequests` value). */
export interface ElicitInputRequest {
  method: 'elicitation/create';
  params: {
    mode: 'form';
    message: string;
    requestedSchema: {
      type: 'object';
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
  };
}

/** An `ElicitResult` as a client sends it back in `inputResponses`. */
export interface ElicitAnswer {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

const MAX_ARGUMENTS_SHOWN = 2_000;

/** The `inputRequests` key of an approval; unique over a task's lifetime because an approval is decided once. */
export function approvalInputKey(approvalId: string): string {
  return `approval-${approvalId}`;
}

export function approvalIdFromKey(key: string): string | null {
  return key.startsWith('approval-') ? key.slice('approval-'.length) || null : null;
}

/** The form a person sees: what is asked for, by which rule, with which arguments. */
export function approvalInputRequest(row: Pick<ApprovalRequest, 'reason' | 'payload'>): ElicitInputRequest {
  const payload = (row.payload ?? {}) as Record<string, any>;
  const lines = ['A person has to approve this before it runs.', row.reason];
  if (typeof payload.tool === 'string' && payload.tool) lines.push(`Tool: ${payload.tool}`);
  if (payload.parameters && typeof payload.parameters === 'object') {
    let shown = JSON.stringify(payload.parameters, null, 2);
    if (shown.length > MAX_ARGUMENTS_SHOWN) shown = `${shown.slice(0, MAX_ARGUMENTS_SHOWN)}\n...`;
    lines.push(`Arguments:\n${shown}`);
  }
  return {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: lines.filter(Boolean).join('\n\n'),
      requestedSchema: {
        type: 'object',
        properties: {
          decision: {
            type: 'string',
            title: 'Decision',
            oneOf: [
              { const: 'approve', title: 'Approve' },
              { const: 'reject', title: 'Reject' },
            ],
          },
          reason: { type: 'string', title: 'Reason (optional)' },
        },
        required: ['decision'],
      },
    },
  };
}

/** An `inputResponses` value, or null when it is not an ElicitResult. */
export function parseElicitAnswer(value: unknown): ElicitAnswer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = (value as any).action;
  if (action !== 'accept' && action !== 'decline' && action !== 'cancel') return null;
  const content = (value as any).content;
  if (content !== undefined && (content === null || typeof content !== 'object' || Array.isArray(content))) return null;
  return { action, ...(content ? { content } : {}) };
}

/**
 * Apply a person's answer to an approval. "accept" with decision approve
 * approves; "accept" with reject, or "decline", rejects; "cancel" (they
 * closed the form) leaves it pending ('left'). An approval an EE policy
 * still needs other approvers for is 'awaiting_others': this person's
 * approval is recorded, and asking them again would only be refused. A
 * caller that may not decide this request gets 'not_allowed' and nothing
 * changes.
 */
export async function applyApprovalAnswer(
  approvals: Pick<ApprovalsService, 'canDecide' | 'approve' | 'reject'>,
  row: ApprovalRequest,
  answer: ElicitAnswer,
  caller: { id: string },
): Promise<'approved' | 'rejected' | 'awaiting_others' | 'left' | 'not_allowed' | 'incomplete'> {
  if (answer.action === 'cancel') return 'left';
  if (!(await approvals.canDecide(row, caller))) return 'not_allowed';
  const reason = typeof answer.content?.reason === 'string' && answer.content.reason.trim()
    ? String(answer.content.reason).trim().slice(0, 1_000)
    : undefined;
  const decision = answer.action === 'decline' ? 'reject' : answer.content?.decision;
  if (decision !== 'approve' && decision !== 'reject') return 'incomplete';
  const by = { decidedBy: caller.id, decisionReason: reason ?? (answer.action === 'decline' ? 'declined over MCP' : undefined) };
  if (decision === 'approve') {
    const decided = await approvals.approve(row.id, by, caller, row.organizationId);
    // An EE approval policy that needs more approvers keeps it pending.
    return decided.status === 'approved' ? 'approved' : 'awaiting_others';
  }
  await approvals.reject(row.id, by, caller, row.organizationId);
  return 'rejected';
}
